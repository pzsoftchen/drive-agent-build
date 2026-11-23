import { stringify } from 'yaml';
import type { ScanResult } from './scanner.ts';
import type { AiProposalAgent } from './ai-proposal.ts';
import type { Scope } from '../model/scope.ts';

function commandOrTodo(command: string | undefined): string {
  return command ?? 'TODO: add a command';
}

export function renderAgentsMd(scan: ScanResult, added?: string): string {
  const sources = scan.sourceDirs.length === 0 ? 'not detected' : scan.sourceDirs.join(', ');
  const addition = added === undefined || added.trim().length === 0
    ? ''
    : `\n${added.trim()}\n`;
  return `# ${scan.projectName}

## Project map

- Language: ${scan.language}
- Package manager: ${scan.packageManager}
- Source directories: ${sources}
- Authored agent configuration: \`.agents/\`
- Generated Claude Code configuration: \`.claude/\`

## Commands

- Test: \`${commandOrTodo(scan.commands.test)}\`
- Build: \`${commandOrTodo(scan.commands.build)}\`
- Lint: \`${commandOrTodo(scan.commands.lint)}\`
- Typecheck: \`${commandOrTodo(scan.commands.typecheck)}\`

## DAB rules

- \`AGENTS.md\` and \`.agents/\` are the only authored agent configuration.
- \`.claude/\` is generated. Do not edit it by hand; run \`dab normalize\`.
- Use the \`feature-delivery\` skill for scoped feature work.
- Shared team memory lives in \`.agents/memory/\`; personal auto memory stays machine-local.
- Read \`.agents/rules/testing.md\` and \`.agents/rules/generated-files.md\` before changing those areas.

## Working agreement

1. Read the relevant skill before starting.
2. Write a failing test before implementation.
3. Run the test command above and report the exact result.
4. Run \`dab detect\` before handing off configuration changes.
5. Update project documentation when a user-facing behavior changes.
${addition}`;
}

export function renderImplementerAgent(): string {
  return `---
name: implementer
description: Implements one scoped feature task with tests and verification.
tools: Read, Grep, Glob, Edit, Write, Bash
---
You implement one scoped task at a time.

- Read the task and the relevant skill before changing files.
- Write a failing test before production code, then make it pass.
- Keep changes inside the requested scope.
- Run the project test command and report the exact result.
- Update project documentation when behavior changes.
`;
}

export function renderReviewerAgent(): string {
  return `---
name: reviewer
description: Reviews a change for correctness, missing tests and unauthorized scope.
tools: Read, Grep, Glob, Bash
disallowedTools: Edit, Write, NotebookEdit
permissionMode: plan
---
You review a change without editing it.

- Check correctness, failure handling and test coverage.
- Check for changes outside the requested scope.
- Run the relevant tests when needed.
- Report findings by severity with concrete file and line references.
- Do not approve a change whose tests were not run.
`;
}

export function renderFeatureDeliverySkill(scan: ScanResult): string {
  return `---
name: feature-delivery
description: Delivers one scoped feature with failing tests, implementation, docs and verification.
---
# Feature delivery

1. Read \`AGENTS.md\` and the task input.
2. Locate the smallest relevant module and test file.
3. Write a failing test that expresses the required behavior.
4. Run \`${commandOrTodo(scan.commands.test)}\` and confirm the new test fails for the expected reason.
5. Implement the smallest change that makes the test pass.
6. Run \`${commandOrTodo(scan.commands.test)}\` again and report the exact result.
7. Update documentation when the behavior is user-facing.
8. Summarize changed files, tests and any remaining risk.
`;
}

export function renderDocSyncSkill(): string {
  return `---
name: doc-sync
description: Updates project documentation and runs the documentation gates.
---
# Documentation sync

1. Identify the documentation affected by the change.
2. Update the affected documentation in the same change.
3. Keep headings, lists, tables, code blocks and inline code structurally identical.
4. Run the repository's documentation gate and fix every failure.
`;
}

export function renderGeneratedFilesRule(): string {
  return `---
paths: [".claude/**"]
---
Generated files under \`.claude/\` are owned by DAB.

- Do not edit them by hand.
- Change \`AGENTS.md\` or \`.agents/\` and run \`dab normalize\`.
- Use \`dab detect\` to inspect drift.
`;
}

export function renderTestingRule(): string {
  return `---
paths: ["src/**", "test/**", "tests/**"]
---
Write a failing test before production code.

- The test must fail for the expected reason before the implementation exists.
- Run the project test command after the change.
- Do not weaken a test to make an unrelated failure disappear.
`;
}

