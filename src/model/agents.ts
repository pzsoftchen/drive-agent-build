import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { compareStrings } from '../core/compare.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readTextFile } from '../core/fs-atomic.ts';
import { toPosix } from '../core/paths.ts';
import { DiagnosticCodes } from './diagnostics-codes.ts';
import { parseFrontmatter, unknownFrontmatterDiagnostic } from './frontmatter.ts';
import { AgentFrontmatterSchema, CLAUDE_HOOK_EVENTS, KEBAB_CASE } from './schemas.ts';
import type {
  AgentDefinition,
  AgentHookDefinition,
  AgentToolsSpec,
  DiscoveryResult,
} from './types.ts';

const AGENT_FRONTMATTER_FIELDS = Object.keys(AgentFrontmatterSchema.shape);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeToolList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : value.split(',');
  return values.map((item) => item.trim()).filter((item) => item.length > 0);
}

function invalidToolToken(token: string): boolean {
  return /\s/.test(token) && !/^[A-Za-z][A-Za-z0-9_:-]*\([^)]*\)$/.test(token);
}

function invalidToolTokenDiagnostic(
  agentName: string,
  field: 'tools' | 'disallowedTools',
  tokens: readonly string[],
  file: string,
): Diagnostic {
  return {
    code: DiagnosticCodes.agentToolsInvalid,
    severity: 'error',
    message: `agent ${agentName} has invalid ${field} token(s): ${tokens.join(', ')}`,
    file,
    line: 1,
    hint: 'Use comma-separated tool names; use * only as a standalone tools value.',
  };
}

function parseToolsSpec(
  raw: string | string[] | undefined,
  agentName: string,
  file: string,
): { spec: AgentToolsSpec; diagnostics: Diagnostic[] } {
  if (raw === undefined) {
    return { spec: { mode: 'all', explicit: false }, diagnostics: [] };
  }
  const values = normalizeToolList(raw);
  const invalid = values.filter(invalidToolToken);
  if (invalid.length > 0) {
    return {
      spec: { mode: 'none' },
      diagnostics: [invalidToolTokenDiagnostic(agentName, 'tools', invalid, file)],
    };
  }
  if (values.length === 0) {
    return {
      spec: { mode: 'none' },
      diagnostics: [{
        code: DiagnosticCodes.agentToolsEmpty,
        severity: 'warning',
        message: `agent ${agentName} declares an empty tools list; treating it as no tools`,
        file,
        line: 1,
        hint: 'Omit tools to inherit all tools, or list explicit tool names.',
      }],
    };
  }
  if (values.includes('*')) {
    if (values.length === 1) {
      return { spec: { mode: 'all', explicit: true }, diagnostics: [] };
    }
    return {
      spec: { mode: 'none' },
      diagnostics: [{
        code: DiagnosticCodes.agentToolsInvalid,
        severity: 'error',
        message: `agent ${agentName} mixes * with explicit tools`,
        file,
        line: 1,
        hint: 'Use "*" alone for all tools, or list explicit tool names.',
      }],
    };
  }
  return {
    spec: { mode: 'list', tools: values },
    diagnostics: [],
  };
}

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

