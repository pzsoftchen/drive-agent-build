# Target Adapter Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 target root、instruction artifact 和 policy explanation 移入 `TargetAdapter` 契约，移除公共命令和公共检查中的 Claude Code 耦合，同时保持 Claude Code 行为、v2 manifest 和 global 行为不变。

**Architecture:** 公共命令只解析 scope/source/manifest、发现 facts、选择 enabled targets，然后通过 adapter 获取 layout、normalize plan、detect outcome 和 policy explanation。Claude adapter 继续拥有 `.claude` 路径、instructions/settings artifact、runtime、policy 编译和 hook 命令验证。新增一个测试用 fake adapter，证明第二个 provider 不需要修改公共命令。

**Tech Stack:** TypeScript ESM、Node `>=24.9`、pnpm 11.9.0、Vitest 5.1.0、`zod` 4.6.7、`yaml` 2.9.1。

**Spec:** `docs/superpowers/specs/2026-11-17-adapter-contract.md`

## Global Constraints

- Node `>=24.9`，TypeScript ESM，包管理器 `pnpm@11.9.0`。
- `AGENTS.md` 和 `.agents/` 是唯一编写源；`.claude/` 是生成目标，永不手工编辑。
- 不改变 agent、skill、rule、policy、hook 的 source 格式；不实现 Codex/DSH adapter。
- 保持 Claude Code 现有行为、v2 manifest 兼容、global settings/`$HOME/.gitignore` 只读行为。
- 所有 target path 必须位于 scope root 内，不允许绝对路径、`..`、symlink escape 或与 `.agents/` overlap。
- Adapter 只拥有映射、target layout、provider options、runtime 和 policy explanation；不拥有 agent/skill/rule 定义。
- 未托管 target path 是冲突；没有 `--fix` 不替换、不删除，`--fix` 必须先备份。
- 任一 target 预检失败时，normalize 不写任何 target。
- 每个任务先写失败测试，再实现；运行 focused test，再运行 `pnpm test`。
- 用户可见文档保持英中配对；`docs/superpowers/**` 默认中文单语，不参与配对。
- Commit message 使用 `feat:`、`refactor:`、`test:` 或 `docs:` 前缀，并以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

## 发布前缺口更新（2026-11-18）

本计划暂不执行；先发布 Claude-only v0.1.x。发布前已完成：

- `schemaVersion: 1` 已加入；`normalize` 包含 `root`，`init` 包含 `root`/`scopeRoot`，其余 JSON 路径相对它们；adapter 重构只追加字段。
- `src/core/platform.ts` 的公共平台守卫已覆盖 `normalize`、`init`、`detect` 和 `policy explain`。
- `normalize` 已通过 memoized runner 只执行一次 `claude --version`。

执行本计划时仍需补充：

- Modify `src/core/gitignore.ts`：由 adapter 提供 target-owned ignore entries，`normalize` 合并而非使用 Claude 专属常量。
- Modify `src/init/scanner.ts`：provider-owned init scan/inspect，移除公共层的 `hasClaudeSettings` 假设。
- Modify `src/commands/normalize.ts`、`detect.ts`：把剩余的 Claude-specific layout 与 payload 形状移入 adapter。
- 确定 provider-specific path 的长期位置，并保持 v2 `paths.claude` 可读。
- 验收增加：第二个 adapter 的 JSON 输出仍符合 `schemaVersion` 兼容规则。

## Review Focus

1. **Claude behavior parity**：layout 重构后，Claude 的 settings、instruction symlink、projection、generated records 和错误退出码必须与当前一致。
2. **Scope/path safety**：adapter 返回的 target root、settings/instructions/projection roots 必须经过 scope containment 和 source-overlap 检查；global target root 不得写入 `$HOME/.agents`。
3. **Second adapter without command edits**：fake adapter 必须能通过 registry 注入，normalize/detect/policy explain 不在公共命令中增加 provider 分支。
4. **Generated artifact compatibility**：v2 `generated.targets` 记录仍可读取；instruction path 由 adapter 校验，不再由 schema 固定 `.claude/CLAUDE.md`。
5. **Policy explanation compatibility**：Claude `policy explain` 的 JSON `effective` 字段和 human output 保持可用，同时由 adapter 生成 explanation；公共命令只透传 provider-owned payload。

## File Structure

**新增**