export function renderProjectPolicy(): string {
  return `version: 1
defaultMode: default
read:
  deny:
    - .env
    - .env.*
    - secrets/**
write:
  deny:
    - .claude/settings.json
    - .claude/settings.local.json
    - .claude/CLAUDE.md
    - .claude/agents/**
    - .claude/skills/**
    - .claude/rules/**
execute:
  deny:
    - sudo
    - rm -rf /
  ask:
    - git push
    - npm publish
capabilities:
  deny: []
`;
}

export function renderClaudeCodePolicy(): string {
  return `version: 1
provider: claude-code
permissions:
  allow: []
  ask: []
  deny:
    - Bash(git reset --hard:*)
    - Bash(git clean -fdx:*)
`;
}

export function renderHookMetadata(): string {
  return `id: protect-generated
event: pre_tool
matcher: Edit|Write|MultiEdit
entry: run.mjs
runner: node
timeout: 10
order: 10
`;
}

export function renderHookScript(): string {
  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const candidate = input?.tool_input?.file_path ?? input?.tool_input?.path;
if (typeof candidate !== 'string') {
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rel = relative(root, resolve(root, candidate)).split('\\\\').join('/');
if (/^\\.claude\\/(settings\\.json|CLAUDE\\.md|agents\\/|skills\\/|rules\\/)/.test(rel)) {
  process.stderr.write('DAB: .claude/ is generated. Edit .agents/ and run dab normalize.\\n');
  process.exit(2);
}
process.exit(0);
`;
}

export function renderMemoryIndex(): string {
  return `# Shared memory

Reviewed, durable team facts live here. Every entry needs frontmatter:

\`\`\`yaml
title: Short title
source: https://example.com/reviewed-source
review_by: 2027-01-01
updated: 2026-11-16
status: active
\`\`\`

Link every entry from this index. Personal auto memory stays machine-local.
`;
}

export function renderDabYaml(
  scan: ScanResult,
  scope: Scope,
  options: { profile?: 'generic' | 'feature'; docsLanguage?: 'auto' | 'en' | 'zh' } = {},
): string {
  const profile = options.profile ?? 'generic';
  const docsLanguage = options.docsLanguage ?? 'auto';
  return `version: 2
scope: ${scope}
project:
  id: ${JSON.stringify(scan.projectId)}
  name: ${JSON.stringify(scan.projectName)}
profile: ${profile}
docs:
  language: ${docsLanguage}
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
`;
}

export function renderAgentFromProposal(agent: AiProposalAgent): string {
  const frontmatter = stringify({
    name: agent.name,
    description: agent.description,
  }).trimEnd();
  return `---
${frontmatter}
---
${agent.body.trim()}
`;
}

export function templateFiles(
  scan: ScanResult,
  scope: Scope,
  aiAddition?: string,
  options: { profile?: 'generic' | 'feature' } = {},
): Record<string, string> {
  const agentsMd = scope === 'global' ? '.agents/AGENTS.md' : 'AGENTS.md';
  const manifest = scope === 'global' ? '.agents/dab.yaml' : 'dab.yaml';
  return {
    [agentsMd]: renderAgentsMd(scan, aiAddition),
    [manifest]: renderDabYaml(scan, scope, { profile: options.profile ?? 'generic' }),
    '.agents/agents/implementer.md': renderImplementerAgent(),
    '.agents/agents/reviewer.md': renderReviewerAgent(),
    '.agents/skills/feature-delivery/SKILL.md': renderFeatureDeliverySkill(scan),
    '.agents/skills/doc-sync/SKILL.md': renderDocSyncSkill(),
    '.agents/rules/generated-files.md': renderGeneratedFilesRule(),
    '.agents/rules/testing.md': renderTestingRule(),
    '.agents/policies/project.yaml': renderProjectPolicy(),
    '.agents/adapters/claude-code.yaml': renderClaudeCodePolicy(),
    '.agents/hooks/protect-generated/hook.yaml': renderHookMetadata(),
    '.agents/hooks/protect-generated/run.mjs': renderHookScript(),
    '.agents/memory/INDEX.md': renderMemoryIndex(),
  };
}

export const TEMPLATE_PROJECTIONS = [
  {
    source: '.agents/agents/implementer.md',
    target: '.claude/agents/implementer.md',
  },
  {
    source: '.agents/agents/reviewer.md',
    target: '.claude/agents/reviewer.md',
  },
  {
    source: '.agents/skills/feature-delivery',
    target: '.claude/skills/feature-delivery',
  },
  {
    source: '.agents/skills/doc-sync',
    target: '.claude/skills/doc-sync',
  },
  {
    source: '.agents/rules/generated-files.md',
    target: '.claude/rules/generated-files.md',
  },
  {
    source: '.agents/rules/testing.md',
    target: '.claude/rules/testing.md',
  },
] as const;
