# DAB Detect Checklist 与 Normalize Adoption 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `dab detect` 在任意 project/global scope 输出 checklist，并让 `dab normalize` 自动接入缺失 source、导入 `.claude/agents`/`.claude/skills`，备份后按 per-entry symlink 对齐。

**Architecture:** 公共 adoption 层负责 phase/root、minimal source 和 manifest；Claude adapter 子模块负责 agents/skills 的扫描、单源校验、导入和备份替换；detect 复用同一份 plan 生成 checklist。`init` 保持 full profile 初始化，normalize 使用 minimal 模式。所有 `.claude` 写入在目标预检后执行，source 写入幂等。

**Tech Stack:** TypeScript ESM、Node `>=24.9`、pnpm 11.9.0、Vitest 5.1.0、`zod` 4.6.7、`yaml` 2.9.1。

**Spec:** `docs/superpowers/specs/2026-11-23-detect-normalize-adoption-design.md`

## Global Constraints

- Node `>=24.9`，TypeScript ESM，包管理器 `pnpm@11.9.0`。
- `AGENTS.md` 和 `.agents/` 是唯一 authored source；`.claude/` 是生成目标，永不手工编辑。
- 继续 per-entry symlink；不改成目录级 symlink。
- 不新增 import/audit 命令；只改 `detect`、`normalize`、`init`。
- 备份复用 `.dab/backups/`：project 为 `<repo>/.dab/backups`，global 为 `$HOME/.dab/backups`。
- `~/.claude/settings.json` 和 `$HOME/.gitignore` 始终只读。
- 永不覆盖已有 `.agents` authored source 或已存在且解析失败的 `dab.yaml`。
- 每个任务先写失败测试，再实现；运行 focused test，再运行 `pnpm test`。
- 产品文档保持英中配对；`docs/superpowers/**` 默认中文单语。
- 每个任务结束时提交，commit message 使用 `feat:`、`refactor:`、`test:` 或 `docs:` 前缀，并以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

## Review Focus

1. **Uninitialized/partial root：** project 无 marker、只有 `.agents/`、只有 `dab.yaml`、manifest 解析失败、global `~/.agents` 完全缺失时，root 和 phase 必须明确，不能写到错误目录。
2. **非法 import 与冲突：** 非法 agent/skill、unmanaged symlink、physical target、非 import 冲突时，不能写 `.claude`；source 写入必须幂等且可重跑。
3. **同内容/差异内容/额外文件：** `.agents` 已存在且内容相同、内容不同、skill 目录有额外文件时，备份和 warning 必须一致，不能静默丢文件。
4. **Global 真实 HOME：** 所有 global 测试使用临时 HOME；不能写真实 `$HOME`，不能改 `~/.claude/settings.json` 或 `$HOME/.gitignore`。
5. **All-or-nothing：** 目标预检失败时 `.claude` 零写入；source 副本可以保留，但必须幂等并在 JSON 中报告。

## File Structure

**新增**

- `src/init/adoption.ts`：phase/root、minimal source、manifest、source write plan。
- `src/adapter/claude-code/adoption.ts`：Claude agents/skills 导入 plan/apply、备份、symlink。
- `src/detect/checklist.ts`：checklist 类型、构建、格式化、score。
- `src/detect/preflight.ts`：未初始化/partial 的只读 preflight。
- `test/init/adoption.test.ts`
- `test/adapter/claude-adoption.test.ts`
- `test/detect/checklist.test.ts`
- `test/commands/detect-preflight.test.ts`
- `test/commands/normalize-adoption.test.ts`

**修改**

- `src/model/scope.ts`：scope marker/root 解析，供 adoption 使用。
- `src/model/agents.ts`、`src/model/skills.ts`：导出单源校验。
- `src/commands/normalize.ts`：adoption/import 管线、JSON、all-or-nothing。
- `src/commands/detect.ts`：preflight/checklist、JSON、人类输出。
- `src/commands/init.ts`：复用 minimal source 的共享 helper，不改变 init 语义。
- `test/model/agents.test.ts`、`test/model/skills.test.ts`、`test/model/scope.test.ts`、`test/commands/detect.test.ts`、`test/commands/normalize.test.ts`、`test/commands/init.test.ts`。
- `docs/user/cli.md`、`docs/architecture.md`、`docs/user/claude-code.md` 及 `.zh.md`、`.i18n.yaml`。
- `CHANGELOG.md`、`CHANGELOG.zh.md`、`CHANGELOG.i18n.yaml`。
- `docs/superpowers/specs/2026-11-23-detect-normalize-adoption-design.md`、`docs/superpowers/plans/README.md`。

---