- `src/adapter/claude-code/layout.ts`：Claude `TargetLayout` 和路径校验。
- `src/adapter/claude-code/checks.ts`：从 `src/detect/checks.ts` 移入的 Claude-specific settings/instructions/projections/instruction-environment/agent-hook checks。
- `src/adapter/claude-code/policy-explain.ts`：Claude `explainPolicy`、sections 和 agent view。
- `src/adapter/claude-code/init.ts`：Claude init source files、target map 和 init inspection。
- `test/adapter/claude-layout.test.ts`
- `test/adapter/fake-target.test.ts`
- `test/architecture/adapter-boundary.test.ts`

**修改**

- `src/adapter/types.ts`：`TargetLayout`、`TargetLayoutInput`、`TargetPolicyExplanation`、`TargetPolicyInput`、扩展 `TargetAdapter`。
- `src/adapter/claude-code/adapter.ts`：`layout`、`validateHooks`、`explainPolicy`、layout 驱动的 normalize/detect。
- `src/adapter/registry.ts`：adapter registry 注入。
- `src/model/types.ts`：`ProjectPaths` 移除 `claude`；`GeneratedTarget.instructions.path` 改为 string。
- `src/model/project-manifest.ts`：`resolveProjectPaths` 不再返回 `claude`；adapter 读取 legacy `manifest.paths.claude`。
- `src/model/schemas.ts`：generated instructions path 改为 string；保留 v2 `paths.claude` 兼容字段。
- `src/commands/normalize.ts`：layout/source safety/target loop，移除 Claude imports；只追加 JSON 字段，保留 `schemaVersion` 兼容。
- `src/core/gitignore.ts`：改为 adapter-owned ignore entries。
- `src/init/scanner.ts`：provider-owned init scan/inspect。
- `src/commands/detect.ts`：layout/source safety、adapter label/status，移除 Claude checks。
- `src/commands/init.ts`：adapter layout/init files/target inspection，移除 Claude imports。
- `src/commands/policy-explain.ts`：adapter `explainPolicy`，移除 Claude compiler/options/version。
- `src/detect/checks.ts`：只保留 generic checks；Claude checks 移入 adapter。
- `src/init/templates.ts`：Claude-specific source templates 移入 Claude init support；公共模板改为 scope/target-neutral。
- `src/adapter/claude-code/instructions.ts`：接受 layout 的 instruction target/source，而非硬编码 `.claude/CLAUDE.md`。
- `src/adapter/claude-code/settings-plan.ts`：接受 layout settings path。
- `src/adapter/claude-code/projection.ts`：接受 layout projection roots。
- `test/model/manifest.test.ts`、`test/commands/*`、`test/adapter/*`：更新 ProjectPaths/路径断言；保留 Claude behavior parity 测试。
- `docs/architecture.md/.zh.md`、`docs/user/cli.md/.zh.md`、`docs/user/claude-code.md/.zh.md`：更新 adapter contract/用户文档。
- `docs/superpowers/specs/2026-11-17-adapter-contract.md`：状态改为 approved 并链接本计划。
- `docs/superpowers/plans/README.md`：计划状态。

---

### Task 1: Adapter layout contract 和 Claude layout

**Files:**
- Modify: `src/adapter/types.ts`
- Create: `src/adapter/claude-code/layout.ts`
- Modify: `src/adapter/claude-code/adapter.ts`
- Create: `test/adapter/claude-layout.test.ts`

**Interfaces:**
- Consumes: `ProjectManifest`、`TargetConfig`、`TargetProvider`、`ProjectPaths`、`TargetContext`。
- Produces:
  - `interface TargetLayout { provider; label; targetRoot; settingsPath?; instructionsPath; projectionRoots: { agents?; skills?; rules? } }`
  - `interface TargetLayoutInput { manifest: ProjectManifest; target: TargetConfig }`
  - `TargetAdapter.layout(input: TargetLayoutInput): TargetLayout`
  - `TargetAdapter.label: string`
  - `claudeTargetLayout(input: TargetLayoutInput): TargetLayout`
  - `assertTargetLayout(layout: TargetLayout): void`（校验 scope-relative、无绝对路径/`..`/`~`）

- [ ] **Step 1: 写失败测试**

`test/adapter/claude-layout.test.ts`：

