export const DOC_BUDGETS: Record<string, number> = {
  'AGENTS.md': 200,
  'README.md': 220,
  'README.zh.md': 220,
  'CONTRIBUTING.md': 200,
  'CONTRIBUTING.zh.md': 200,
  'CHANGELOG.md': 150,
  'CHANGELOG.zh.md': 150,
  'docs/architecture.md': 450,
  'docs/architecture.zh.md': 450,
  'docs/development.md': 350,
  'docs/development.zh.md': 350,
  'docs/user/cli.md': 450,
  'docs/user/cli.zh.md': 450,
  'docs/user/claude-code.md': 400,
  'docs/user/claude-code.zh.md': 400,
  '.agents/notes/0001-agents-source-tree.md': 220,
  '.agents/notes/0001-agents-source-tree.zh.md': 220,
  '.agents/notes/0002-claude-md-compat-shim.md': 220,
  '.agents/notes/0002-claude-md-compat-shim.zh.md': 220,
  'docs/i18n/terminology.md': 250,
  'docs/i18n/style-guide.md': 250,
};

export const OPTIONAL_BUDGETS = new Set(['docs/AGENTS.md']);
export const OPTIONAL_BUDGET_VALUES: Record<string, number> = {
  'docs/AGENTS.md': 120,
};

export const NOTE_STATUSES = ['proposed', 'implemented', 'rejected'] as const;
export const NOTE_HEADINGS = [
  'Context',
  'Decision',
  'Consequences',
  'Alternatives considered',
  'Verification',
  'References',
] as const;

export const NOTE_FILENAME = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
