# DAB Practice Layer 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DAB 从配置治理扩展到可执行的实践层：`generic` 默认 profile、单语 documentation pack、authoring skills、共享 authored scaffold planner，以及 `init`/`normalize`/`detect` 的一致接入。

**Architecture:** 新增 `src/init/practice.ts` 作为唯一 authored 文件规划入口，用 pack 的 `targets()` + `files()` 两阶段解析 anchors；documentation/authoring 两个 pack 分别提供单语 docs 和 `dab-*` skills。`init` 用 full 模式，`normalize` 用 adoption/converge 模式，`detect` 复用同一套 pack 定义做只读检查。所有写入只补缺失、绝不覆盖；`docs.language` 和现有 bilingual 规则都显式处理。

**Tech Stack:** TypeScript ESM、Node `>=24.9`、pnpm、Vitest、zod、yaml；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-23-practice-layer-design.md`

**Gap register:** `docs/superpowers/specs/2026-11-23-practice-layer-gap-register.md`

## Global Constraints

- `AGENTS.md` 和 `.agents/` 是唯一 authored source；永不手改 `.claude/`。
- Node `>=24.9`，TypeScript ESM，public `dab` 命令保持稳定；不新增命令。
- 只写缺失文件；不覆盖、不删除、不备份 authored docs/skills；`--fix` 不处理 authored practice 文件。
- 失败要 loud：非法 profile/language、路径类型不符、symlink 逃逸都必须报错并阻止写入。
- `docs.language` 支持 `auto`、`en`、`zh`；默认 `auto`，结果在人类输出和 JSON 中报告 `{ value, source }`。
- generic 只生成单语 docs；不生成 `.zh.md`、`.i18n.yaml` 或翻译；bilingual 是后续可选 pack。
- generic full 不再生成 `.agents/rules/docs-bilingual.md`；已有规则保留，且触发 docs policy skip。
- practice packs 只在 project scope 生效；global scope 不生成 docs/authoring skills。
- JSON additive，`schemaVersion` 保持 1；不改变既有字段语义。
- `normalize` 不调用 LLM、不执行 agent；`--ai` 只提供草稿/提案。
- 现有 v2 manifest 可读；`feature` 保留为兼容别名，有效行为等同 `generic`。
- 英文和中文产品文档成对更新；`docs/superpowers/` 保持中文单语。先写失败测试，再实现；最后跑 `pnpm test`、`pnpm typecheck`、`pnpm doc-sync`。

## Review Focus

- `docs.language` 检测的优先级、只读例外、阈值和 `{ value, source }` 输出是否一致。
- 两阶段 anchors 是否覆盖“同一次 plan 新建的 docs/skills”，policy-skipped 路径是否被排除。
- bilingual 规则存在时：docs policy skip，但 authoring skills/target 写入不被误阻断；`--strict` 不被 policy warning 触发。
- `init --ai` 的 proposals 是否仍能通过 planner 进入 core 渲染。
- `practices` JSON 在 project/global、真实运行/dry-run/blocked 下的 shape 是否一致。
- 旧测试中 `profile: feature` 和 `docs-bilingual` 断言是否有意更新，而不是被弱化。

---

### Task 1: Profile 与 docs.language 基础

**Files:**
- Modify: `src/model/schemas.ts`
- Modify: `src/model/project-manifest.ts`
- Modify: `src/init/templates.ts`
- Modify: `src/init/adoption.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/cli.ts`
- Test: `test/model/manifest.test.ts`
- Test: `test/commands/init.test.ts`
- Test: `test/init/adoption.test.ts`

**Interfaces:**
- Produces: `ProjectManifest['profile']` is `'generic' | 'feature'`.
- Produces: `ProjectManifest['docs']` is `{ language: 'auto' | 'en' | 'zh' }`, default `{ language: 'auto' }`.
- Produces: `renderDabYaml(scan, scope, options?: { profile?: 'generic' | 'feature'; docsLanguage?: 'auto' | 'en' | 'zh' }): string`.
- Produces: `templateFiles(scan, scope, aiAddition?, options?: { profile?: 'generic' | 'feature' }): Record<string, string>` and no `.agents/rules/docs-bilingual.md` entry.
- Produces: `TEMPLATE_PROJECTIONS` without the `.agents/rules/docs-bilingual.md` entry.
- Produces: `InitOptions['profile']` is `'generic' | 'feature'`; default `generic`.

- [ ] **Step 1: Write failing schema tests**

Add to `test/model/manifest.test.ts`:

```ts
it('accepts generic and feature profiles plus docs.language', () => {
  const generic = ProjectManifestSchema.parse({ ...validManifest, profile: 'generic', docs: { language: 'auto' } });
  expect(generic.profile).toBe('generic');
  expect(generic.docs.language).toBe('auto');
  for (const language of ['auto', 'en', 'zh'] as const) {
    expect(ProjectManifestSchema.parse({ ...validManifest, docs: { language } }).docs.language).toBe(language);
  }
});

it('defaults docs.language to auto and rejects unknown values', () => {
  expect(ProjectManifestSchema.parse({ ...validManifest, docs: undefined }).docs.language).toBe('auto');
  expect(() => ProjectManifestSchema.parse({ ...validManifest, profile: 'other' })).toThrow();
  expect(() => ProjectManifestSchema.parse({ ...validManifest, docs: { language: 'fr' } })).toThrow();
});
```

Use the existing `validManifest` fixture and remove the old literal `feature` expectation.

- [ ] **Step 2: Run the schema tests to verify they fail**

Run: `pnpm vitest run test/model/manifest.test.ts`

Expected: FAIL because `generic`/`docs` are not in `ProjectManifestSchema`.

- [ ] **Step 3: Implement schema and legacy conversion**

In `src/model/schemas.ts`:

```ts
export const DocsLanguageSchema = z.enum(['auto', 'en', 'zh']);
export const DocsConfigSchema = z
  .object({ language: DocsLanguageSchema.default('auto') })
  .strict()
  .default({ language: 'auto' });