```ts
it('describes the Claude target root and artifact paths', () => {
  const manifest = manifestFixture();
  const target = manifest.targets[0];
  const layout = claudeTargetLayout({ manifest, target });

  expect(layout).toEqual({
    provider: 'claude-code',
    label: 'claude',
    targetRoot: '.claude',
    settingsPath: '.claude/settings.json',
    instructionsPath: '.claude/CLAUDE.md',
    projectionRoots: {
      agents: '.claude/agents',
      skills: '.claude/skills',
      rules: '.claude/rules',
    },
  });
});

it('rejects an escaping target root', () => {
  const manifest = manifestFixture();
  manifest.paths.claude = '../outside';
  expect(() => claudeTargetLayout({ manifest, target: manifest.targets[0] }))
    .toThrow(/path/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/adapter/claude-layout.test.ts`
Expected: FAIL，`claudeTargetLayout`/`TargetLayout` 不存在。

- [ ] **Step 3: 实现 layout contract 和 Claude layout**

在 `src/adapter/types.ts` 增加 `TargetLayout`、`TargetLayoutInput`，给 `TargetAdapter` 增加 `readonly label: string` 和 `layout(input: TargetLayoutInput): TargetLayout`。`TargetContext` 暂时不变。

在 `src/adapter/claude-code/layout.ts`：

```ts
export function claudeTargetLayout(input: TargetLayoutInput): TargetLayout;
export function assertTargetLayout(layout: TargetLayout): void;
```

Claude layout 读取 `manifest.paths.claude`（v2 legacy input），生成 `.claude` 下的 settings/instructions/projection paths；所有 path 用 `assertRelativePath`/`joinPosix` 校验。

在 `claudeCodeAdapter` 增加 `label: 'claude'` 和 `layout: claudeTargetLayout`，保持 normalize/detect 不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run test/adapter/claude-layout.test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 typecheck 和完整测试**

Run: `pnpm typecheck && pnpm test`
Expected: clean；现有测试全部通过。

- [ ] **Step 6: Commit**

```bash
git add src/adapter/types.ts src/adapter/claude-code/layout.ts src/adapter/claude-code/adapter.ts test/adapter/claude-layout.test.ts
git commit -m "feat: add target adapter layout contract"
```

---

