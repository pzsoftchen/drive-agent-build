import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { minimalSourcePlan } from '../../src/init/adoption.ts';
import {
  documentationPack,
  renderArchitectureMd,
  renderDocsAgentsMd,
} from '../../src/init/practice-docs.ts';
import {
  planAuthoredScaffold,
  type AuthoredScaffoldInput,
  type AuthoredScaffoldPlan,
  type PracticePack,
} from '../../src/init/practice.ts';
import { scanProject, type ScanResult } from '../../src/init/scanner.ts';
import type { ProjectManifest } from '../../src/model/types.ts';
import { makeTempDir } from '../helpers/tmp.ts';

const dirs: string[] = [];
let root: string;
let scan: ScanResult;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Collect actionable TODO placeholders the same way the future detect check
 * does: only line-start `TODO:` outside fenced code blocks count.
 */
function lineStartTodos(markdown: string): string[] {
  const todos: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of markdown.split('\n')) {
    const markerMatch = FENCE.exec(line);
    if (fence === undefined) {
      if (markerMatch !== null) {
        const marker = markerMatch[1] ?? '';
        fence = { marker: marker[0] ?? '', length: marker.length };
        continue;
      }
      if (line.startsWith('TODO:')) {
        todos.push(line);
      }
      continue;
    }
    if (
      markerMatch !== null
      && (markerMatch[1]?.[0] ?? '') === fence.marker
      && (markerMatch[1]?.length ?? 0) >= fence.length
      && line.slice(markerMatch[0].length).trim() === ''
    ) {
      fence = undefined;
    }
  }
  return todos;
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  if (start === -1) {
    return '';
  }
  const rest = markdown.slice(start + heading.length + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function zhManifest(): ProjectManifest {
  return {
    ...minimalSourcePlan(scan, 'project').manifest,
    docs: { language: 'zh' },
  };
}

async function planPack(
  pack: PracticePack,
  overrides: Partial<AuthoredScaffoldInput> = {},
): Promise<AuthoredScaffoldPlan> {
  return planAuthoredScaffold(
    {
      root,
      scope: 'project',
      scan,
      profile: 'generic',
      mode: 'converge',
      version: '0.0.0',
      env: {},
      ...overrides,
    },
    [pack],
  );
}

beforeEach(async () => {
  root = await makeTempDir('dab-practice-docs-');
  dirs.push(root);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'tsconfig.json'), '{}\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'sample-project', scripts: { build: 'tsc -p tsconfig.json' } }),
  );
  scan = await scanProject(root);
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('renderArchitectureMd', () => {
  it('renders English and Chinese single-language templates', () => {
    const en = renderArchitectureMd({ language: 'en', scan });
    const zh = renderArchitectureMd({ language: 'zh', scan });
    expect(en).toContain('# Architecture');
    expect(zh).toContain('# 架构');
    expect(en).toContain('## Project facts');
    expect(en).toContain(`- Language: ${scan.language}`);
    expect(en).toContain('TODO: add a test command');
    expect(en).not.toContain('English | [中文]');
  });

  it('renders scanned facts and line-start TODO placeholders for missing commands', () => {
    const en = renderArchitectureMd({ language: 'en', scan });
    expect(en).toContain(`- Project: ${scan.projectName}`);
    expect(en).toContain(`- Package manager: ${scan.packageManager}`);
    expect(en).toContain(`- Source directories: ${scan.sourceDirs.join(', ')}`);
    expect(en).toContain(`- Build: \`${scan.commands.build}\``);
    const todos = lineStartTodos(en);
    expect(todos).toContain('TODO: add a test command');
    expect(todos).toContain('TODO: add a lint command');
    expect(todos).toContain('TODO: add a typecheck command');
    expect(en).not.toMatch(/^- (Test|Lint|Typecheck):/m);
  });

  it('ignores TODO markers inside fenced code when scanning', () => {
    expect(lineStartTodos('```md\nTODO: inside fence\n```\nTODO: outside')).toEqual([
      'TODO: outside',
    ]);
    const en = renderArchitectureMd({ language: 'en', scan });
    expect(lineStartTodos(en).length).toBeGreaterThan(0);
  });

  it('does not fabricate components, call chains or boundaries', () => {
    const en = renderArchitectureMd({ language: 'en', scan });
    for (const heading of [
      '## System purpose',
      '## Composition',
      '## Runtime flow',
      '## Module boundaries',
      '## Extension points',
      '## Invariants',
    ]) {
      expect(section(en, heading).trim().startsWith('TODO:')).toBe(true);
    }
    for (const invented of ['Controller', 'Service', 'Repository', 'Database', 'Microservice']) {
      expect(en).not.toContain(invented);
    }
  });

  it('states that DAB never overwrites the skeleton in both languages', () => {
    expect(renderArchitectureMd({ language: 'en', scan })).toContain('DAB never overwrites');
    expect(renderArchitectureMd({ language: 'zh', scan })).toContain('DAB 不会覆盖');
  });

  it('lists every scanned source directory in the top-level layout', () => {
    const en = renderArchitectureMd({ language: 'en', scan });
    for (const dir of scan.sourceDirs) {
      expect(en).toContain(`\`${dir}/\``);
    }
  });

  it('marks an undetected source layout with a line-start TODO', () => {
    const empty = {
      ...scan,
      sourceDirs: [],
      commands: {},
    };
    const en = renderArchitectureMd({ language: 'en', scan: empty });
    expect(lineStartTodos(en)).toContain('TODO: Record the top-level layout.');
    expect(lineStartTodos(en)).toContain('TODO: add a test command');
    expect(en).toContain('- Source directories: not detected');
  });
});

describe('renderDocsAgentsMd', () => {
  it('links architecture only when it exists or is planned', () => {
    const withArchitecture = renderDocsAgentsMd({
      language: 'en',
      scan,
      anchors: new Set(['docs/architecture.md']),
    });
    expect(withArchitecture).toContain('[architecture](architecture.md)');
    const without = renderDocsAgentsMd({ language: 'en', scan, anchors: new Set() });
    expect(without).not.toContain('[architecture](architecture.md)');
  });

  it('links the root AGENTS.md only when it is anchored', () => {
    const withRoot = renderDocsAgentsMd({
      language: 'en',
      scan,
      anchors: new Set(['AGENTS.md']),
    });
    expect(withRoot).toContain('[AGENTS.md](../AGENTS.md)');
    const without = renderDocsAgentsMd({ language: 'en', scan, anchors: new Set() });
    expect(without).not.toContain('](../AGENTS.md)');
  });

  it('mentions notes as inline code, never as a directory link', () => {
    const en = renderDocsAgentsMd({
      language: 'en',
      scan,
      anchors: new Set(['AGENTS.md', 'docs/architecture.md']),
    });
    expect(en).toContain('`.agents/notes/`');
    expect(en).not.toContain('](.agents/notes');
  });

  it('covers structure, placement, writing rules, slop and verification', () => {
    const en = renderDocsAgentsMd({ language: 'en', scan, anchors: new Set() });
    for (const heading of [
      '## Document structure',
      '## Placement',
      '## Writing rules',
      '## Slop checklist',
      '## Verification',
    ]) {
      expect(en).toContain(heading);
    }
    expect(en).toContain('dab-doc-writing');
    expect(en).toContain('dab-architecture-writing');
    expect(en).toContain('dab detect');
    expect(lineStartTodos(en).length).toBeGreaterThan(0);
  });

  it('renders a Chinese guide without pairing links or records', () => {
    const zh = renderDocsAgentsMd({ language: 'zh', scan, anchors: new Set() });
    expect(zh).toContain('# 文档规范');
    expect(zh).not.toContain('English | [中文]');
    expect(zh).not.toContain('.zh.md');
    expect(zh).not.toContain('.i18n.yaml');
  });
});

describe('documentationPack', () => {
  it('does not generate pairs or i18n records', async () => {
    const plan = await planPack(documentationPack, { mode: 'converge' });
    expect(Object.keys(plan.files).sort()).toEqual(['docs/AGENTS.md', 'docs/architecture.md']);
    expect(plan.files).not.toHaveProperty('docs/AGENTS.zh.md');
    expect(plan.files).not.toHaveProperty('docs/AGENTS.i18n.yaml');
  });

  it('policy-skips both docs when the bilingual rule exists', async () => {
    await mkdir(join(root, '.agents/rules'), { recursive: true });
    await writeFile(join(root, '.agents/rules/docs-bilingual.md'), 'paired docs');
    const plan = await planPack(documentationPack, { mode: 'converge' });
    expect(plan.files).toEqual({});
    expect(plan.policySkipped.sort()).toEqual(['docs/AGENTS.md', 'docs/architecture.md']);
  });

  it('renders both docs in the resolved single language', async () => {
    const plan = await planPack(documentationPack, { manifest: zhManifest() });
    expect(plan.docsLanguage).toEqual({ value: 'zh', source: 'config' });
    expect(plan.files['docs/AGENTS.md']).toContain('# 文档规范');
    expect(plan.files['docs/architecture.md']).toContain('# 架构');
    expect(Object.keys(plan.files).some((file) => file.endsWith('.zh.md'))).toBe(false);
  });

  it('skips existing docs without reading, rewriting or unlinking them', async () => {
    await mkdir(join(root, 'docs'), { recursive: true });
    const authored = '# Authored architecture\n\nOwned by the project.\n';
    await writeFile(join(root, 'docs/architecture.md'), authored);

    const plan = await planPack(documentationPack, { mode: 'converge' });

    expect(plan.skipped).toEqual(['docs/architecture.md']);
    expect(Object.keys(plan.files)).toEqual(['docs/AGENTS.md']);
    expect(plan.files['docs/AGENTS.md']).toContain('[architecture](architecture.md)');
    await expect(readFile(join(root, 'docs/architecture.md'), 'utf8')).resolves.toBe(authored);
  });

  it('plans nothing for global scope', async () => {
    const plan = await planPack(documentationPack, { scope: 'global', mode: 'full' });
    expect(plan.files).toEqual({});
    expect(plan.policySkipped).toEqual([]);
    expect(plan.directories).toEqual([]);
  });

  it('never plans the root AGENTS.md', async () => {
    const plan = await planPack(documentationPack, { mode: 'full' });
    expect(plan.files).not.toHaveProperty('AGENTS.md');
    expect(Object.keys(plan.files).sort()).toEqual(['docs/AGENTS.md', 'docs/architecture.md']);
  });
});
