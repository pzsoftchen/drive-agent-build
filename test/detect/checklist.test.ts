import { describe, expect, it } from 'vitest';
import {
  buildChecklist,
  formatChecklist,
  type ChecklistEntry,
} from '../../src/detect/checklist.ts';

describe('buildChecklist', () => {
  it('scores OK entries over total and formats sections', () => {
    const checklist = buildChecklist({ scope: 'project', root: '/tmp/p', phase: 'uninitialized', entries: [
      { group: 'Instructions', label: 'AGENTS.md', status: 'missing' },
      { group: 'Agents', label: '.agents/agents/', status: 'missing' },
      { group: 'Agents', label: '.claude/agents/', status: 'importable', file: '.claude/agents/reviewer.md' },
    ] });
    expect(checklist.score).toEqual({ ok: 0, total: 3, percent: 0 });
    expect(formatChecklist(checklist)).toContain('[MISSING] AGENTS.md');
    expect(formatChecklist(checklist)).toContain('[IMPORTABLE] .claude/agents/');
  });

  it('renders Scope/Root/Profile and next actions', () => {
    const checklist = buildChecklist({ scope: 'global', root: '/home/u', phase: 'initialized', profile: 'feature', entries: [{ group: 'Agents', label: 'reviewer', status: 'ok' }] });
    const text = formatChecklist(checklist);
    expect(text).toContain('Scope: global');
    expect(text).toContain('Root: /home/u');
    expect(text).toContain('Profile: feature');
    expect(text).toContain('score: 1/1 (100%)');
  });

  it('counts only OK entries and rounds the percentage', () => {
    const checklist = buildChecklist({
      scope: 'project',
      root: '/tmp/p',
      phase: 'partial',
      entries: [
        { group: 'Agents', label: 'a', status: 'ok' },
        { group: 'Agents', label: 'b', status: 'ok' },
        { group: 'Agents', label: 'c', status: 'warn' },
        { group: 'Agents', label: 'd', status: 'missing' },
        { group: 'Agents', label: 'e', status: 'error' },
        { group: 'Agents', label: 'f', status: 'importable' },
      ],
    });
    expect(checklist.score).toEqual({ ok: 2, total: 6, percent: 33 });
  });

  it('orders groups canonically and preserves entry order inside a group', () => {
    const entries: ChecklistEntry[] = [
      { group: 'Skills', label: 'skill-b', status: 'ok' },
      { group: 'Agents', label: 'agent-a', status: 'ok' },
      { group: 'Skills', label: 'skill-a', status: 'ok' },
      { group: 'Instructions', label: 'AGENTS.md', status: 'ok' },
      { group: 'Documentation', label: 'docs/AGENTS.md', status: 'ok' },
      { group: 'Generated target', label: '.claude', status: 'ok' },
    ];
    const checklist = buildChecklist({
      scope: 'project',
      root: '/tmp/p',
      phase: 'initialized',
      entries,
    });

    expect(checklist.entries.map((entry) => entry.label)).toEqual([
      'AGENTS.md',
      'docs/AGENTS.md',
      'agent-a',
      'skill-b',
      'skill-a',
      '.claude',
    ]);
    expect(entries.map((entry) => entry.label)).toEqual([
      'skill-b',
      'agent-a',
      'skill-a',
      'AGENTS.md',
      'docs/AGENTS.md',
      '.claude',
    ]);
  });

  it('collects distinct next actions from non-OK entries only', () => {
    const checklist = buildChecklist({
      scope: 'project',
      root: '/tmp/p',
      phase: 'partial',
      entries: [
        { group: 'Instructions', label: 'AGENTS.md', status: 'missing', next: 'dab normalize' },
        { group: 'Agents', label: '.claude/agents/', status: 'importable', next: 'dab normalize --dry-run' },
        { group: 'Agents', label: '.agents/agents/', status: 'ok', next: 'not an action' },
        { group: 'Skills', label: '.agents/skills/', status: 'missing', next: 'dab normalize' },
      ],
    });
    expect(checklist.nextActions).toEqual(['dab normalize', 'dab normalize --dry-run']);
  });

  it('collapses identical rows and keeps distinct rows with the same label', () => {
    const checklist = buildChecklist({
      scope: 'project',
      root: '/tmp/p',
      phase: 'initialized',
      entries: [
        {
          group: 'Skills',
          label: '.agents/skills/broken/SKILL.md',
          status: 'error',
          detail: 'invalid skill frontmatter: broken',
        },
        {
          group: 'Skills',
          label: '.agents/skills/broken/SKILL.md',
          status: 'error',
          detail: 'invalid skill frontmatter: broken',
        },
        {
          group: 'Skills',
          label: '.agents/skills/broken/SKILL.md',
          status: 'error',
          detail: 'different detail',
        },
        {
          group: 'Skills',
          label: '.agents/skills/broken/SKILL.md',
          status: 'error',
          detail: 'invalid skill frontmatter: broken',
          file: '.agents/skills/broken/SKILL.md',
        },
      ],
    });

    expect(checklist.entries).toHaveLength(3);
    expect(checklist.score).toEqual({ ok: 0, total: 3, percent: 0 });
  });

  it('scores an empty checklist as zero percent', () => {
    const checklist = buildChecklist({
      scope: 'project',
      root: '/tmp/p',
      phase: 'uninitialized',
      entries: [],
    });
    expect(checklist.score).toEqual({ ok: 0, total: 0, percent: 0 });
    expect(formatChecklist(checklist)).toContain('score: 0/0 (0%)');
  });
});

describe('formatChecklist', () => {
  it('renders entry details, files, next steps and omits an absent profile', () => {
    const checklist = buildChecklist({
      scope: 'project',
      root: '/repo',
      phase: 'partial',
      entries: [{
        group: 'Skills',
        label: 'pdf-tools',
        status: 'importable',
        detail: '1 entry',
        file: '.claude/skills/pdf-tools/SKILL.md',
        next: 'dab normalize --dry-run',
      }],
    });

    const text = formatChecklist(checklist);
    expect(text).toContain(
      '[IMPORTABLE] pdf-tools (1 entry) [.claude/skills/pdf-tools/SKILL.md] -> dab normalize --dry-run',
    );
    expect(text).toContain('\nSkills\n');
    expect(text).not.toContain('Profile:');
    expect(text).toContain('next: dab normalize --dry-run');
  });
});