### Task 2: Normalize/detect 使用 adapter layout，移除 ProjectPaths.claude

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/model/project-manifest.ts`
- Modify: `src/adapter/types.ts`
- Modify: `src/commands/normalize.ts`
- Modify: `src/commands/detect.ts`
- Modify: `src/detect/checks.ts`
- Create: `src/adapter/claude-code/checks.ts`
- Modify: `src/adapter/claude-code/adapter.ts`
- Modify: `src/adapter/claude-code/instructions.ts`
- Modify: `src/adapter/claude-code/settings-plan.ts`
- Modify: `src/adapter/claude-code/projection.ts`
- Modify: `test/model/manifest.test.ts`
- Modify: `test/commands/normalize.test.ts`
- Modify: `test/commands/detect.test.ts`
- Modify: `test/adapter/instructions.test.ts`
- Modify: `test/adapter/projection.test.ts`
- Modify: `test/hardening.test.ts`

**Interfaces:**
- Consumes: Task 1 `TargetLayout`、`TargetLayoutInput`。
- Produces:
  - `ProjectPaths { root; scope; agents; manifest; instructions }`（不再有 `claude`）
  - `TargetContext { paths; layout: TargetLayout; manifest; target; facts; runner? }`
  - `TargetAdapter.validateHooks(input: TargetContext): Promise<Diagnostic[]>`
  - `assertSourceTreesSafe(root: string, layouts: readonly TargetLayout[]): Promise<void>`
  - `checkMemory(root, paths, layouts, now?)`
  - Claude-specific `checkSettings`、`checkInstructions`、`checkInstructionEnvironment`、`checkProjections`、`checkAgentHooks` 移入 `src/adapter/claude-code/checks.ts`。

- [ ] **Step 1: 写失败测试**

在 `test/model/manifest.test.ts` 更新 `ProjectPaths` 断言：

```ts
const paths = resolveProjectPaths(home, manifest);
expect(paths).toMatchObject({
  root: home,
  scope: 'global',
  agents: join(home, '.agents'),
  manifest: join(home, '.agents/dab.yaml'),
  instructions: join(home, '.agents/AGENTS.md'),
});
expect('claude' in paths).toBe(false);
```

在 `test/commands/normalize.test.ts` / `detect.test.ts` 保留现有 Claude parity 断言，但通过 `result.targets` 和 `layout` 路径检查，不直接依赖 `paths.claude`。新增：

```ts
it('uses the adapter layout for target safety checks', async () => {
  const project = await projectFixture();
  await mkdir(join(project.root, '.claude'), { recursive: true });
  const result = await normalizeProject({ cwd: project.root, runner: goodRunner });
  expect(result.ok).toBe(true);
  expect(result.targets[0]?.provider).toBe('claude-code');
});
```

（这个测试在 layout 接线后通过；物理 symlink escape 现有 hardening 测试必须继续覆盖。）

- [ ] **Step 2: 运行 focused tests 确认失败**

Run:
```bash
pnpm vitest run test/model/manifest.test.ts test/commands/normalize.test.ts test/commands/detect.test.ts test/hardening.test.ts
```
Expected: FAIL，`ProjectPaths` 仍含 `claude` 或 layout 未被使用。

- [ ] **Step 3: 实现 layout 驱动的公共路径和检查**

- `ProjectPaths` 移除 `claude`；`resolveProjectPaths` 只返回 `root`、`scope`、`agents`、`manifest`、`instructions`。
- `TargetContext` 增加 `layout: TargetLayout`。
- `TargetAdapter` 增加 `validateHooks(input: TargetContext): Promise<Diagnostic[]>`；Claude adapter 委托给 `src/adapter/claude-code/checks.ts` 的 `checkAgentHooks`（或等价函数）。
- 在公共 normalize/detect 中：
  - 对每个 enabled target 调用 `adapter.layout({ manifest, target })` 并校验 layout；不支持的 adapter 仍报 `target.unsupported`。
  - `assertSourceTreesSafe(root, layouts)` 检查 source root 与每个 target root/projection root 的 containment 和 disjoint。
  - 传入 adapter 的 `TargetContext.layout`。
  - 移除 `parseClaudeTargetOptions`、`discoverProjections`、`checkClaudeCode`、`.claude` 字面量；adapter normalize/detect 自己处理 provider runtime/projection。
- 将 Claude-specific checks 移到 `src/adapter/claude-code/checks.ts`：
  - `checkSettings(root, layout, generated, expected)`
  - `checkInstructions(root, paths, layout, mode, generated)`
  - `checkInstructionEnvironment(root, home, scope)`（Claude adapter detect 调用）
  - `checkProjections(root, layout, projections, generated)`
  - agent hook command validation / `checkAgentHooks`
- `src/detect/checks.ts` 保留 generic `checkSecrets`、`checkMemory`、`checkAgentsMdState`、`checkAgentHookIds`（如果仍是通用 ID 检查），不导入 Claude。
- `checkMemory` 接收 layouts；对 project scope 检查 `layout.targetRoot` 下的 `agent-memory`/`projects` 等；global scope 保持跳过。
- `instructions.ts`/`settings-plan.ts`/`projection.ts` 接受 layout 的 target/settings/projection paths；不再硬编码 `.claude`。
- `detect` 使用 adapter label/status，不保留 `TARGET_LABELS` 的 Claude branch。

- [ ] **Step 4: 运行 focused tests**

Run:
```bash
pnpm vitest run test/model/manifest.test.ts test/commands/normalize.test.ts test/commands/detect.test.ts test/adapter/instructions.test.ts test/adapter/projection.test.ts test/hardening.test.ts
```
Expected: PASS；现有 Claude 行为不变。

- [ ] **Step 5: 运行 typecheck 和完整测试**

Run: `pnpm typecheck && pnpm test`
Expected: clean；全绿。

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "refactor: drive normalize and detect from adapter layouts"
```

---

### Task 3: Init 使用 adapter layout/init support

**Files:**
- Modify: `src/adapter/types.ts`
- Modify: `src/adapter/claude-code/adapter.ts`
- Create: `src/adapter/claude-code/init.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/init/templates.ts`
- Modify: `src/init/scanner.ts`（仅类型/文案）
- Modify: `test/commands/init.test.ts`
- Modify: `test/commands/init-scope.test.ts`
- Modify: `test/hardening.test.ts`

**Interfaces:**
- Consumes: Task 1 layout、Task 2 `ProjectPaths`/generic checks。
- Produces:
  - `interface TargetInitInput { scopeRoot; scope; scan; manifest; target; layout: TargetLayout; paths: ProjectPaths }`
  - `TargetAdapter.initFiles(input: TargetInitInput): Record<string, string>`
  - `TargetAdapter.inspectInit(input: TargetInitInput): Promise<Diagnostic[]>`
  - Claude `initFiles` 返回 `.agents/adapters/claude-code.yaml` 和 Claude-specific `.agents/rules/generated-files.md`。
  - Claude `inspectInit` 检查 target settings/instruction pending，不改写；路径从 layout 获取。