### Task 1: 单源 agent/skill 校验

**Files:**
- Modify: `src/model/agents.ts`
- Modify: `src/model/skills.ts`
- Test: `test/model/agents.test.ts`
- Test: `test/model/skills.test.ts`

**Interfaces:**
- Produces:
  - `export interface AgentSourceResult { item?: AgentDefinition; diagnostics: Diagnostic[] }`
  - `export async function validateAgentSource(root: string, file: string): Promise<AgentSourceResult>`
  - `export interface SkillSourceResult { item?: SkillDefinition; diagnostics: Diagnostic[] }`
  - `export async function validateSkillSource(root: string, dir: string): Promise<SkillSourceResult>`
- `discoverAgents`/`discoverSkills` 保留现有输出，内部改为调用单源校验；重复 name 仍由 discovery 处理。

- [ ] **Step 1: 写失败测试**

在 `test/model/agents.test.ts` 增加：

```ts
it('validates a single agent source for adoption', async () => {
  const fixture = await project();
  const file = join(fixture.root, '.agents/agents/reviewer.md');
  await writeProjectFile(fixture.root, '.agents/agents/reviewer.md', agent('reviewer'));
  const result = await validateAgentSource(fixture.root, file);
  expect(result.item?.name).toBe('reviewer');
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
});

it('rejects memory: project from a single agent source', async () => {
  const fixture = await project();
  const file = join(fixture.root, '.agents/agents/reviewer.md');
  await writeProjectFile(fixture.root, '.agents/agents/reviewer.md', agent('reviewer', 'memory: project\n'));
  const result = await validateAgentSource(fixture.root, file);
  expect(result.item).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain('agent.memory-project');
});
```

在 `test/model/skills.test.ts` 增加：

```ts
it('validates a single skill directory for adoption', async () => {
  const fixture = await project();
  await writeProjectFile(fixture.root, '.agents/skills/doc-sync/SKILL.md', '---\nname: doc-sync\ndescription: Sync.\n---\nBody.\n');
  const result = await validateSkillSource(fixture.root, join(fixture.root, '.agents/skills/doc-sync'));
  expect(result.item?.name).toBe('doc-sync');
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
});

it('reports a missing SKILL.md from a single skill directory', async () => {
  const fixture = await project();
  const dir = join(fixture.root, '.agents/skills/empty');
  await mkdir(dir, { recursive: true });
  const result = await validateSkillSource(fixture.root, dir);
  expect(result.item).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain('skill.missing');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/model/agents.test.ts test/model/skills.test.ts`
Expected: FAIL，`validateAgentSource`/`validateSkillSource` 不存在。

- [ ] **Step 3: 抽取单源校验**

把 `discoverAgents` 中单文件的解析/校验逻辑移入 `validateAgentSource`，把 `discoverSkills` 中单目录逻辑移入 `validateSkillSource`。单源函数返回 item 或 diagnostics；跨文件重复 name、目录缺失和 symlink 仍由 discovery 处理。

- [ ] **Step 4: 运行 focused test 和完整测试**

Run: `pnpm vitest run test/model/agents.test.ts test/model/skills.test.ts`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/model/agents.ts src/model/skills.ts test/model/agents.test.ts test/model/skills.test.ts
git commit -m "refactor: extract single-source agent and skill validation"
```

---

### Task 2: Adoption root 与 phase

**Files:**
- Modify: `src/model/scope.ts`
- Create: `src/init/adoption.ts`（本任务先放类型和 root 解析）
- Test: `test/init/adoption.test.ts`

**Interfaces:**
- Produces:
  - `export type AdoptionPhase = 'initialized' | 'partial' | 'uninitialized'`
  - `export interface AdoptionRoot { scope: Scope; root: string; sourceRoot: string; manifestPath: string; instructionsPath: string; phase: AdoptionPhase; manifestValid: boolean }`
  - `export async function resolveAdoptionRoot(input: { cwd: string; home: string }): Promise<AdoptionRoot>`
- `src/model/scope.ts` 导出 `ScopeMarker { scope; root; sourceRoot; manifestPath; instructionsPath; hasManifest; hasAgents }` 和 `resolveScopeMarker`，供 adoption 使用；不引入 `project-manifest.ts` 运行时依赖，避免循环。

- [ ] **Step 1: 写失败测试**

`test/init/adoption.test.ts`：

```ts
it('classifies a project with manifest and .agents as initialized', async () => {
  const project = await makeProject();
  await populateProject(project);
  const result = await resolveAdoptionRoot({ cwd: project.root, home: dirname(project.root) });
  expect(result).toMatchObject({ scope: 'project', root: project.root, phase: 'initialized', manifestValid: true });
});