function validateAgentHooks(
  raw: unknown,
  agentName: string,
  file: string,
): { items: AgentHookDefinition[]; diagnostics: Diagnostic[] } {
  const items: AgentHookDefinition[] = [];
  const diagnostics: Diagnostic[] = [];
  if (raw === undefined) {
    return { items, diagnostics };
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: DiagnosticCodes.agentHookHandler,
      severity: 'error',
      message: `agent ${agentName} hooks must be an event map`,
      file,
    });
    return { items, diagnostics };
  }

  const ids = new Set<string>();
  for (const [event, matchers] of Object.entries(raw)) {
    if (!CLAUDE_HOOK_EVENTS.includes(event as (typeof CLAUDE_HOOK_EVENTS)[number])) {
      diagnostics.push({
        code: DiagnosticCodes.agentHookEvent,
        severity: 'error',
        message: `agent ${agentName} uses unknown hook event ${event}`,
        file,
      });
      continue;
    }
    if (!Array.isArray(matchers)) {
      diagnostics.push({
        code: DiagnosticCodes.agentHookHandler,
        severity: 'error',
        message: `agent ${agentName} hook event ${event} must be an array`,
        file,
      });
      continue;
    }

    matchers.forEach((matcher, matcherIndex) => {
      if (!isRecord(matcher)) {
        diagnostics.push({
          code: DiagnosticCodes.agentHookHandler,
          severity: 'error',
          message: `agent ${agentName} hook matcher for ${event} must be an object`,
          file,
        });
        return;
      }
      const matcherValue = typeof matcher.matcher === 'string' ? matcher.matcher : undefined;
      const handlers = matcher.hooks;
      if (!Array.isArray(handlers)) {
        diagnostics.push({
          code: DiagnosticCodes.agentHookHandler,
          severity: 'error',
          message: `agent ${agentName} hook matcher for ${event} needs a hooks array`,
          file,
        });
        return;
      }
      handlers.forEach((handler, handlerIndex) => {
        if (!isRecord(handler) || handler.type !== 'command' || typeof handler.command !== 'string'
          || handler.command.trim().length === 0) {
          diagnostics.push({
            code: DiagnosticCodes.agentHookHandler,
            severity: 'error',
            message: `agent ${agentName} only supports command hooks for ${event}`,
            file,
          });
          return;
        }
        const explicitId = typeof handler.id === 'string' ? handler.id : undefined;
        const id = explicitId
          ?? `agent-${agentName}-${event.toLowerCase()}-${matcherIndex}-${handlerIndex}`;
        if (!KEBAB_CASE.test(id)) {
          diagnostics.push({
            code: DiagnosticCodes.hookInvalid,
            severity: 'error',
            message: `agent ${agentName} hook id is not kebab-case: ${id}`,
            file,
          });
          return;
        }
        if (ids.has(id)) {
          diagnostics.push({
            code: DiagnosticCodes.hookDuplicateId,
            severity: 'error',
            message: `agent ${agentName} reuses hook id ${id}`,
            file,
          });
          return;
        }
        ids.add(id);
        items.push({
          id,
          event,
          ...(matcherValue === undefined ? {} : { matcher: matcherValue }),
          command: handler.command,
          ...(typeof handler.timeout === 'number' ? { timeout: handler.timeout } : {}),
          source: file,
        });
      });
    });
  }

  return { items, diagnostics };
}

export interface AgentSourceResult {
  item?: AgentDefinition;
  diagnostics: Diagnostic[];
}