- [ ] **Step 1: 写失败测试**

在 `test/commands/init.test.ts` 增加：

```ts
it('builds project init files through the Claude adapter without direct .claude template code', async () => {
  const root = await tempDir();
  await packageJson(root);
  const code = await runInit({ cwd: root, json: true, runner: goodRunner }, capture().io);
  expect(code).toBe(0);
  expect(await lstatOrNull(join(root, '.agents/adapters/claude-code.yaml'))).not.toBeNull();
  expect(await lstatOrNull(join(root, '.agents/rules/generated-files.md'))).not.toBeNull();
  expect(await readlink(join(root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');
});
```

在 `test/commands/init-scope.test.ts` 保留 global init/rules 断言；新增 `.agents/adapters/claude-code.yaml` 在 global 下存在。

- [ ] **Step 2: 运行 focused tests 确认失败**

Run: `pnpm vitest run test/commands/init.test.ts test/commands/init-scope.test.ts`
Expected: FAIL，adapter init support 不存在或公共 init 仍直接导入 Claude 模板。

- [ ] **Step 3: 实现 adapter init support**

- `TargetInitInput` 和 `initFiles`/`inspectInit` 加入 `TargetAdapter`；Claude adapter 实现。
- 把 `renderClaudeCodePolicy`、`renderGeneratedFilesRule` 从 `src/init/templates.ts` 移到 `src/adapter/claude-code/init.ts`；公共 `templateFiles` 只生成 scope-neutral source skeleton（`AGENTS.md`、`dab.yaml`、agents/skills/rules/policies/hooks/memory 的通用模板）。
- `initializeProject`：
  - 对每个 enabled target 调 `adapter.layout`，使用 layout 做 target root/settings/instructions safety。
  - 合并 `adapter.initFiles` 到模板文件。
  - 用 `adapter.inspectInit` 替换 `findGeneratedConflicts` 中的 Claude-specific settings/instruction 检查；generic projection conflict 用 layout projection roots。
  - `targetMap` 用 layout 的 projection roots，不再硬编码 `.claude/agents/...`。
  - 移除 `parseClaudeTargetOptions`、`discoverProjections`、`inspectInstructionTarget`、`.claude` 字面量。
- `renderAgentsMd` 使用 target-neutral 文案（“Generated target configuration”），不再写死 `.claude/`。
- 保持 project/global 文件布局和 v1 migration 不变。

- [ ] **Step 4: 运行 focused tests**

Run:
```bash
pnpm vitest run test/commands/init.test.ts test/commands/init-scope.test.ts test/hardening.test.ts
```
Expected: PASS。

- [ ] **Step 5: 运行 typecheck 和完整测试**

Run: `pnpm typecheck && pnpm test`
Expected: clean；全绿。

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "refactor: drive init through adapter layout and templates"
```

---

### Task 4: Generated instruction artifact 由 adapter 校验

**Files:**
- Modify: `src/model/schemas.ts`
- Modify: `src/model/types.ts`
- Modify: `src/adapter/claude-code/adapter.ts`
- Modify: `src/model/project-manifest.ts`（仅 migration/validation 断言）
- Modify: `test/model/manifest.test.ts`
- Modify: `test/adapter/claude-adapter.test.ts`
- Modify: `test/commands/normalize.test.ts`

**Interfaces:**
- Consumes: Task 1 layout、Task 2 normalize/detect。
- Produces:
  - `GeneratedTargetSchema.instructions.path: z.string().min(1)`（不再 literal `.claude/CLAUDE.md`）
  - Claude normalize/detect 校验 `generated.instructions.path === layout.instructionsPath`；不匹配时报 `generated.manifest-stale` 或 `generated.instructions-path`。
  - Claude generated record 使用 `layout.instructionsPath`。

- [ ] **Step 1: 写失败测试**

在 `test/model/manifest.test.ts` 增加：

```ts
it('accepts a provider-owned instruction path in v2 generated records', async () => {
  const root = await tempDir();
  await writeProjectFile(root, 'dab.yaml', v2Manifest);
  await writeProjectFile(root, 'dab.yaml', `${await readFile(join(root, 'dab.yaml'), 'utf8')}
generated:
  targets:
    - provider: claude-code
      instructions:
        path: .claude/CLAUDE.md
        mode: symlink
        sha256: ${'a'.repeat(64)}
      settings: null
      projections: []
`);
  const loaded = await loadProjectManifest(root, { scope: 'project' });
  expect(loaded.manifest.generated?.targets[0]?.instructions?.path).toBe('.claude/CLAUDE.md');
});
```

在 `test/adapter/claude-adapter.test.ts` 增加 layout path mismatch：

```ts
it('flags a generated instructions path that is not the adapter layout path', async () => {
  // manifest generated instructions.path: .codex/AGENTS.md
  // normalize/detect diagnostics include generated.instructions-path
});
```

（实现时用临时 fixture，避免依赖具体 helper 名称。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/model/manifest.test.ts test/adapter/claude-adapter.test.ts`
Expected: FAIL，schema 仍拒绝非 `.claude/CLAUDE.md` 路径。