// ProjectManifestSchema
profile: z.enum(['generic', 'feature']),
docs: DocsConfigSchema,
```

Keep `LegacyProjectManifestSchema.profile` as `z.literal('feature')`. In `src/model/project-manifest.ts`, set `docs: legacy.docs ?? { language: 'auto' }` when converting a legacy manifest.

- [ ] **Step 4: Write failing init/default tests**

Add to `test/commands/init.test.ts`:

```ts
it('defaults to generic with docs.language auto', async () => {
  const result = await initializeProject({ cwd: root });
  const manifest = await loadProjectManifest(root, { scope: 'project' });
  expect(result.ok).toBe(true);
  expect(manifest.manifest.profile).toBe('generic');
  expect(manifest.manifest.docs.language).toBe('auto');
  expect(await readFile(join(root, 'dab.yaml'), 'utf8')).toContain('profile: generic');
  expect(await readFile(join(root, 'dab.yaml'), 'utf8')).toContain('docs:\n  language: auto');
});

it('accepts feature as a compatibility profile', async () => {
  const result = await initializeProject({ cwd: root, profile: 'feature' });
  expect(result.ok).toBe(true);
  expect((await loadProjectManifest(root, { scope: 'project' })).manifest.profile).toBe('feature');
});
```

Replace the current `rejects an unsupported profile` case: `generic` is now valid; keep an unknown profile rejection test.

Add to `test/init/adoption.test.ts`:

```ts
it('minimal source uses generic and docs.language auto', () => {
  const scan = { ...scanFixture };
  const plan = minimalSourcePlan(scan, 'project');
  expect(plan.manifest.profile).toBe('generic');
  expect(plan.manifest.docs.language).toBe('auto');
  expect(plan.files['dab.yaml']).toContain('profile: generic');
  expect(plan.files['dab.yaml']).toContain('docs:\n  language: auto');
});
```

- [ ] **Step 5: Run the focused tests to verify they fail**

Run: `pnpm vitest run test/model/manifest.test.ts test/commands/init.test.ts test/init/adoption.test.ts`

Expected: FAIL on `generic`, `docs`, and the old profile rejection.

- [ ] **Step 6: Implement init/defaults and remove generic bilingual rule**

In `src/init/templates.ts`:

```ts
export function renderDabYaml(
  scan: ScanResult,
  scope: Scope,
  options: { profile?: 'generic' | 'feature'; docsLanguage?: 'auto' | 'en' | 'zh' } = {},
): string {
  const profile = options.profile ?? 'generic';
  const docsLanguage = options.docsLanguage ?? 'auto';
  // emit profile and:
  // docs:
  //   language: <docsLanguage>
}

export function templateFiles(
  scan: ScanResult,
  scope: Scope,
  aiAddition?: string,
  options: { profile?: 'generic' | 'feature' } = {},
): Record<string, string> { /* no docs-bilingual entry */ }
```

Remove the `.agents/rules/docs-bilingual.md` entry from both `templateFiles` and `TEMPLATE_PROJECTIONS`; update tests that expected either. Keep `renderDocsBilingualRule` only if an existing test imports it directly; otherwise remove the now-unused export in the same change.

In `src/init/adoption.ts`, `minimalManifest` writes `profile: 'generic'` and `docs: { language: 'auto' }`; `minimalSourcePlan` passes `{ profile: 'generic' }` to `renderDabYaml`.

In `src/commands/init.ts`, change `InitOptions['profile']` to `'generic' | 'feature'` and the default manifest to `generic`/`docs: { language: 'auto' }`. In `src/cli.ts`, parse `--profile generic|feature`, default `generic`, and update the error text/help.

- [ ] **Step 7: Run focused tests to verify they pass**

Run: `pnpm vitest run test/model/manifest.test.ts test/commands/init.test.ts test/init/adoption.test.ts`

Expected: PASS.

- [ ] **Step 8: Run typecheck and commit**

Run: `pnpm typecheck`

```bash
git add src/model/schemas.ts src/model/project-manifest.ts src/init/templates.ts src/init/adoption.ts src/commands/init.ts src/cli.ts test/model/manifest.test.ts test/commands/init.test.ts test/init/adoption.test.ts
git commit -m "feat: add generic profile and docs language config"
```

---

### Task 2: 项目文档语言检测

**Files:**
- Create: `src/init/docs-language.ts`
- Test: `test/init/docs-language.test.ts`

**Interfaces:**
- Produces:

```ts
export type DocsLanguage = 'en' | 'zh';
export type DocsLanguageSource =
  | 'config'
  | 'docs/AGENTS.md'
  | 'docs/architecture.md'
  | 'AGENTS.md'
  | 'README.md'
  | 'package.json'
  | 'locale'
  | 'default';

export interface DocsLanguageResolution {
  value: DocsLanguage;
  source: DocsLanguageSource;
}

export function detectTextLanguage(text: string): DocsLanguage | undefined;
export async function resolveDocsLanguage(input: {
  root: string;
  configured: 'auto' | DocsLanguage;
  env?: NodeJS.ProcessEnv;
}): Promise<DocsLanguageResolution>;
```

- [ ] **Step 1: Write failing tests**

`test/init/docs-language.test.ts` must cover:

```ts
it('uses explicit config first', async () => {
  await writeFile(join(root, 'README.md'), '中文 README');
  await expect(resolveDocsLanguage({ root, configured: 'en' }))
    .resolves.toEqual({ value: 'en', source: 'config' });
});