it('classifies a project with only .agents as partial', async () => {
  const project = await makeProject();
  const result = await resolveAdoptionRoot({ cwd: project.root, home: dirname(project.root) });
  expect(result.phase).toBe('partial');
  expect(result.manifestValid).toBe(false);
});

it('uses the nearest git root for an uninitialized project', async () => {
  const root = await tempDir();
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'nested'), { recursive: true });
  const result = await resolveAdoptionRoot({ cwd: join(root, 'nested'), home: dirname(root) });
  expect(result).toMatchObject({ scope: 'project', root, phase: 'uninitialized' });
});

it('classifies global scope from ~/.agents', async () => {
  const home = await makeTempDir('dab-adopt-home-');
  await mkdir(join(home, '.agents'), { recursive: true });
  const result = await resolveAdoptionRoot({ cwd: join(home, '.agents'), home });
  expect(result).toMatchObject({ scope: 'global', root: home, sourceRoot: join(home, '.agents'), phase: 'partial' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/init/adoption.test.ts`
Expected: FAIL，函数不存在。

- [ ] **Step 3: 实现 scope marker 和 adoption root**

在 `scope.ts` 用现有 `canonical`/`findProjectRoot`/`hasManifest`/`hasAgentsTree` 实现 `resolveScopeMarker`；在 `adoption.ts` 用 `loadProjectManifest` 判断 manifest 是否有效，计算 phase。project 无 marker 时向上找最近 `.git`，找不到用 cwd。global 仅在 cwd 位于 `$HOME/.agents` 下时选择；完全缺失 `~/.agents` 时由 `dab init ~/.agents` 创建。

- [ ] **Step 4: 运行 focused test 和完整测试**

Run: `pnpm vitest run test/init/adoption.test.ts test/model/scope.test.ts`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/model/scope.ts src/init/adoption.ts test/init/adoption.test.ts
git commit -m "feat: resolve adoption root and phase"
```

---

### Task 3: Minimal source plan 与写入

**Files:**
- Modify: `src/init/adoption.ts`
- Test: `test/init/adoption.test.ts`

**Interfaces:**
- Produces:
  - `export interface MinimalSourcePlan { files: Record<string,string>; directories: string[]; manifest: ProjectManifest }`
  - `export function minimalSourcePlan(scan: ScanResult, scope: Scope): MinimalSourcePlan`
  - `export async function planSourceWrites(root: string, plan: MinimalSourcePlan): Promise<{ create: string[]; skip: string[] }>`
  - `export async function writeSourceFiles(root: string, plan: MinimalSourcePlan): Promise<{ created: string[]; skipped: string[] }>`

- [ ] **Step 1: 写失败测试**

```ts
it('builds a project minimal source without default agents or skills', async () => {
  const project = await makeProject();
  const scan = await scanProject(project.root);
  const plan = minimalSourcePlan(scan, 'project');
  expect(Object.keys(plan.files)).toEqual(expect.arrayContaining(['AGENTS.md', 'dab.yaml', '.agents/policies/project.yaml', '.agents/adapters/claude-code.yaml', '.agents/memory/INDEX.md']));
  expect(Object.keys(plan.files).some((file) => file.startsWith('.agents/agents/'))).toBe(false);
  expect(Object.keys(plan.files).some((file) => file.startsWith('.agents/skills/'))).toBe(false);
  expect(plan.manifest.scope).toBe('project');
});

it('builds global minimal paths under .agents', async () => {
  const home = await makeTempDir('dab-adopt-home-');
  const scan = await scanProject(home);
  const plan = minimalSourcePlan(scan, 'global');
  expect(plan.files['.agents/AGENTS.md']).toBeDefined();
  expect(plan.files['.agents/dab.yaml']).toBeDefined();
});

it('does not overwrite existing authored files', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, 'AGENTS.md', 'keep me\n');
  const scan = await scanProject(project.root);
  const plan = minimalSourcePlan(scan, 'project');
  const result = await writeSourceFiles(project.root, plan);
  expect(result.skipped).toContain('AGENTS.md');
  expect(await readFile(join(project.root, 'AGENTS.md'), 'utf8')).toBe('keep me\n');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/init/adoption.test.ts`
Expected: FAIL，函数不存在。

- [ ] **Step 3: 实现 minimal source 和写入**

复用 `renderAgentsMd`、`renderDabYaml`、`renderProjectPolicy`、`renderClaudeCodePolicy`、`renderMemoryIndex`；构造 manifest 后用 `ProjectManifestSchema.parse` 校验。`writeSourceFiles` 只写缺失文件，目录用 `ensureDir`，不覆盖已有文件。

- [ ] **Step 4: 运行 focused test 和完整测试**

Run: `pnpm vitest run test/init/adoption.test.ts`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/init/adoption.ts test/init/adoption.test.ts
git commit -m "feat: plan and write minimal DAB source"
```

---

### Task 4: Claude 导入 plan

**Files:**
- Create: `src/adapter/claude-code/adoption.ts`
- Test: `test/adapter/claude-adoption.test.ts`

**Interfaces:**
- Produces:
  - `export interface ClaudeAdoptionEntry { kind: 'agent' | 'skill'; name: string; source: string; target: string; writeSource: boolean; replaceTarget: boolean; diagnostics: Diagnostic[] }`
  - `export interface ClaudeAdoptionPlan { entries: ClaudeAdoptionEntry[]; diagnostics: Diagnostic[] }`
  - `export async function planClaudeAdoption(input: { root: string; scope: Scope; agentsRoot: string; claudeRoot: string; manifest?: ProjectManifest }): Promise<ClaudeAdoptionPlan>`
- 扫描 `.claude/agents/*.md` 普通文件、`.claude/skills/*/SKILL.md` 目录；使用 `validateAgentSource`/`validateSkillSource`。保留源 basename/dirname，不按 frontmatter name 重命名。

- [ ] **Step 1: 写失败测试**

```ts
it('plans an import for an unmanaged physical agent', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n');
  const plan = await planClaudeAdoption({ root: project.root, scope: 'project', agentsRoot: project.agents, claudeRoot: project.claude });
  expect(plan.entries).toContainEqual(expect.objectContaining({ kind: 'agent', target: '.agents/agents/reviewer.md', writeSource: true, replaceTarget: true }));
  expect(plan.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
});

it('keeps an existing .agents source and still replaces the target', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, '.agents/agents/reviewer.md', '---\nname: reviewer\ndescription: Source.\n---\nSource.\n');
  await writeProjectFile(project.root, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Old.\n---\nOld.\n');
  const plan = await planClaudeAdoption({ root: project.root, scope: 'project', agentsRoot: project.agents, claudeRoot: project.claude });
  expect(plan.entries).toContainEqual(expect.objectContaining({ target: '.agents/agents/reviewer.md', writeSource: false, replaceTarget: true }));
  expect(plan.diagnostics.map((d) => d.code)).toContain('adoption.content-differs');
});

it('plans a skill directory import and warns about extra files', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, '.claude/skills/pdf-tools/SKILL.md', '---\nname: pdf-tools\ndescription: PDF.\n---\nPDF.\n');
  await writeProjectFile(project.root, '.claude/skills/pdf-tools/helpers.md', 'extra\n');
  await writeProjectFile(project.root, '.agents/skills/pdf-tools/SKILL.md', '---\nname: pdf-tools\ndescription: PDF.\n---\nPDF.\n');
  const plan = await planClaudeAdoption({ root: project.root, scope: 'project', agentsRoot: project.agents, claudeRoot: project.claude });
  expect(plan.entries).toContainEqual(expect.objectContaining({ kind: 'skill', target: '.agents/skills/pdf-tools', writeSource: false, replaceTarget: true }));
  expect(plan.diagnostics.map((d) => d.code)).toContain('adoption.skill-extra-files');
});

it('rejects an invalid agent candidate', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, '.claude/agents/bad.md', '---\nname: bad\n---\n');
  const plan = await planClaudeAdoption({ root: project.root, scope: 'project', agentsRoot: project.agents, claudeRoot: project.claude });
  expect(plan.entries).toEqual([]);
  expect(plan.diagnostics.map((d) => d.code)).toContain('agent.invalid-frontmatter');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/adapter/claude-adoption.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 planClaudeAdoption**

使用 discovery 单源校验；对每个候选生成 entry。agent 比较目标文件内容；skill 比较 `SKILL.md` 并检测额外文件；unmanaged symlink 报 conflict；目标 escape 用 `resolveInside`/`assertParentInsideRoot` 检查。global 调用传 `agentsRoot=$HOME/.agents`、`claudeRoot=$HOME/.claude`。

- [ ] **Step 4: 运行 focused test 和完整测试**

Run: `pnpm vitest run test/adapter/claude-adoption.test.ts`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/adapter/claude-code/adoption.ts test/adapter/claude-adoption.test.ts
git commit -m "feat: plan Claude agent and skill adoption"
```

---

### Task 5: Claude 导入 apply、备份和 symlink

**Files:**
- Modify: `src/adapter/claude-code/adoption.ts`
- Test: `test/adapter/claude-adoption.test.ts`

**Interfaces:**
- Produces:
  - `export async function applyClaudeAdoption(input: { root: string; plan: ClaudeAdoptionPlan; backupRoot: string }): Promise<{ actions: string[]; backups: string[]; diagnostics: Diagnostic[] }>`

- [ ] **Step 1: 写失败测试**

```ts
it('copies an agent, backs up the original and creates a symlink', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n');
  const plan = await planClaudeAdoption({ root: project.root, scope: 'project', agentsRoot: project.agents, claudeRoot: project.claude });
  const applied = await applyClaudeAdoption({ root: project.root, plan, backupRoot: join(project.root, '.dab/backups/test') });
  expect(await readFile(join(project.root, '.agents/agents/reviewer.md'), 'utf8')).toContain('name: reviewer');
  expect(await readlink(join(project.root, '.claude/agents/reviewer.md'))).toBe('../../.agents/agents/reviewer.md');
  expect(applied.backups).toHaveLength(1);
  expect(await readFile(applied.backups[0]!, 'utf8')).toContain('Review.');
});