- [ ] **Step 3: 实现 adapter-owned instruction path**

- `GeneratedTargetSchema.instructions.path` 改为 `z.string().min(1)`；保留 `mode` 和 `sha256` 校验。
- Claude adapter normalize/detect 校验 generated record path 等于 `layout.instructionsPath`；不匹配产生明确 diagnostic，不写文件。
- Claude normalize 使用 `layout.instructionsPath` 生成 record；actions 也使用 layout path。
- v1/v2 现有 manifest 记录保持可读；不需要 v3 migration。

- [ ] **Step 4: 运行 focused tests 和完整验证**

Run:
```bash
pnpm vitest run test/model/manifest.test.ts test/adapter/claude-adapter.test.ts test/commands/normalize.test.ts test/commands/detect.test.ts
pnpm test && pnpm typecheck
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "refactor: validate generated instruction artifacts in adapters"
```

---

### Task 5: Policy explanation 移入 adapter

**Files:**
- Modify: `src/adapter/types.ts`
- Modify: `src/adapter/claude-code/adapter.ts`
- Create: `src/adapter/claude-code/policy-explain.ts`
- Modify: `src/commands/policy-explain.ts`
- Modify: `test/commands/policy-explain.test.ts`
- Modify: `test/adapter/claude-adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 layout、Task 2 context、Task 4 generated record。
- Produces:
  - `interface TargetPolicySection { title: string; lines: string[] }`
  - `interface TargetPolicyExplanation { provider; runtime; effective: unknown; sections; sources; limitations; agent?: unknown; diagnostics }`
  - `interface TargetPolicyInput extends TargetContext { agent?: AgentDefinition }`
  - `TargetAdapter.explainPolicy(input: TargetPolicyInput): Promise<TargetPolicyExplanation>`
  - Claude `explainPolicy` 编译 policy、生成 sections/agent view；公共 command 只透传。
  - `PolicyExplainResult.effective: unknown`（Claude JSON 字段仍存在）。

- [ ] **Step 1: 写失败测试**

在 `test/adapter/claude-adapter.test.ts` 增加：

```ts
it('returns Claude policy explanation sections and effective payload', async () => {
  const project = await makeInitializedProject();
  const manifest = (await loadProjectManifest(project.root)).manifest;
  const paths = resolveProjectPaths(project.root, manifest);
  const target = getTarget(manifest, 'claude-code');
  const facts = await discoverSourceFacts(project.root, paths);
  const explanation = await claudeCodeAdapter.explainPolicy({
    paths,
    layout: claudeTargetLayout({ manifest, target }),
    manifest,
    target,
    facts,
    runner: goodRunner,
  });

  expect(explanation.provider).toBe('claude-code');
  expect(explanation.runtime.minimum).toBe('2.1.277');
  expect(explanation.effective).toMatchObject({ provider: 'claude-code' });
  expect(explanation.sections.map((section) => section.title)).toContain('Permissions');
});
```

在 `test/commands/policy-explain.test.ts` 保留现有 JSON/human 断言，并确认 `payload.effective.permissions` 仍在。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/adapter/claude-adapter.test.ts test/commands/policy-explain.test.ts`
Expected: FAIL，`explainPolicy`/新的 result contract 不存在。

- [ ] **Step 3: 实现 policy explanation adapter contract**

- 将 `EffectivePolicy`/`AgentPolicyView`/`compilePolicy` 的最终展示逻辑移入 `src/adapter/claude-code/policy-explain.ts`；Claude adapter `explainPolicy` 负责 parse options、discover?（facts 已提供）、compile、runtime、sections、sources、limitations、agent view。
- `sections` 至少输出 Permissions、Hooks (execution order)、Sources、Limitations、Agent（有 agent 时）；Claude JSON `effective` 保持当前字段。
- `policy-explain.ts` 只做 scope/manifest/target selection、facts discovery、adapter lookup、调用 `explainPolicy`、通用 human/JSON envelope 和 exit code。移除 `compilePolicy`、`parseClaudeTargetOptions`、`readClaudeVersion`、Claude `EffectivePolicy` 导入。
- Backend exit 4 仍由公共 result 的 `backend.version` 诊断映射。