async function parseAgentSource(root: string, absolute: string): Promise<AgentSourceResult> {
  const file = toPosix(relative(root, absolute));
  const diagnostics: Diagnostic[] = [];

  let parsed;
  try {
    parsed = parseFrontmatter(await readTextFile(absolute), file);
  } catch (error) {
    diagnostics.push({
      code: DiagnosticCodes.agentInvalidFrontmatter,
      severity: 'error',
      message: `invalid agent frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      file,
      line: 1,
    });
    return { diagnostics };
  }

  if (Object.keys(parsed.data).length === 0) {
    diagnostics.push({
      code: DiagnosticCodes.agentInvalidFrontmatter,
      severity: 'error',
      message: 'agent file is missing YAML frontmatter',
      file,
      line: 1,
    });
    return { diagnostics };
  }

  const validated = AgentFrontmatterSchema.safeParse(parsed.data);
  if (!validated.success) {
    diagnostics.push({
      code: DiagnosticCodes.agentInvalidFrontmatter,
      severity: 'error',
      message: `invalid agent frontmatter: ${zodMessage(validated.error)}`,
      file,
      line: 1,
    });
    return { diagnostics };
  }

  const data = validated.data;
  const unknown = unknownFrontmatterDiagnostic(
    'agent',
    data.name,
    AGENT_FRONTMATTER_FIELDS,
    parsed.data,
    file,
  );
  if (unknown !== undefined) {
    diagnostics.push(unknown);
  }
  if (data.memory === 'project') {
    diagnostics.push({
      code: DiagnosticCodes.agentMemoryProject,
      severity: 'error',
      message: `agent ${data.name} uses memory: project, which creates a second team memory store`,
      file,
      line: 1,
      hint: 'Use memory: user or memory: local, and put shared knowledge in .agents/memory/.',
    });
  }
  if (data.permissionMode === 'auto' || data.permissionMode === 'bypassPermissions') {
    diagnostics.push({
      code: DiagnosticCodes.agentPermissionMode,
      severity: 'error',
      message: `agent ${data.name} uses unsupported permissionMode: ${data.permissionMode}`,
      file,
      line: 1,
      hint: 'v0.1 allows default, manual, plan, acceptEdits and dontAsk for role definitions.',
    });
  }

  const hooks = validateAgentHooks(data.hooks, data.name, file);
  diagnostics.push(...hooks.diagnostics);
  const tools = parseToolsSpec(data.tools, data.name, file);
  diagnostics.push(...tools.diagnostics);
  const toolsList = tools.spec.mode === 'list' ? tools.spec.tools : [];
  const disallowedTools = normalizeToolList(data.disallowedTools);
  const invalidDisallowed = disallowedTools.filter(invalidToolToken);
  if (invalidDisallowed.length > 0) {
    diagnostics.push(
      invalidToolTokenDiagnostic(data.name, 'disallowedTools', invalidDisallowed, file),
    );
  }
  return {
    item: {
      file,
      name: data.name,
      description: data.description,
      tools: toolsList,
      toolsSpec: tools.spec,
      disallowedTools,
      ...(data.model === undefined ? {} : { model: data.model }),
      ...(data.permissionMode === undefined ? {} : { permissionMode: data.permissionMode }),
      ...(data.memory === undefined ? {} : { memory: data.memory }),
      hooks: hooks.items,
      body: parsed.body,
      frontmatter: data,
    },
    diagnostics,
  };
}

/**
 * Validate one agent file for adoption. Returns an item only when the source has
 * no error diagnostics; warnings (such as unknown frontmatter) are preserved.
 */
export async function validateAgentSource(
  root: string,
  file: string,
): Promise<AgentSourceResult> {
  const result = await parseAgentSource(root, file);
  if (result.diagnostics.some((item) => item.severity === 'error')) {
    return { diagnostics: result.diagnostics };
  }
  return result;
}

export async function discoverAgents(
  root: string,
  agentsDir: string,
): Promise<DiscoveryResult<AgentDefinition>> {
  const sourceDir = join(agentsDir, 'agents');
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { items: [], diagnostics: [] };
    }
    throw error;
  }

  const items: AgentDefinition[] = [];
  const diagnostics: Diagnostic[] = [];
  const names = new Map<string, string>();

  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    if (!entry.name.endsWith('.md')) {
      continue;
    }
    const absolute = join(sourceDir, entry.name);
    const file = toPosix(relative(root, absolute));
    if (entry.isSymbolicLink()) {
      diagnostics.push({
        code: DiagnosticCodes.agentSymlink,
        severity: 'warning',
        message: `agent file is a symlink and was skipped: ${file}`,
        file,
      });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const source = await parseAgentSource(root, absolute);
    diagnostics.push(...source.diagnostics);
    if (source.item === undefined) {
      continue;
    }
    const existing = names.get(source.item.name);
    if (existing !== undefined) {
      diagnostics.push({
        code: DiagnosticCodes.agentDuplicateName,
        severity: 'error',
        message: `duplicate agent name ${source.item.name}`,
        file: source.item.file,
        hint: `The name is already used by ${existing}.`,
      });
    } else {
      names.set(source.item.name, source.item.file);
    }
    items.push(source.item);
  }

  return { items, diagnostics };
}
