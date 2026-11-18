import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();

describe('DAB narrative', () => {
  it('ships a phased roadmap in both languages', async () => {
    const roadmap = await readFile(join(root, 'docs/roadmap.md'), 'utf8');
    for (const phase of ['v0.1', 'v0.1.x', 'v0.2', 'v0.3']) {
      expect(roadmap).toContain(phase);
    }
    expect(roadmap).not.toContain('v0.4');
    expect(await readFile(join(root, 'docs/roadmap.zh.md'), 'utf8')).toContain('# 路线图');
    expect(await readFile(join(root, 'docs/roadmap.i18n.yaml'), 'utf8')).toContain('version: 1');
  });

  it('removes the v0.1 eval overclaim and states the limits', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('## What DAB does not guarantee');
    expect(readme).not.toContain('evaluates the result with evidence');
    expect(readme.toLowerCase()).toContain('not a sandbox');
    expect(readme).toContain(
      'does not yet run its own delivery loop, compare configurations or promote memory automatically',
    );
    expect(readme).toContain('a GUI, a plugin marketplace');
  });

  it('states the policy guardrail in architecture and the Claude Code guide', async () => {
    const architecture = await readFile(join(root, 'docs/architecture.md'), 'utf8');
    const claudeCode = await readFile(join(root, 'docs/user/claude-code.md'), 'utf8');
    expect(architecture.toLowerCase()).toContain('not a sandbox');
    expect(claudeCode.toLowerCase()).toContain('can bypass');
  });
});