- [ ] **Step 4: 运行 focused tests 和完整验证**

Run:
```bash
pnpm vitest run test/commands/policy-explain.test.ts test/adapter/claude-adapter.test.ts test/cli.test.ts
pnpm test && pnpm typecheck
```
Expected: PASS；现有 JSON/human 字段兼容。

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "refactor: move policy explanation into target adapters"
```

---

### Task 6: Fake adapter、registry injection 和 boundary test

**Files:**
- Modify: `src/adapter/registry.ts`
- Modify: `src/commands/normalize.ts`
- Modify: `src/commands/detect.ts`
- Modify: `src/commands/policy-explain.ts`
- Modify: `src/commands/init.ts`
- Create: `test/adapter/fake-target.test.ts`
- Create: `test/architecture/adapter-boundary.test.ts`
- Modify: `test/commands/normalize-targets.test.ts`
- Modify: `test/commands/detect-targets.test.ts`

**Interfaces:**
- Consumes: Task 1–5 adapter contract。
- Produces:
  - `getTargetAdapter(provider, adapters = DEFAULT_ADAPTERS): TargetAdapter | undefined`
  - `NormalizeOptions.adapters?: readonly TargetAdapter[]`，`DetectOptions`/`PolicyExplainOptions`/`InitOptions` 同样。
  - fake `codex` adapter with layout `.codex`, no-op normalize/detect/explain.
  - boundary test：公共 commands/checks/templates 不导入 `src/adapter/claude-code/*` 或 `.claude` 字面量。

- [ ] **Step 1: 写 fake adapter 失败测试**

`test/adapter/fake-target.test.ts`：

```ts
it('normalizes and detects a second provider through the registry without Claude', async () => {
  const project = await makeProjectWithCodexTarget();
  const codex = fakeCodexAdapter();
  const normalized = await normalizeProject({
    cwd: project.root,
    runner: goodRunner,
    adapters: [codex],
  });
  expect(normalized.ok).toBe(true);
  expect(normalized.targets[0]?.provider).toBe('codex');

  const detected = await detectProject({
    cwd: project.root,
    runner: goodRunner,
    adapters: [codex],
  });
  expect(detected.targets[0]?.provider).toBe('codex');
});
```

fake adapter 的 `layout` 返回 `.codex` 路径；normalize plan 返回 `settings: null`、`instructions: null`、`projections: []`，`apply` no-op；detect 返回一个 `native` status；explainPolicy 返回一个 section。fixture 中 manifest 只含 `codex` target。

`test/architecture/adapter-boundary.test.ts` 读取：
- `src/commands/normalize.ts`
- `src/commands/detect.ts`
- `src/commands/init.ts`
- `src/commands/policy-explain.ts`
- `src/detect/checks.ts`
- `src/init/templates.ts`

断言不包含 `adapter/claude-code` import，不包含 `.claude` 字面量（允许 `docs`/spec 不在此列表）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/adapter/fake-target.test.ts test/architecture/adapter-boundary.test.ts`
Expected: FAIL，registry injection/fake adapter 不存在或公共文件仍含 Claude 引用。

- [ ] **Step 3: 实现 registry injection 和 boundary cleanup**

- `registry.ts` 导出 `DEFAULT_ADAPTERS` 和 `getTargetAdapter(provider, adapters = DEFAULT_ADAPTERS)`；不要在公共命令中直接 import Claude adapter。
- 各 command options 增加 `adapters?: readonly TargetAdapter[]`；默认使用 `DEFAULT_ADAPTERS`。`init` 的 target 处理同样使用注入 registry。
- 更新 normalize/detect/policy-explain/init 的 adapter lookup。
- 移除公共文件 residual Claude imports/`.claude` 字面量；Claude label/paths/templates 只在 `src/adapter/claude-code/*`。
- 保持 `target.unsupported`、`target.none`、backend exit 4、all-or-nothing。

- [ ] **Step 4: 运行 focused tests**

Run:
```bash
pnpm vitest run test/adapter/fake-target.test.ts test/architecture/adapter-boundary.test.ts test/commands/normalize-targets.test.ts test/commands/detect-targets.test.ts test/commands/policy-explain.test.ts test/commands/init.test.ts
```
Expected: PASS。

- [ ] **Step 5: 运行 typecheck 和完整测试**

Run: `pnpm typecheck && pnpm test`
Expected: clean；全绿。

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "test: prove second adapter support without common command changes"
```

---

### Task 7: 文档、spec 状态和最终验证

**Files:**
- Modify: `docs/architecture.md`、`docs/architecture.zh.md`、`docs/architecture.i18n.yaml`
- Modify: `docs/user/cli.md`、`docs/user/cli.zh.md`、`docs/user/cli.i18n.yaml`
- Modify: `docs/user/claude-code.md`、`docs/user/claude-code.zh.md`、`docs/user/claude-code.i18n.yaml`
- Modify: `docs/development.md`、`docs/development.zh.md`、`docs/development.i18n.yaml`（如行为描述变化）
- Modify: `docs/superpowers/specs/2026-11-17-adapter-contract.md`
- Modify: `docs/superpowers/plans/README.md`
- Modify: `docs/superpowers/specs/2026-11-16-cross-harness-alignment.md`（补充后续计划链接）

**Interfaces:**
- Consumes: Task 1–6 的实现行为。
- Produces: 与实现一致的双语文档、approved spec 状态、计划索引和最终验证。

- [ ] **Step 1: 更新架构文档**

说明：
- `TargetAdapter` 的 `layout`、`validateHooks`、`normalize`、`detect`、`explainPolicy`。
- 公共 `ProjectPaths` 不再有 `claude`；Claude `.claude` 仅由 Claude adapter 拥有。
- generated instruction artifact path 由 adapter 校验。
- fake adapter 证明第二 provider 不需要改公共命令。
- 现有 Claude 行为、v2 manifest、global read-only 不变。

- [ ] **Step 2: 更新 CLI/Claude Code 文档**

- `normalize`/`detect` 的 per-target `targets` 和 adapter layout 语义。
- `policy explain` 的 provider-owned `effective` 与通用 sections。
- Claude instruction/settings paths 仍是 `.claude`，但由 adapter 提供。
- Agent hook/managed command 和 tool semantics 保持修正后的说明。

- [ ] **Step 3: 更新 spec 状态和计划索引**

- `docs/superpowers/specs/2026-11-17-adapter-contract.md` 状态改为 `已批准`，链接本计划。
- `docs/superpowers/plans/README.md` 把 adapter contract 计划标记为已实现/进行中。
- 在 cross-harness spec 的后续计划处加 adapter contract 链接（如适用）。

- [ ] **Step 4: 更新 pairing records 和 docs gates**

Run:
```bash
pnpm run verify-translation-pairing --write
pnpm doc-sync
```
Expected: no issues。

- [ ] **Step 5: 最终验证**

Run:
```bash
pnpm test
pnpm typecheck
pnpm doc-sync
pnpm build
node dist/cli.js normalize
node dist/cli.js detect
node dist/cli.js policy explain
```
Expected: tests/typecheck/doc-sync clean；本仓库 `dab.yaml` 和 `.claude` 状态不漂移；`dab detect` 0 errors（worktree 环境允许已知 ancestor warning）；policy explain 正常。

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs dab.yaml
git commit -m "docs: document target adapter contract"
```

---

## Self-Review

- Spec coverage：
  - Target layout：Task 1、2、3、6。
  - Instruction artifact：Task 4、6。
  - Policy explanation：Task 5、6。
  - Public command decoupling：Task 2、3、6。
  - Fake adapter/registry：Task 6。
  - v2 compatibility/global behavior：Task 2、3、4、7。
  - Docs：Task 7。
- Review Focus 对应测试：
  1. Claude parity：Task 2/3/5 保留现有 Claude tests；Task 4 path validation。
  2. Scope/path safety：Task 2 layout safety；Task 3 init safety；Task 6 fake layout containment。
  3. Second adapter：Task 6 fake adapter + boundary test。
  4. Generated artifact：Task 4 schema/Claude path validation。
  5. Policy compatibility：Task 5 existing JSON/human tests。
- Type consistency：
  - `TargetLayout` 在 Task 1 定义，Task 2–6 只消费。
  - `ProjectPaths` 在 Task 2 移除 `claude`，Task 3–6 不再使用 `paths.claude`。
  - `TargetAdapter` 方法在 Task 5/6 补齐；公共命令只调用接口。
  - `GeneratedTarget.instructions.path` 在 Task 4 变为 string，Claude adapter 校验 layout path。
