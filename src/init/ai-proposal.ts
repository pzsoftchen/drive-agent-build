import { z } from 'zod';
import type { CommandRunner } from '../core/command.ts';
import { ConfigError } from '../core/errors.ts';
import { KEBAB_CASE } from '../model/schemas.ts';
import { renderAgentsMd } from './templates.ts';
import type { ScanResult } from './scanner.ts';

export const AiProposalSchema = z
  .object({
    agentsMdAddition: z.string(),
    agents: z
      .array(
        z
          .object({
            name: z.string().min(1).regex(KEBAB_CASE),
            description: z.string().min(1),
            body: z.string().min(1),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export type AiProposal = z.infer<typeof AiProposalSchema>;
export type AiProposalAgent = AiProposal['agents'][number];

const AI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agentsMdAddition', 'agents'],
  properties: {
    agentsMdAddition: { type: 'string' },
    agents: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'body'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

function parseProposal(value: unknown): AiProposal {
  const parsed = AiProposalSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      `AI proposal is invalid: ${zodMessage(parsed.error)}`,
      'ai.invalid-proposal',
      { details: parsed.error.issues, hint: 'Run dab init --ai again with a clearer task summary.' },
    );
  }

  const reserved = new Set(['implementer', 'reviewer']);
  const names = new Set<string>();
  for (const agent of parsed.data.agents) {
    if (reserved.has(agent.name) || names.has(agent.name)) {
      throw new ConfigError(
        `AI proposal uses a reserved or duplicate agent name: ${agent.name}`,
        'ai.invalid-proposal',
        { hint: 'Proposal agents must be unique and must not replace the built-in roles.' },
      );
    }
    names.add(agent.name);
  }
  return parsed.data;
}

export async function requestAiProposal(
  scan: ScanResult,
  runner: CommandRunner,
  cwd: string,
): Promise<AiProposal> {
  const scanSummary = JSON.stringify({
    projectName: scan.projectName,
    language: scan.language,
    packageManager: scan.packageManager,
    commands: scan.commands,
    sourceDirs: scan.sourceDirs,
    existingAgents: scan.existingAgents,
  }, null, 2);
  const prompt = `You are proposing DAB agent configuration for an existing repository.

Return only JSON matching the required schema. Do not use tools.
Propose at most three project-specific subagents. Each name must be kebab-case and must not be
"implementer" or "reviewer". Each description is one sentence. Each body is the subagent system prompt.
Also propose an English addition to AGENTS.md containing only non-obvious project rules; do not repeat
the scan data.

Repository scan:
${scanSummary}
`;

  let result;
  try {
    result = await runner(
      'claude',
      [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(AI_JSON_SCHEMA),
        '--tools',
        '',
        '--no-session-persistence',
        '--setting-sources',
        'project',
      ],
      { cwd, timeoutMs: 120_000 },
    );
  } catch (error) {
    throw new ConfigError(
      `AI init could not start Claude Code: ${error instanceof Error ? error.message : String(error)}`,
      'ai.failed',
      { hint: 'Install Claude Code >= 2.1.277 or run dab init without --ai.' },
    );
  }

  if (result.exitCode !== 0) {
    throw new ConfigError(
      `AI init failed with exit code ${result.exitCode}`,
      'ai.failed',
      {
        details: result.stderr.trim(),
        hint: 'Check Claude Code authentication and retry, or run dab init without --ai.',
      },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new ConfigError(
      'AI init returned a non-JSON response',
      'ai.invalid-proposal',
      { hint: 'Retry dab init --ai.' },
    );
  }

  let value: unknown = payload;
  if (isRecord(payload) && payload.structured_output !== undefined) {
    value = payload.structured_output;
  } else if (isRecord(payload) && typeof payload.result === 'string') {
    try {
      value = JSON.parse(payload.result);
    } catch {
      throw new ConfigError(
        'AI init returned an invalid proposal payload',
        'ai.invalid-proposal',
        { hint: 'Retry dab init --ai.' },
      );
    }
  } else if (isRecord(payload) && isRecord(payload.result)) {
    value = payload.result;
  }

  return parseProposal(value);
}

export function formatProposal(scan: ScanResult, proposal: AiProposal): string {
  const base = renderAgentsMd(scan).split('\n');
  const next = renderAgentsMd(scan, proposal.agentsMdAddition).split('\n');
  const added = next.slice(base.length);
  const lines = ['AI proposal', '==========='];

  if (proposal.agents.length > 0) {
    lines.push('Agents:');
    for (const agent of proposal.agents) {
      lines.push(`  - ${agent.name}: ${agent.description}`);
    }
  } else {
    lines.push('Agents: none');
  }

  lines.push('AGENTS.md diff:');
  lines.push('--- AGENTS.md');
  lines.push('+++ AGENTS.md');
  for (const line of added) {
    lines.push(`+${line}`);
  }
  return `${lines.join('\n')}\n`;
}