it('prefers docs/AGENTS.md over docs/architecture.md', async () => {
  await writeFile(join(root, 'docs/AGENTS.md'), '# 文档规范\n\n这是中文。');
  await writeFile(join(root, 'docs/architecture.md'), '# Architecture\n\nEnglish.');
  await expect(resolveDocsLanguage({ root, configured: 'auto' }))
    .resolves.toEqual({ value: 'zh', source: 'docs/AGENTS.md' });
});

it('falls through AGENTS.md, README.md, package description, then locale', async () => {
  // Each assertion removes the higher-priority file.
});

it('uses LC_ALL before LANG and ignores non-zh locales', async () => {
  await expect(resolveDocsLanguage({ root, configured: 'auto', env: { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' } }))
    .resolves.toEqual({ value: 'zh', source: 'locale' });
  await expect(resolveDocsLanguage({ root, configured: 'auto', env: { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' } }))
    .resolves.toEqual({ value: 'en', source: 'default' });
});

it('defaults to en with source default when there is no signal', async () => {
  await expect(resolveDocsLanguage({ root, configured: 'auto' }))
    .resolves.toEqual({ value: 'en', source: 'default' });
});

it('ignores code fences and requires 20% plus 8 CJK characters', () => {
  expect(detectTextLanguage('```\n中文中文中文\n```\nEnglish only')).toBe('en');
  expect(detectTextLanguage('short 中文')).toBe('en');
  expect(detectTextLanguage('# 中文\n\n这是中文文档。')).toBe('zh');
});
```

Use a fresh temp directory per case; inject `env` rather than mutating `process.env`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/init/docs-language.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the detector**

`detectTextLanguage` removes fenced code blocks, samples the title/first paragraph, counts CJK characters (`一-鿿`) over non-whitespace characters, and returns `zh` when `cjk >= 8 && cjk / nonWhitespace >= 0.2`; otherwise `en` if there is any non-whitespace text.

`resolveDocsLanguage` order:

1. `configured !== 'auto'` → `{ value: configured, source: 'config' }`.
2. Existing `docs/AGENTS.md`.
3. Existing `docs/architecture.md`.
4. Existing root `AGENTS.md`.
5. Existing `README.md`.
6. `package.json` `description`, if parseable.
7. `env.LC_ALL` then `env.LANG`, only `zh*` → `zh`/`locale`.
8. `{ value: 'en', source: 'default' }`.

Read only; no writes. Ignore unreadable files as no signal.

- [ ] **Step 4: Run focused test and typecheck**

Run: `pnpm vitest run test/init/docs-language.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/docs-language.ts test/init/docs-language.test.ts
git commit -m "feat: detect project documentation language"
```

---

### Task 3: 共享 authored scaffold planner

**Files:**
- Create: `src/init/practice.ts`
- Test: `test/init/practice.test.ts`
- Modify: `src/init/templates.ts` only if a core wrapper helper is needed.

**Interfaces:**
- Produces:

```ts
export type ResolvedProfile = 'generic' | 'feature';
export type ScaffoldMode = 'full' | 'adoption' | 'converge';

export interface AuthoredScaffoldInput {
  root: string;
  scope: 'project' | 'global';
  scan: ScanResult;
  profile: ResolvedProfile;
  mode: ScaffoldMode;
  manifest?: ProjectManifest;
  proposals?: { agentsMdAddition?: string; agents?: AiProposalAgent[] };
  version: string;
  env?: NodeJS.ProcessEnv;
}

export interface PracticeContext {
  root: string;
  scope: 'project' | 'global';
  scan: ScanResult;
  profile: ResolvedProfile;
  mode: ScaffoldMode;
  manifest?: ProjectManifest;
  proposals?: AuthoredScaffoldInput['proposals'];
  version: string;
  anchors: ReadonlySet<string>;
  docsLanguage: DocsLanguageResolution;
}

export interface PracticeTargetSet {
  paths: string[];
  directories?: string[];
  policySkipped?: string[];
}

export interface PracticePack {
  id: string;
  targets(context: PracticeContext): PracticeTargetSet | Promise<PracticeTargetSet>;
  files(context: PracticeContext): Record<string, string> | Promise<Record<string, string>>;
  directories?(context: PracticeContext): string[] | Promise<string[]>;
}

export interface AuthoredScaffoldPlan {
  profile: ResolvedProfile;
  mode: ScaffoldMode;
  files: Record<string, string>;
  directories: string[];
  skipped: string[];
  policySkipped: string[];
  diagnostics: Diagnostic[];
  manifest?: ProjectManifest;
  docsLanguage: DocsLanguageResolution;
}

export async function planAuthoredScaffold(input: AuthoredScaffoldInput): Promise<AuthoredScaffoldPlan>;
```

- [ ] **Step 1: Write failing planner tests**

`test/init/practice.test.ts` must cover:

```ts
it('resolves anchors in two passes: existing + targets, before files', async () => {
  const pack: PracticePack = {
    id: 'fake',
    targets: () => ({ paths: ['one.md', 'two.md'] }),
    files: (ctx) => ({
      'one.md': ctx.anchors.has('two.md') ? 'links two' : 'missing two',
      'two.md': 'two',
    }),
  };
  const plan = await planWith(pack, { mode: 'converge' });
  expect(plan.files['one.md']).toBe('links two');
  expect(plan.skipped).toEqual([]);
});

it('skips existing paths and reports policy-skipped paths separately', async () => {
  await writeFile(join(root, 'one.md'), 'authored');
  const pack: PracticePack = {
    id: 'fake',
    targets: () => ({ paths: ['one.md', 'two.md', 'three.md'], policySkipped: ['three.md'] }),
    files: () => ({ 'one.md': 'template', 'two.md': 'two', 'three.md': 'three' }),
  };
  const plan = await planWith(pack, { mode: 'converge' });
  expect(plan.skipped).toEqual(['one.md']);
  expect(plan.policySkipped).toEqual(['three.md']);
  expect(plan.files).toEqual({ 'two.md': 'two' });
  expect(plan.directories).toEqual([]);
});

it('rejects a target path whose type conflicts', async () => {
  await mkdir(join(root, 'one.md'), { recursive: true });
  // expect plan.diagnostics to contain an error and no files/dirs
});
```

Also assert: full core parity with `templateFiles`, adoption core parity with `minimalSourcePlan` files/directories, converge core is empty, and `docsLanguage` is resolved and attached.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/init/practice.test.ts`

Expected: FAIL because `src/init/practice.ts` does not exist.

- [ ] **Step 3: Implement the planner**

Implement the flow exactly as the design:

1. Resolve `docsLanguage` with `resolveDocsLanguage({ root, configured: manifest?.docs.language ?? 'auto', env })`.
2. Build a base context with `anchors = new Set()`.
3. Collect `targets()` from packs; union `paths`, declared `directories` and `policySkipped`.
4. Stat every candidate path and declared directory. Missing → planned; existing file path → `skipped`; an existing declared directory → `skipped`, and every file under it is excluded from the plan (this is how an existing `dab-*` skill directory wins). A path whose type conflicts with its declared file/dir target, or whose parent escapes root, produces an error diagnostic and blocks the plan.
5. `anchors = existing ∪ (targets - existing - policySkipped)`.
6. Call `files()` with the final context; keep only keys that are candidate file paths, not existing, not under an existing declared directory, and not policy-skipped.
7. Collect `directories()`; keep only missing dirs not policy-skipped. `writeMissingFile` creates parents, so directories are for empty dirs only.
8. Set `manifest` from `input.manifest ?? template manifest` for full/adoption.

Core pack:
- `full`: target/files from `templateFiles(scan, scope, proposals?.agentsMdAddition, { profile })`, plus proposed agents from `renderAgentFromProposal`.
- `adoption`: target/files from `minimalSourcePlan(scan, scope)`, with manifest omitted when `input.manifest` is defined.
- `converge`: no core targets/files.
- Use `ensureDir`-style directory lists from `minimalSourcePlan`.

Do not read/write target file contents except the read-only language detection; no `.claude` access.

- [ ] **Step 4: Run focused test and typecheck**

Run: `pnpm vitest run test/init/practice.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/practice.ts test/init/practice.test.ts
git commit -m "feat: add shared authored scaffold planner"
```

---

### Task 4: Documentation pack（单语）

**Files:**
- Create: `src/init/practice-docs.ts`
- Test: `test/init/practice-docs.test.ts`

**Interfaces:**
- Produces:

```ts
export function renderDocsAgentsMd(input: {
  language: DocsLanguage;
  scan: ScanResult;
  anchors: ReadonlySet<string>;
}): string;

export function renderArchitectureMd(input: {
  language: DocsLanguage;
  scan: ScanResult;
}): string;

export const documentationPack: PracticePack;
```

- [ ] **Step 1: Write failing template tests**

`test/init/practice-docs.test.ts` must assert:

```ts
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

it('links architecture only when it exists or is planned', () => {
  const withArchitecture = renderDocsAgentsMd({ language: 'en', scan, anchors: new Set(['docs/architecture.md']) });
  expect(withArchitecture).toContain('[architecture](architecture.md)');
  const without = renderDocsAgentsMd({ language: 'en', scan, anchors: new Set() });
  expect(without).not.toContain('[architecture](architecture.md)');
});

it('does not generate pairs or i18n records', async () => {
  const plan = await planPack(documentationPack, { mode: 'converge' });
  expect(Object.keys(plan.files).sort()).toEqual(['docs/AGENTS.md', 'docs/architecture.md']);
  expect(plan.files).not.toHaveProperty('docs/AGENTS.zh.md');
  expect(plan.files).not.toHaveProperty('docs/AGENTS.i18n.yaml');
});

it('policy-skips both docs when the bilingual rule exists', async () => {
  await writeFile(join(root, '.agents/rules/docs-bilingual.md'), 'paired docs');
  const plan = await planPack(documentationPack, { mode: 'converge' });
  expect(plan.files).toEqual({});
  expect(plan.policySkipped.sort()).toEqual(['docs/AGENTS.md', 'docs/architecture.md']);
});
```

Also test: missing command emits line-start `TODO: add a <command> command`; TODO is ignored inside code fences; no fabricated component names; global scope target set is empty; existing docs are skipped.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/init/practice-docs.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement templates and pack**

`docs/AGENTS.md` template requirements:
- Title/intro, document structure/tiers, placement, writing rules, slop checklist, verification.
- Link to `architecture.md` only when `anchors.has('docs/architecture.md')`.
- Link to `../AGENTS.md` only when `anchors.has('AGENTS.md')`.
- Mention `.agents/notes/` as inline code, not a directory link.
- Reference `dab-doc-writing` and `dab-architecture-writing`.
- Project-specific placeholders use line-start `TODO:`.

`docs/architecture.md` template requirements:
- Header comment says DAB created the skeleton and never overwrites it.
- `## Project facts` includes project name, programming language, package manager, source dirs; missing commands are line-start `TODO: add a <command> command`.
- Fixed sections: System purpose, Composition, Runtime flow, Module boundaries, Extension points, Invariants, Verification; all except scanned facts are `TODO:` placeholders.
- No invented components, call chains, or boundaries.

Pack:
- `targets`: project scope only; `docs/AGENTS.md`, `docs/architecture.md`.
- `policySkipped`: if `.agents/rules/docs-bilingual.md` exists, both docs.
- `files`: render both in `context.docsLanguage.value`; no pairs.
- Do not write root `AGENTS.md`; that is core's job.

- [ ] **Step 4: Run focused test and typecheck**

Run: `pnpm vitest run test/init/practice-docs.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/practice-docs.ts test/init/practice-docs.test.ts
git commit -m "feat: add single-language documentation pack"
```

---

### Task 5: Authoring pack（dab-* skills）

**Files:**
- Create: `src/init/practice-authoring.ts`
- Test: `test/init/practice-authoring.test.ts`

**Interfaces:**
- Produces:

```ts
export const AUTHORING_SKILL_NAMES = [
  'dab-doc-writing',
  'dab-architecture-writing',
  'dab-decision-notes',
] as const;

export function renderAuthoringSkill(name: (typeof AUTHORING_SKILL_NAMES)[number], version: string): string;

export const authoringPack: PracticePack;
```

- [ ] **Step 1: Write failing tests**

```ts
it('renders schema-valid skills with a dab-skill version marker', async () => {
  const plan = await planPack(authoringPack, { mode: 'converge', version: '9.9.9' });
  for (const name of AUTHORING_SKILL_NAMES) {
    const file = `.agents/skills/${name}/SKILL.md`;
    expect(plan.files[file]).toContain(`<!-- dab-skill: ${name}@9.9.9 -->`);
    const dir = join(root, '.agents/skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), plan.files[file]!);
    const validated = await validateSkillSource(root, dir);
    expect(validated.item?.name).toBe(name);
  }
});

it('requires evidence, TODO(owner), project commands and docs fallback', () => {
  const text = renderAuthoringSkill('dab-architecture-writing', '1.0.0');
  expect(text).toContain('TODO(owner): question');
  expect(text).toContain('root `AGENTS.md`');
  expect(text).toContain('`docs/AGENTS.md` exists');
  expect(text).toContain('package.json');
  expect(text).toContain('does not invent');
});

it('skips an existing skill directory instead of adding SKILL.md', async () => {
  await mkdir(join(root, '.agents/skills/dab-doc-writing'), { recursive: true });
  await writeFile(join(root, '.agents/skills/dab-doc-writing/README.md'), 'user owned');
  const plan = await planPack(authoringPack, { mode: 'converge' });
  expect(plan.files).not.toHaveProperty('.agents/skills/dab-doc-writing/SKILL.md');
  expect(plan.skipped).toContain('.agents/skills/dab-doc-writing');
});
```

Also test: invalid existing `SKILL.md` is left to existing discovery (do not create/overwrite); non-project scope returns no targets; file at the skill directory path is a path-type error.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/init/practice-authoring.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement skills and pack**

Each skill must contain:
- YAML frontmatter with exact `name` and a trigger-oriented `description`.
- Body marker `<!-- dab-skill: <name>@<version> -->`.
- Sections: When to use, Inputs, Workflow, Evidence/fact-check, TODO rules, Project commands, Verification.
- `TODO(owner): question` for unverifiable content; no guessing.
- Read `docs/AGENTS.md` when it exists; otherwise root `AGENTS.md` and project rules.
- Read commands from `AGENTS.md`/`package.json`; no hardcoded package manager.
- `dab-architecture-writing`: inventory, composition/runtime/seams, current-state prose, link owners, fill TODOs.
- `dab-decision-notes`: when to write, proposed/implemented/rejected, alternatives/consequences/verification, supersession; no archive implementation.
- `dab-doc-writing`: placement/one-home-per-fact/fact-check/slop audit/pairing is not required (single language).

Pack:
- `targets`: project scope only; three skill **directories** plus their `SKILL.md` paths; `directories` contains the three skill dirs.
- Planner rule: if a declared skill directory exists, skip the directory and all its declared files.
- `files`: SKILL.md content only for missing dirs.
- `directories`: missing skill dirs.

- [ ] **Step 4: Run focused test and typecheck**

Run: `pnpm vitest run test/init/practice-authoring.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/practice-authoring.ts test/init/practice-authoring.test.ts
git commit -m "feat: add authoring skill pack"
```

---

### Task 6: `init` 接入 full planner

**Files:**
- Create: `src/core/version.ts`
- Modify: `src/init/practice.ts` (pack registry)
- Modify: `src/init/templates.ts` (root AGENTS Documentation section)
- Modify: `src/commands/init.ts`
- Modify: `src/cli.ts` (help text)
- Test: `test/commands/init.test.ts`
- Test: `test/commands/init-scope.test.ts`

**Interfaces:**
- Produces: `init` uses `planAuthoredScaffold({ root, scope, scan, profile, mode: 'full', manifest, proposals, version })`.
- Produces: `InitResult.language: DocsLanguageResolution` and JSON top-level `language`.
- Produces: new root `AGENTS.md` `## Documentation` section only when at least one docs target exists or is planned.

- [ ] **Step 1: Write failing init integration tests**

Add:

```ts
it('creates single-language docs and authoring skills by default', async () => {
  const result = await initializeProject({ cwd: root });
  expect(result.ok).toBe(true);
  expect(result.created).toEqual(expect.arrayContaining([
    'docs/AGENTS.md',
    'docs/architecture.md',
    '.agents/skills/dab-doc-writing/SKILL.md',
    '.agents/skills/dab-architecture-writing/SKILL.md',
    '.agents/skills/dab-decision-notes/SKILL.md',
  ]));
  expect(result.created).not.toContain('docs/AGENTS.zh.md');
  expect(result.created).not.toContain('.agents/rules/docs-bilingual.md');
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('## Documentation');
});

it('does not add the Documentation section when a bilingual rule policy-skips docs', async () => {
  await writeFile(join(root, '.agents/rules/docs-bilingual.md'), 'paired docs');
  const result = await initializeProject({ cwd: root });
  expect(result.ok).toBe(true);
  expect(result.created).not.toContain('docs/AGENTS.md');
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).not.toContain('## Documentation');
});

it('passes --ai proposals through the planner', async () => {
  // Reuse the fake requestAiProposal/onProposal pattern already in this file.
  // Assert: the proposed .agents/agents/<name>.md exists, the proposed addition appears in AGENTS.md,
  // and .claude/agents/<name>.md is planned by the nested normalize.
});

it('reports language in JSON and does not overwrite an existing manifest', async () => {
  // Existing feature manifest with docs.language en; init --profile generic must keep feature/docs.
});
```

Also test: existing docs/skills skipped; dry-run plan; global scope no docs/skills; `init --profile feature` writes feature.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/commands/init.test.ts test/commands/init-scope.test.ts`

Expected: FAIL because init still calls `templateFiles()` and no docs/skills are created.

- [ ] **Step 3: Wire init to the planner**

- Add `src/core/version.ts` exporting `DAB_VERSION` read from `package.json`, and use it for the planner `version` and `dab-skill` markers. `src/cli.ts` may reuse it instead of its local package read.
- Build `proposals` from `proposal?.agentsMdAddition` and `proposal?.agents`.
- Pass existing `manifest` (if any), resolved profile (default generic), scan, `DAB_VERSION`, and `mode: 'full'`.
- Use `plan.files`, `plan.directories`, `plan.skipped`, `plan.policySkipped`, `plan.diagnostics`.
- Existing init conflict/preflight checks run before writes; planner diagnostics are blocking.
- `renderAgentsMd` receives `documentation: boolean` when the plan has docs targets or existing docs/AGENTS/architecture; add the section exactly:

```md
## Documentation

- [docs/AGENTS.md](docs/AGENTS.md)
- [docs/architecture.md](docs/architecture.md)
```

Only for project scope; omit if policy-skipped.
- Add `language` to `InitResult` and print `Language: <value> (source: <source>)` in human output; JSON adds top-level `language`. Dry-run uses the same plan.
- Keep `init --ai` confirmation flow; no LLM call in planner.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run test/commands/init.test.ts test/commands/init-scope.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/version.ts src/init/practice.ts src/init/templates.ts src/commands/init.ts src/cli.ts test/commands/init.test.ts test/commands/init-scope.test.ts
git commit -m "feat: scaffold practice layer during init"
```

---

### Task 7: `normalize` adoption/converge 接入

**Files:**
- Modify: `src/init/adoption.ts`
- Modify: `src/commands/normalize.ts`
- Test: `test/commands/normalize-adoption.test.ts`
- Test: `test/commands/normalize.test.ts`

**Interfaces:**
- Produces: `NormalizeResult.practices?: NormalizePracticesResult`:

```ts
export interface NormalizePracticesResult {
  profile: 'generic' | 'feature';
  mode: 'adoption' | 'converge';
  language: DocsLanguageResolution;
  created: string[];
  skipped: string[];
  policySkipped: string[];
  directories: string[];
  skills: { created: string[]; skipped: string[] };
  diagnostics: Diagnostic[];
}
```

- [ ] **Step 1: Write failing normalize tests**

Add to `test/commands/normalize-adoption.test.ts`:

```ts
it('adopts docs and authoring skills for an uninitialized project', async () => {
  const result = await normalizeProject({ cwd: root, home: dirname(root) });
  expect(result.ok).toBe(true);
  expect(result.practices?.created).toEqual(expect.arrayContaining(['docs/AGENTS.md', 'docs/architecture.md']));
  expect(result.practices?.skills.created).toHaveLength(3);
  expect(result.practices?.language.value).toBe('en');
});

it('policy-skips docs but still installs skills when the bilingual rule exists', async () => {
  await writeFile(join(root, '.agents/rules/docs-bilingual.md'), 'paired docs');
  const result = await normalizeProject({ cwd: root, home: dirname(root) });
  expect(result.ok).toBe(true);
  expect(result.practices?.policySkipped.sort()).toEqual(['docs/AGENTS.md', 'docs/architecture.md']);
  expect(result.practices?.skills.created).toHaveLength(3);
});

it('converges missing docs on an initialized project', async () => {
  const project = await initializedProject();
  const result = await normalizeProject({ cwd: project.root, home: dirname(project.root) });
  expect(result.ok).toBe(true);
  expect(result.practices?.mode).toBe('converge');
  expect(result.practices?.created).toContain('docs/AGENTS.md');
});

it('never overwrites existing docs and is idempotent', async () => {
  await writeFile(join(root, 'docs/AGENTS.md'), 'authored');
  await normalizeProject({ cwd: root, home: dirname(root) });
  expect(await readFile(join(root, 'docs/AGENTS.md'), 'utf8')).toBe('authored');
  const second = await normalizeProject({ cwd: root, home: dirname(root) });
  expect(second.practices?.created).toEqual([]);
});
```

Also test: dry-run `practices.created` planned/no writes; blocked diagnostics; global normalize omits `practices`; existing feature manifest keeps profile.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/commands/normalize-adoption.test.ts test/commands/normalize.test.ts`

Expected: FAIL because normalize has no docs/skills/practices.

- [ ] **Step 3: Implement adoption/converge integration**

- In `prepareNormalizeAdoption`, call the planner for both phases with `DAB_VERSION` from `src/core/version.ts`:
  - uninitialized/partial: mode `adoption`; use plan files/dirs in place of `minimalSourcePlan` (keep the existing all-or-nothing/import preflight).
  - initialized: mode `converge`; add a practice plan before target planning.
- Add `practicePlan?: AuthoredScaffoldPlan` to the preparation and `practices` to `NormalizeResult`.
- Apply practice writes with `writeSourceFiles`/`planSourceWrites` semantics; policy-skipped docs produce warnings, not blocking errors.
- For initialized projects, run practice preflight/writes before target planning; a practice blocking error means zero writes.
- Build `practices`:
  - `created` docs only (paths not under `.agents/skills/`).
  - `skills.created/skipped` classify paths by `.agents/skills/dab-*`.
  - `skipped` existing docs/skills; `policySkipped` docs; `directories` practice-owned dirs.
  - `language` from the plan.
- Global scope omits `practices`; blocked runs keep planned fields + diagnostics.
- Existing docs/skills never overwritten; `--fix` does not touch them.
- Human output adds `Language: <value> (source: <source>)` once and create/skip lines for practice paths.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run test/commands/normalize-adoption.test.ts test/commands/normalize.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/adoption.ts src/commands/normalize.ts test/commands/normalize-adoption.test.ts test/commands/normalize.test.ts
git commit -m "feat: converge practice layer during normalize"
```

---

### Task 8: `detect` Documentation/Skills 接入

**Files:**
- Create: `src/detect/practice.ts`
- Modify: `src/detect/checklist.ts`
- Modify: `src/commands/detect.ts`
- Modify: `src/detect/preflight.ts`
- Test: `test/commands/detect.test.ts`
- Test: `test/commands/detect-preflight.test.ts`
- Test: `test/detect/checklist.test.ts`
- Test: `test/detect/practice.test.ts` (new)

**Interfaces:**
- Produces: `Documentation` group between `Instructions` and `Agents`.
- Produces diagnostics:
  - `practice.docs-missing` warning (strict)
  - `practice.skill-missing` warning (strict)
  - `practice.docs-todo` warning (strict)
  - `practice.docs-empty` warning (strict)
  - `practice.skill-stale` warning (strict)
  - `practice.skill-unversioned` warning (non-strict, no next)
  - `practice.docs-bilingual-policy` warning (non-strict)
  - `practice.docs-link` error
  - `practice.docs-path` / `practice.skill-path` error
- Produces checklist entries with `group: 'Documentation'` and authoring skills in `Skills`.

- [ ] **Step 1: Write failing detect tests**

Add to `test/commands/detect-preflight.test.ts`:

```ts
it('shows Documentation and authoring skill entries before initialization', async () => {
  const result = await detectProject({ cwd: root, home: dirname(root) });
  expect(result.checklist).toEqual(expect.arrayContaining([
    expect.objectContaining({ group: 'Documentation', status: 'missing', next: 'dab normalize' }),
    expect.objectContaining({ group: 'Skills', label: 'dab-architecture-writing', status: 'missing' }),
  ]));
  expect(result.checklist.find((entry) => entry.group === 'Documentation')?.detail)
    .toContain('Language:');
});
```

Add to `test/detect/practice.test.ts`:

```ts
it('warns on TODO and empty architecture sections', async () => {
  // write docs/architecture.md with a heading and no body; expect docs-empty + docs-todo warnings.
});

it('reports broken links as errors and policy skips as non-strict warnings', async () => {
  // broken link => practice.docs-link error; bilingual rule => docs-bilingual-policy warning and no docs-missing.
});

it('reports stale markers as strict but unversioned markers as non-strict/no-next', async () => {
  // existing skill without marker => skill-unversioned warn, next undefined;
  // marker older than version => skill-stale warn, next manual.
});
```

Update `test/detect/checklist.test.ts` for the `Documentation` group order.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `pnpm vitest run test/detect/practice.test.ts test/commands/detect-preflight.test.ts test/detect/checklist.test.ts`

Expected: FAIL because the group/module/diagnostics do not exist.

- [ ] **Step 3: Implement preflight and initialized checks**

- Add `Documentation` to `GROUP_ORDER` after `Instructions`.
- In preflight, call the planner in `adoption` mode with `DAB_VERSION`; for a partial scope with a valid manifest, pass that manifest so its profile and `docs.language` are used; for uninitialized/no-valid-manifest use the default `generic` + `auto`. Derive:
  - docs missing vs policy-skipped;
  - authoring skill missing;
  - resolved language `{ value, source }`.
  Add entries in `Documentation` and `Skills`; suppress `next` when the manifest is invalid.
- In initialized detect, add `checkPracticePackages(root, scope, manifest, paths, DAB_VERSION)`:
  - Use planner targets/anchors to determine missing docs/skills; policy skip; language.
  - Read only the two docs files: link check (error), TODO check (line-start outside code), empty architecture sections (warn).
  - Read `dab-*` skill markers: missing → `skill-unversioned` (warn, no next); older than current → `skill-stale` (warn, next manual).
  - Path type/escape → `docs-path`/`skill-path` error.
- Map diagnostics to `ChecklistEntry` without duplicate entries; group docs entries in Documentation, skills in Skills.
- Strict behavior: add a non-strict warning code set `{ practice.docs-bilingual-policy, practice.skill-unversioned }`; all other practice warnings trigger `--strict` exit 3. Link/path errors keep normal error exit.
- `checklist[].detail` includes `Language: <value> (source: <source>)` for Documentation entries; no structured field.
- Global scope returns no docs/skills entries.
- JSON checklist includes the new groups/entries; `schemaVersion` stays 1.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run test/detect/practice.test.ts test/commands/detect-preflight.test.ts test/commands/detect.test.ts test/detect/checklist.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/detect/practice.ts src/detect/checklist.ts src/commands/detect.ts src/detect/preflight.ts test/detect/practice.test.ts test/commands/detect-preflight.test.ts test/commands/detect.test.ts test/detect/checklist.test.ts
git commit -m "feat: report practice layer in detect"
```

---

### Task 9: DAB 仓库 dogfood

**Files:**
- Create: `docs/AGENTS.md`
- Create: `.agents/skills/dab-doc-writing/SKILL.md`
- Create: `.agents/skills/dab-architecture-writing/SKILL.md`
- Create: `.agents/skills/dab-decision-notes/SKILL.md`
- Modify: `AGENTS.md` (Documentation link, if not already present)
- Run: `node dist/cli.js normalize`

- [ ] **Step 1: Add the single-language docs standard**

Create `docs/AGENTS.md` (English) from the pack template, adapted to DAB:
- Document tiers and placement.
- One home per fact.
- Current-state prose; one physical line per paragraph.
- Slop checklist.
- Verification: `dab detect`, `pnpm doc-sync`.
- `docs/AGENTS.md` is an AGENTS file and remains pairing-exempt; `docs/architecture.md` keeps its existing bilingual pair.

Add a `Documentation` link in root `AGENTS.md` pointing to `docs/AGENTS.md` and `docs/architecture.md`.

- [ ] **Step 2: Install the three authoring skills**

Copy the pack-rendered `dab-*` skill content into `.agents/skills/` (same content as the templates, with the current DAB version marker). Do not modify `docs-bilingual.md` or existing skills.

- [ ] **Step 3: Normalize and verify**

Run:

```bash
pnpm build
node dist/cli.js normalize --dry-run
node dist/cli.js normalize
node dist/cli.js detect --strict
pnpm doc-sync
```

Expected: normalize creates only missing projections/links; detect shows Documentation and Skills OK; `docs/architecture` pairing remains; no `.zh.md`/`.i18n.yaml` for `docs/AGENTS.md`; no bilingual rule removal.

- [ ] **Step 4: Commit**

```bash
git add docs/AGENTS.md AGENTS.md .agents/skills/dab-doc-writing/SKILL.md .agents/skills/dab-architecture-writing/SKILL.md .agents/skills/dab-decision-notes/SKILL.md
git commit -m "docs: dogfood the practice layer"
```

---

### Task 10: 文档、Agent Note 与最终验证

**Files:**
- Modify: `docs/user/cli.md`, `docs/user/cli.zh.md`, `docs/user/cli.i18n.yaml`
- Modify: `docs/architecture.md`, `docs/architecture.zh.md`, `docs/architecture.i18n.yaml`
- Modify: `README.md`, `README.zh.md`, `README.i18n.yaml` (feature summary/links)
- Modify: `docs/roadmap.md`, `docs/roadmap.zh.md`, `docs/roadmap.i18n.yaml` (practice layer status/profile alias)
- Modify: `CHANGELOG.md`, `CHANGELOG.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-11-23-practice-layer.md`, `.zh.md`, `.i18n.yaml`
- Modify: `docs/superpowers/plans/README.md` (mark plan implemented only after execution)
- Verify: all tests/typecheck/doc-sync/detect/normalize.

- [ ] **Step 1: Update paired user and architecture docs**

Cover:
- `init` default `generic`; `feature` alias; `docs.language: auto|en|zh` and detection/reporting.
- Single-language docs pack (2 files), no pairs; existing docs never overwritten.
- Bilingual rule policy skip; generic no longer generates `.agents/rules/docs-bilingual.md`; existing rules preserved.
- `normalize` adoption/converge docs/skills, `practices` JSON (`language`, `created`, `skipped`, `policySkipped`, `directories`, `skills`), global omission, blocked runs.
- `detect` Documentation group, authoring Skills entries, diagnostics/strict mapping (policy/unversioned non-strict).
- `init --ai` proposals through the planner.
- `docs.language` explicit `zh` example.

Update English and Chinese in the same change, `.i18n.yaml` records, then run `pnpm run verify-translation-pairing --write`.

- [ ] **Step 2: Add the Agent Note**

Create the English/Chinese/i18n triplet under `.agents/notes/implemented/architecture/` with:
- Problem: DAB only governed config; docs/skills were not scaffolded.
- Decision: profile/practice pack model, shared planner, single-language docs, authoring skills.
- Alternatives considered: per-practice profiles, practices.yaml, skills-only, default bilingual.
- Consequences: existing v0.1.1 projects with bilingual rules do not get auto docs; skills are authored copies; no automatic skill updates.
- Verification: listed commands and test counts.

- [ ] **Step 3: Update CHANGELOG and roadmap**

Add an Unreleased/minor entry for:
- generic default/feature alias;
- docs.language and single-language docs;
- docs-bilingual rule no longer generated, existing preserved/policy skip;
- normalize docs/skills and new JSON fields;
- detect Documentation/Skills and strict mapping.

- [ ] **Step 4: Run the full verification**

```bash
pnpm test
pnpm typecheck
pnpm doc-sync
pnpm build
node dist/cli.js detect --strict
node dist/cli.js normalize --dry-run
git diff --check
```

Expected: 54+ test files pass (with updated assertions), typecheck 0, doc-sync clean, `detect --strict` exits 0 with score 100% and no undocumented drift, normalize dry-run unchanged, diff check clean.

- [ ] **Step 5: Commit**

```bash
git add docs README.md README.zh.md README.i18n.yaml CHANGELOG.md CHANGELOG.zh.md .agents/notes docs/superpowers/plans/README.md
git commit -m "docs: document the practice layer"
```