it('copies a skill directory and backs up the whole original', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, '.claude/skills/pdf-tools/SKILL.md', '---\nname: pdf-tools\ndescription: PDF.\n---\nPDF.\n');
  await writeProjectFile(project.root, '.claude/skills/pdf-tools/helper.txt', 'extra\n');
  const plan = await planClaudeAdoption({ root: project.root, scope: 'project', agentsRoot: project.agents, claudeRoot: project.claude });
  const applied = await applyClaudeAdoption({ root: project.root, plan, backupRoot: join(project.root, '.dab/backups/test') });
  expect(await readFile(join(project.root, '.agents/skills/pdf-tools/helper.txt'), 'utf8')).toBe('extra\n');
  expect(await readlink(join(project.root, '.claude/skills/pdf-tools'))).toBe('../../.agents/skills/pdf-tools');
  expect(applied.backups).toHaveLength(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/adapter/claude-adoption.test.ts`
Expected: FAIL，`applyClaudeAdoption` 不存在。

- [ ] **Step 3: 实现 apply**

对 `writeSource` 条目复制 agent 文件或整个 skill 目录（`cp`，拒绝逃逸 symlink）；对 `replaceTarget` 条目先 `backupPath`，再 `replaceSymlink`。备份失败中止，不替换。返回 actions/backups/diagnostics。

- [ ] **Step 4: 运行 focused test 和完整测试**

Run: `pnpm vitest run test/adapter/claude-adoption.test.ts`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/adapter/claude-code/adoption.ts test/adapter/claude-adoption.test.ts
git commit -m "feat: apply Claude adoption with backups"
```

---

### Task 6: Normalize minimal source adoption（project/global）

**Files:**
- Modify: `src/init/adoption.ts`
- Modify: `src/commands/normalize.ts`
- Test: `test/commands/normalize-adoption.test.ts`

**Interfaces:**
- Produces:
  - `export interface NormalizeAdoptionPreparation { sourceRoot: SourceRoot; phase: AdoptionPhase; manifest: ProjectManifest; paths: ProjectPaths; sourcePlan?: MinimalSourcePlan; diagnostics: Diagnostic[] }`
  - `export interface NormalizeAdoptionResult { phase: AdoptionPhase; sourcePlan?: MinimalSourcePlan; sourceActions: string[]; imports?: ClaudeAdoptionEntry[]; backups: string[]; diagnostics: Diagnostic[] }`
  - `export async function prepareNormalizeAdoption(input: { cwd: string; home: string; now?: Date }): Promise<NormalizeAdoptionPreparation>`
  - `export async function applyNormalizeAdoption(prep: NormalizeAdoptionPreparation, options: { dryRun: boolean; backupRoot: string }): Promise<{ actions: string[]; backups: string[]; diagnostics: Diagnostic[] }>`
- `normalizeProject` 在 `resolveSourceRoot` 前调用 preparation；uninitialized/partial 时使用 prep 的 manifest/paths，dry-run 不写，actual 写 minimal source 后继续现有 normalize。
- `NormalizeResult` 追加 `scope` 和 `adoption`（本任务只含 source plan/actions）。

- [ ] **Step 1: 写失败测试**

```ts
it('adopts a project with a missing manifest', async () => {
  const project = await makeProject();
  const result = await normalizeProject({ cwd: project.root, runner: goodRunner });
  expect(result.ok).toBe(true);
  expect(await lstatOrNull(join(project.root, 'AGENTS.md'))).not.toBeNull();
  expect(await lstatOrNull(join(project.root, 'dab.yaml'))).not.toBeNull();
  expect(await lstatOrNull(join(project.root, '.agents/agents'))).not.toBeNull();
  expect(result.adoption?.sourceActions.length).toBeGreaterThan(0);
});

it('adopts a completely uninitialized project', async () => {
  const root = await makeTempDir('dab-adopt-empty-');
  const result = await normalizeProject({ cwd: root, runner: goodRunner });
  expect(result.ok).toBe(true);
  expect(await lstatOrNull(join(root, 'AGENTS.md'))).not.toBeNull();
  expect(await lstatOrNull(join(root, 'dab.yaml'))).not.toBeNull();
});

it('does not write during adoption dry-run', async () => {
  const project = await makeProject();
  const result = await normalizeProject({ cwd: project.root, runner: goodRunner, dryRun: true });
  expect(result.ok).toBe(true);
  expect(await lstatOrNull(join(project.root, 'AGENTS.md'))).toBeNull();
  expect(result.adoption?.sourcePlan?.files['AGENTS.md']).toBeDefined();
});

it('does not overwrite an existing invalid manifest', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, 'dab.yaml', 'version: nope\n');
  await expect(normalizeProject({ cwd: project.root, runner: goodRunner })).rejects.toMatchObject({
    code: 'config.invalid',
  });
  expect(await readFile(join(project.root, 'dab.yaml'), 'utf8')).toBe('version: nope\n');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/commands/normalize-adoption.test.ts`
Expected: FAIL，无法在未初始化项目上运行。

- [ ] **Step 3: 实现 preparation 与 apply**

`prepareNormalizeAdoption` 用 `resolveAdoptionRoot`、`scanProject`、`minimalSourcePlan`；invalid manifest 时返回 error 且不覆盖。`normalizeProject` 在 source 缺失时使用 prep；dry-run 直接使用 prep manifest/paths 规划 adapter normalize（本任务可先只返回 source adoption；Task 7 补 import 和完整目标计划）。actual 写入 source 后加载 manifest 并继续。

- [ ] **Step 4: 运行 focused test 和完整测试**

Run: `pnpm vitest run test/commands/normalize-adoption.test.ts`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/init/adoption.ts src/commands/normalize.ts test/commands/normalize-adoption.test.ts
git commit -m "feat: adopt minimal DAB source during normalize"
```

---

### Task 7: Normalize import 集成与 all-or-nothing

**Files:**
- Modify: `src/init/adoption.ts`
- Modify: `src/commands/normalize.ts`
- Test: `test/commands/normalize-adoption.test.ts`

**Interfaces:**
- Extends `NormalizeAdoptionPreparation` with `claudePlan?: ClaudeAdoptionPlan`.
- `applyNormalizeAdoption` applies source writes, then Claude imports/backups/symlinks.
- `normalizeProject` plans imports for initialized and uninitialized/partial; preflights import diagnostics and target conflicts; invalid imports produce zero writes; other conflicts keep `.claude` untouched and report.
- `NormalizeResult.adoption` includes `imports` and `backups`.

- [ ] **Step 1: 写失败测试**

```ts
it('imports a Claude agent into .agents and replaces the target with a symlink', async () => {
  const project = await makeInitializedProject();
  await writeFile(join(project.root, '.claude/agents/extra.md'), '---\nname: extra\ndescription: Extra.\n---\nExtra.\n');
  const result = await normalizeProject({ cwd: project.root });
  expect(result.ok).toBe(true);
  expect(await readFile(join(project.root, '.agents/agents/extra.md'), 'utf8')).toContain('name: extra');
  expect(await readlink(join(project.root, '.claude/agents/extra.md'))).toBe('../../.agents/agents/extra.md');
  expect(result.adoption?.backups.length).toBe(1);
});

it('writes nothing when an import candidate is invalid', async () => {
  const project = await makeInitializedProject();
  await writeFile(join(project.root, '.claude/agents/bad.md'), '---\nname: bad\n---\n');
  const before = await readFile(join(project.root, '.claude/settings.json'), 'utf8');
  const result = await normalizeProject({ cwd: project.root });
  expect(result.ok).toBe(false);
  expect(await lstatOrNull(join(project.root, '.agents/agents/bad.md'))).toBeNull();
  expect(await readFile(join(project.root, '.claude/settings.json'), 'utf8')).toBe(before);
});

it('imports global agents and skills into a temp HOME', async () => {
  const fixture = await makeGlobalFixture();
  const home = fixture.home;
  const settings = '{"permissions":{}}\n';
  await writeProjectFile(home, '.claude/settings.json', settings);
  await writeProjectFile(home, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n');
  await writeProjectFile(home, '.claude/skills/pdf-tools/SKILL.md', '---\nname: pdf-tools\ndescription: PDF.\n---\nPDF.\n');
  const result = await normalizeProject({ cwd: join(home, '.agents'), home, runner: goodRunner });
  expect(result.ok).toBe(true);
  expect(await readFile(join(home, '.agents/agents/reviewer.md'), 'utf8')).toContain('name: reviewer');
  expect(await readFile(join(home, '.agents/skills/pdf-tools/SKILL.md'), 'utf8')).toContain('name: pdf-tools');
  expect(await readFile(join(home, '.claude/settings.json'), 'utf8')).toBe(settings);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/commands/normalize-adoption.test.ts`
Expected: FAIL，import 未接线。

- [ ] **Step 3: 实现 import 集成**

在 `prepareNormalizeAdoption` 中调用 `planClaudeAdoption`；在 `applyNormalizeAdoption` 中先写 source，再 `applyClaudeAdoption`。`normalizeProject` 在任何 `.claude` 写入前检查 `claudePlan.diagnostics` 和其他 target diagnostics；非法 import 零写入。初始化项目也运行 import plan。global 路径使用 `home`，不写真实 HOME。

- [ ] **Step 4: 运行 focused test 和完整测试**

Run: `pnpm vitest run test/commands/normalize-adoption.test.ts`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/init/adoption.ts src/commands/normalize.ts test/commands/normalize-adoption.test.ts
git commit -m "feat: import Claude agents and skills during normalize"
```

---

### Task 8: Detect checklist 构建

**Files:**
- Create: `src/detect/checklist.ts`
- Test: `test/detect/checklist.test.ts`

**Interfaces:**
- Produces:
  - `export type ChecklistStatus = 'ok' | 'missing' | 'warn' | 'error' | 'importable'`
  - `export interface ChecklistEntry { group: string; label: string; status: ChecklistStatus; detail?: string; file?: string; next?: string }`
  - `export interface Checklist { scope: Scope; root: string; profile?: string; phase: AdoptionPhase; entries: ChecklistEntry[]; score: { ok: number; total: number; percent: number }; nextActions: string[] }`
  - `export interface ChecklistInput { scope: Scope; root: string; profile?: string; phase: AdoptionPhase; entries: ChecklistEntry[] }`
  - `export function buildChecklist(input: ChecklistInput): Checklist`
  - `export function formatChecklist(checklist: Checklist): string`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/detect/checklist.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 checklist**

构建按 group 排序；score 仅统计 `ok`；`formatChecklist` 输出头部、分组、`[STATUS] label detail -> next`、score 和 next actions。不要在 checklist 模块写入文件。

- [ ] **Step 4: 运行 focused test**

Run: `pnpm vitest run test/detect/checklist.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/detect/checklist.ts test/detect/checklist.test.ts
git commit -m "feat: build detect checklists"
```

---

### Task 9: Detect preflight 与集成

**Files:**
- Create: `src/detect/preflight.ts`
- Modify: `src/commands/detect.ts`
- Test: `test/commands/detect-preflight.test.ts`
- Test: `test/commands/detect.test.ts`

**Interfaces:**
- Produces:
  - `export interface PreflightResult { sourceRoot: SourceRoot; phase: AdoptionPhase; entries: ChecklistEntry[]; diagnostics: Diagnostic[] }`
  - `export async function preflightProject(input: { cwd: string; home: string }): Promise<PreflightResult>`
- `DetectResult` 追加 `scope`、`root`、`phase`、`checklist`、`score`、`nextActions`；`detectProject` 在 source root 缺失/partial 时走 preflight，不抛 `config.source-root-missing`；已初始化时把现有 diagnostics/status 转成 checklist entries。

- [ ] **Step 1: 写失败测试**

```ts
it('prints a checklist for an uninitialized project instead of a source-root error', async () => {
  const project = await makeTempDir('dab-detect-preflight-');
  const code = await runDetect({ cwd: project, json: true, runner: goodRunner }, capture());
  expect(code).toBe(2);
  const payload = JSON.parse(captured);
  expect(payload.phase).toBe('uninitialized');
  expect(payload.scope).toBe('project');
  expect(payload.checklist).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'AGENTS.md', status: 'missing' })]));
  expect(payload.score.total).toBeGreaterThan(0);
});

it('marks importable Claude agents and skills', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n');
  await writeProjectFile(project.root, '.claude/skills/pdf-tools/SKILL.md', '---\nname: pdf-tools\ndescription: PDF.\n---\nPDF.\n');
  const payload = await detectJson(project);
  expect(payload.checklist.map((item) => item.status)).toContain('importable');
  expect(payload.nextActions).toContain('dab normalize --dry-run');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/commands/detect-preflight.test.ts`
Expected: FAIL，仍返回 `config.source-root-missing`。

- [ ] **Step 3: 实现 preflight 和 human/JSON**

`preflightProject` 用 `resolveAdoptionRoot`、`scanProject`、`minimalSourcePlan` 和 `planClaudeAdoption`（dry-run）构建 entries；不写文件。`detectProject` 在未初始化/partial 时使用 preflight，exit 2；已初始化时把现有 statuses/diagnostics 转成 entries，并保留原 JSON `targets`/`diagnostics`。`formatHuman` 改为 `formatChecklist`。

- [ ] **Step 4: 运行 focused test 和完整测试**

Run: `pnpm vitest run test/commands/detect-preflight.test.ts test/commands/detect.test.ts`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/detect/preflight.ts src/commands/detect.ts test/commands/detect-preflight.test.ts test/commands/detect.test.ts
git commit -m "feat: add detect preflight checklists"
```

---

### Task 10: 文档、changelog 和链接

**Files:**
- Modify: `docs/user/cli.md`、`docs/user/cli.zh.md`、`docs/user/cli.i18n.yaml`
- Modify: `docs/architecture.md`、`docs/architecture.zh.md`、`docs/architecture.i18n.yaml`
- Modify: `docs/user/claude-code.md`、`docs/user/claude-code.zh.md`、`docs/user/claude-code.i18n.yaml`
- Modify: `CHANGELOG.md`、`CHANGELOG.zh.md`、`CHANGELOG.i18n.yaml`
- Modify: `docs/superpowers/specs/2026-11-23-detect-normalize-adoption-design.md`
- Modify: `docs/superpowers/plans/README.md`

- [ ] **Step 1: 更新用户文档**

写明 `detect` checklist、`[MISSING]/[WARN]/[ERROR]/[IMPORTABLE]`、project/global scope、`normalize` 自动 adoption/import、备份、`~/.claude/settings.json`/`$HOME/.gitignore` 只读、JSON 新字段。

- [ ] **Step 2: 更新架构文档**

写明 per-entry symlink、import 的 ownership/backup/all-or-nothing、phase、global 规则、未覆盖的 rules/settings/hooks/instructions。

- [ ] **Step 3: 更新 changelog 和 spec/plan 链接**

在 `CHANGELOG` 增加 Unreleased 条目；spec 状态链接本计划；plans README 增加计划条目。

- [ ] **Step 4: 运行文档门禁**

Run: `pnpm run verify-translation-pairing --write`
Run: `pnpm doc-sync`
Expected: no issues。

- [ ] **Step 5: Commit**

```bash
git add docs CHANGELOG.md CHANGELOG.zh.md CHANGELOG.i18n.yaml
git commit -m "docs: document detect checklists and normalize adoption"
```

---

### Task 11: 最终验证

**Files:** none

- [ ] **Step 1: 运行 focused 和完整验证**

Run:
```bash
pnpm typecheck
pnpm test
pnpm doc-sync
node dist/cli.js detect --strict
node dist/cli.js normalize --dry-run
git diff --check
```
Expected: all clean；`detect --strict` 0 errors/warnings；`normalize --dry-run` no writes。

- [ ] **Step 2: 检查仓库自身不漂移**

Run: `node dist/cli.js normalize && git diff --exit-code`
Expected: no diff。

- [ ] **Step 3: 汇报**

汇总 changed files、tests、风险。不要 tag/release。

---

## Self-Review

- Spec coverage：detect checklist/preflight（Task 8/9）、project/global phase/root（Task 2）、minimal source（Task 3/6）、agents/skills import（Task 4/5/7）、备份（Task 5/7）、all-or-nothing（Task 7）、JSON/退出码（Task 7/9）、docs（Task 10）、验证（Task 11）。
- Type consistency：`AdoptionPhase`、`AdoptionRoot`、`MinimalSourcePlan`、`ClaudeAdoptionPlan`、`ChecklistEntry` 在 Task 2–9 复用；`validateAgentSource`/`validateSkillSource` 在 Task 1 定义，Task 4 使用。
- Review Focus 对应测试：root/phase（Task 2）、非法 import/冲突（Task 7）、同内容/额外文件（Task 4/5/7）、global 临时 HOME（Task 7）、all-or-nothing（Task 7）。
- 已知实现取舍：`normalize --dry-run` 在未初始化 scope 先展示 source/import/backup 计划；完整 generated target plan 在 source 写入后由现有 normalize 展示。目标 `.claude` 写入在预检后执行；source 副本幂等保留。
