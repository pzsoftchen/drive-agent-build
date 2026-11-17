# 跨 Harness 对齐基础实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 在现有 Claude Code 集成之上建立跨 harness 的基础：按位置解析 project/global source root、迁移到 v2 manifest、引入 target adapter 接缝、实现 Claude Code 的 symlink-first instructions，并让所有 target 在写入前统一预检。

**架构:** 命令先用 `resolveSourceRoot` 解析 scope，再加载/迁移 v2 manifest，统一发现 `.agents` facts，然后按 `targets` 顺序调用 adapter。每个 adapter 返回可检查的 plan；只要任一 target 预检失败，就不写任何 target。本计划只实现 Claude adapter；Codex、DSH 和 global settings adoption/merge 是后续计划。

**技术栈:** TypeScript ESM、Node `>=24.9`、pnpm 11.9.0、Vitest 5.1.0、`zod` 4.6.7、`yaml` 2.9.1。

**Spec:** `docs/superpowers/specs/2026-11-16-cross-harness-alignment.md`

## 计划系列

这个 spec 覆盖多个独立子系统，按以下顺序拆分：

1. **本计划**：scope、manifest v2、target adapter 接缝、Claude Code alignment、ownership/failure semantics。
2. Codex adapter：先调研 project-local 与 user-global 配置面，再实现。
3. DSH adapter：同一 adapter 接口。
4. Global settings adoption/merge：在 spec 的 global settings open question 解决后实现。

本计划交付后，项目 scope 可以完整使用 v2 manifest 和 Claude target；global scope 可以解析 source root、初始化并投影 instructions/agents/skills/rules，但 `~/.claude/settings.json` 保持只读，不会被创建或替换。

## Global Constraints

- Node `>=24.9`，TypeScript ESM，包管理器 `pnpm@11.9.0`。
- `AGENTS.md` 和 `.agents/` 是唯一编写源；`.claude/` 是生成目标，永不手工编辑。
- 不增加 `dab global` 命令。`dab init [path]` 使用确切路径；其他命令按位置解析 root。
- Project scope 只写 `<repo>` 内；global scope 只写 `$HOME` 内，且 target 输出不写入 `$HOME/.agents`。
- Manifest v1 按 project scope 迁移；v1 出现在 global root 是错误。Manifest 的 `scope` 只校验位置，不覆盖位置。
- Native 格式优先 symlink；本计划不实现 `copy`。Claude agents/skills/rules 继续使用 symlink。
- 未托管 target path 是冲突；没有 `--fix` 不替换、不删除，`--fix` 必须先备份。
- 任一 target 预检失败时，normalize 不写任何 target。
- Global settings 在本计划中只读：不创建、不替换、不合并 `~/.claude/settings.json`。
- 用户可见文档保持英中配对；`docs/superpowers/**` 默认中文单语，不参与配对。
- 每个任务先写失败测试，再实现；运行 focused test，再运行 `pnpm test`。
- Commit message 使用 `feat:`、`refactor:`、`test:` 或 `docs:` 前缀，并以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

## Review Focus

1. **嵌套目录启动**：在项目子目录运行命令必须找到最近的 source root，而不是把 cwd 当 root；在 `~/.agents/skills/foo` 运行必须识别 global，而不能向上误用某个项目。
2. **Scope 不匹配**：manifest 的 `scope` 与位置不一致、或 v1 manifest 出现在 global root 时必须 fail loud，不能静默覆盖或降级。
3. **路径逃逸**：通过 symlink 的 `.claude` 或 target parent 写到 scope 外时，必须在任何写入前中止，包括临时 HOME。
4. **多 target 原子预检**：一个已配置 target 不支持或预检失败时，其他 target 也不能被写入。
5. **Home 所有权**：managed instruction symlink 必须被接受；未托管文件只有在 `--fix` 并备份后才可替换；global settings 必须保持字节不变。

## File Structure

**新增**

- `src/model/scope.ts`：`Scope`、`SourceRoot`、`resolveSourceRoot`、`assertInitRoot`。
- `src/model/facts.ts`：`SourceFacts`、`discoverSourceFacts`。
- `src/adapter/types.ts`：`TargetAdapter`、`TargetNormalizeInput`、`TargetNormalizePlan`、`TargetDetectOutcome`、`TargetFactStatus`。
- `src/adapter/registry.ts`：provider 到 adapter 的注册表。
- `src/adapter/claude-code/adapter.ts`：Claude `normalize`/`detect` 适配器。
- `src/adapter/claude-code/options.ts`：Claude target options 解析。
- `src/adapter/claude-code/instructions.ts`：instruction artifact 的 symlink/generated/disabled 计划与应用。
- `src/adapter/claude-code/settings-plan.ts`：从 `normalize.ts` 抽出的 settings plan/apply。
- `test/model/scope.test.ts`
- `test/model/facts.test.ts`
- `test/adapter/claude-adapter.test.ts`
- `test/adapter/instructions.test.ts`
- `test/commands/normalize-targets.test.ts`
- `test/commands/detect-targets.test.ts`
- `test/commands/init-scope.test.ts`
- `test/helpers/global.ts`

**修改**

- `src/model/schemas.ts`：v2 manifest、targets、per-target generated records、legacy v1 schema。
- `src/model/types.ts`：v2 types、`ProjectPaths` 增加 `scope`/`instructions`。
- `src/model/project-manifest.ts`：v1→v2 迁移、scope-aware load/save、target/generated helpers。
- `src/model/agents-md.ts`：检查 `paths.instructions`，不再硬编码 `AGENTS.md`。
- `src/detect/checks.ts`：使用 `paths.instructions` 和 per-target generated record。
- `src/adapter/claude-code/projection.ts`：接受已发现的 facts；shim 逻辑移入 `instructions.ts`。
- `src/commands/normalize.ts`：scope root、facts、adapter loop、per-target results、全量预检。
- `src/commands/detect.ts`：scope root、adapter loop、per-fact status。
- `src/commands/policy-explain.ts`：scope root、`--target` 选择。
- `src/commands/init.ts`：scope-aware init、v2 templates、global bootstrap、nested-source guard。
- `src/init/templates.ts`：v2 `dab.yaml`、project/global 文件布局。
- `src/cli.ts`：`policy explain --target`、help 文本。
- `test/helpers/initialized.ts`、`test/helpers/project.ts`：v2 fixtures。
- `dab.yaml`：本仓库自身迁移到 v2。
- `AGENTS.md`、`docs/architecture.md/.zh.md`、`docs/development.md/.zh.md`、`docs/user/cli.md/.zh.md`、`docs/user/claude-code.md/.zh.md`、`docs/roadmap.md/.zh.md`。

---

### Task 1: 按位置解析 source root

**Files:**
- Create: `src/model/scope.ts`
- Create: `test/model/scope.test.ts`

**Interfaces:**
- Consumes: `node:path`、`node:fs/promises`、`src/core/errors.ts`、`src/core/paths.ts`。
- Produces:
  - `type Scope = 'project' | 'global'`
  - `interface SourceRoot { scope: Scope; root: string; sourceRoot: string; manifest: string; instructions: string }`
  - `resolveSourceRoot(options: { cwd: string; home: string }): Promise<SourceRoot>`
  - `assertInitRoot(options: { root: string; home: string }): Promise<Scope>`

- [ ] **Step 1: 写失败测试**

在 `test/model/scope.test.ts` 覆盖以下断言：

```ts
it('finds the nearest project root from a nested directory', async () => {
  const home = await makeTempDir('dab-scope-home-');
  const root = join(home, 'repo');
  await mkdir(join(root, '.agents/skills/doc-sync'), { recursive: true });
  await writeFile(join(root, 'dab.yaml'), 'version: 2\n');

  const resolved = await resolveSourceRoot({
    cwd: join(root, '.agents/skills/doc-sync'),
    home,
  });

  expect(resolved).toEqual({
    scope: 'project',
    root,
    sourceRoot: join(root, '.agents'),
    manifest: join(root, 'dab.yaml'),
    instructions: join(root, 'AGENTS.md'),
  });
});

it('uses the global root only at or below $HOME/.agents', async () => {
  const home = await makeTempDir('dab-scope-home-');
  await mkdir(join(home, '.agents/skills'), { recursive: true });

  const exact = await resolveSourceRoot({ cwd: join(home, '.agents'), home });
  const nested = await resolveSourceRoot({ cwd: join(home, '.agents/skills'), home });
  const other = await resolveSourceRoot({ cwd: home, home }).catch((error) => error);

  expect(exact.scope).toBe('global');
  expect(nested).toMatchObject({
    scope: 'global',
    root: home,
    sourceRoot: join(home, '.agents'),
    manifest: join(home, '.agents/dab.yaml'),
    instructions: join(home, '.agents/AGENTS.md'),
  });
  expect(other).toMatchObject({ code: 'config.source-root-missing' });
});

it('recognizes a symlinked global source root', async () => {
  const home = await makeTempDir('dab-scope-home-');
  const real = join(home, 'dot-agents-real');
  await mkdir(join(real, 'skills'), { recursive: true });
  await symlink(real, join(home, '.agents'), 'dir');

  const resolved = await resolveSourceRoot({ cwd: join(real, 'skills'), home });

  expect(resolved.scope).toBe('global');
  expect(resolved.sourceRoot).toBe(join(home, '.agents'));
});

it('rejects init inside an existing project or global source root', async () => {
  const home = await makeTempDir('dab-scope-home-');
  const project = join(home, 'repo');
  await mkdir(join(project, '.agents/skills/new'), { recursive: true });
  await writeFile(join(project, 'dab.yaml'), 'version: 2\n');
  await mkdir(join(home, '.agents/skills/new'), { recursive: true });

  await expect(assertInitRoot({ root: join(project, '.agents/skills/new'), home }))
    .rejects.toMatchObject({ code: 'config.source-root-nested' });
  await expect(assertInitRoot({ root: join(home, '.agents/skills/new'), home }))
    .rejects.toMatchObject({ code: 'config.source-root-nested' });
  await expect(assertInitRoot({ root: home, home }))
    .rejects.toMatchObject({ code: 'config.source-root-nested' });
  await expect(assertInitRoot({ root: project, home })).resolves.toBe('project');
  await expect(assertInitRoot({ root: join(home, '.agents'), home })).resolves.toBe('global');
});
```

注意 `project = join(home, 'repo')`，home 下同时有 global `.agents`；`assertInitRoot({ root: project, home })` 必须允许，不能把 `home/.agents` 当成父项目。

同时确认 Home 例外：

```ts
it('does not treat $HOME with only .agents as a project root', async () => {
  const home = await makeTempDir('dab-scope-home-');
  await mkdir(join(home, '.agents'), { recursive: true });

  await expect(resolveSourceRoot({ cwd: home, home }))
    .rejects.toMatchObject({ code: 'config.source-root-missing' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/model/scope.test.ts`
Expected: FAIL，`Cannot find module '../../src/model/scope.ts'` 或导出不存在。

- [ ] **Step 3: 实现 `resolveSourceRoot` 和 `assertInitRoot`**

实现规则：

- 先把 `cwd`、`home` 解析为绝对路径。
- 如果 `home/.agents` 存在，取其 `realpath`；若 `cwd` 的 `realpath` 等于该目录或位于其下，返回 global：
  - `root = resolve(home)`
  - `sourceRoot = join(root, '.agents')`
  - `manifest = join(sourceRoot, 'dab.yaml')`
  - `instructions = join(sourceRoot, 'AGENTS.md')`
- 否则从 `cwd` 向上逐级查找同时识别 `dab.yaml` 或 `.agents/` 的最近目录；找到后返回 project：
  - `root = found`
  - `sourceRoot = join(found, '.agents')`
  - `manifest = join(found, 'dab.yaml')`
  - `instructions = join(found, 'AGENTS.md')`
- **Home 例外**：向上查找时，如果候选目录等于 `home` 且只有 `.agents/`、没有 `dab.yaml`，不要把它当成 project root；继续向上。否则在 `$HOME` 直接运行命令会被误判为 project scope。
- 找不到时抛出 `ConfigError('no dab.yaml or .agents directory found from <cwd>', 'config.source-root-missing', { hint: 'Run "dab init" in the project root or "dab init ~/.agents" for global scope.' })`。
- `assertInitRoot`：
  - 若 `root` 等于 real global source root，返回 `'global'`。
  - 若 `root` 位于 real global source root 内但不相等，抛出 `ConfigError(..., 'config.source-root-nested')`。
  - 若 `root` 等于 `home` 且 `home/.agents` 存在，抛出 `ConfigError('refusing to initialize project scope at $HOME while ~/.agents is the global source root', 'config.source-root-nested', { hint: 'Run dab init ~/.agents for global scope.' })`。
  - 从 `root` 的父目录向上检查：
    - 如果候选目录等于 `home` 且只有 `.agents/`、没有 `dab.yaml`，跳过它（`~/.agents` 是 global source，不是父项目）。
    - 其他候选目录若存在 `dab.yaml` 或 `.agents/`，抛出 `config.source-root-nested`。
  - 否则返回 `'project'`。
- 对存在的路径使用 `realpath`；不存在时使用 `resolve`。不要吞掉 ENOENT 以外的错误。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run test/model/scope.test.ts`
Expected: PASS，4 tests passed。

- [ ] **Step 5: 运行完整测试**

Run: `pnpm test`
Expected: 现有测试全部通过；新增 4 tests passed。

- [ ] **Step 6: Commit**

```bash
git add src/model/scope.ts test/model/scope.test.ts
git commit -m "feat: resolve project and global source roots"
```

---

### Task 2: Manifest v2、迁移和 scope-aware paths

**Files:**
- Modify: `src/model/schemas.ts`
- Modify: `src/model/types.ts`
- Modify: `src/model/project-manifest.ts`
- Modify: `src/model/agents-md.ts`
- Modify: `src/detect/checks.ts`
- Modify: `src/commands/normalize.ts`
- Modify: `src/commands/detect.ts`
- Modify: `src/commands/policy-explain.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/init/templates.ts`
- Modify: `src/adapter/claude-code/policy-compile.ts`（仅类型）
- Modify: `test/model/manifest.test.ts`
- Modify: `test/helpers/initialized.ts`
- Modify: `test/helpers/project.ts`
- Modify: `test/commands/normalize.test.ts`
- Modify: `test/commands/detect.test.ts`
- Modify: `test/commands/init.test.ts`
- Modify: `test/commands/policy-explain.test.ts`
- Modify: `test/adapter/projection.test.ts`
- Modify: `test/hardening.test.ts`

**Interfaces:**
- Consumes: `Scope`、`SourceRoot` from `src/model/scope.ts`。
- Produces:
  - `TARGET_PROVIDERS`、`TargetProvider`
  - `TargetConfigSchema`、`TargetConfig`
  - `GeneratedTargetSchema`、`GeneratedTarget`
  - `GeneratedManifestSchema = z.object({ targets: z.array(GeneratedTargetSchema) })`
  - `ProjectManifestSchema`（`version: 2`、`scope`、`targets`）
  - `LegacyProjectManifestSchema`（`version: 1`）
  - `loadProjectManifest(root, options?: { scope?: Scope }): Promise<LoadedProjectManifest>`
  - `getTarget(manifest, provider): TargetConfig | undefined`
  - `getEnabledTargets(manifest): TargetConfig[]`
  - `getGeneratedTarget(manifest, provider): GeneratedTarget | undefined`
  - `resolveProjectPaths(root, manifest): ProjectPaths`
  - `ProjectPaths { root; scope; agents; claude; manifest; instructions }`
  - `checkAgentsMd(scopeRoot: string, instructions: string, maxLines?: number): Promise<AgentsMdCheck>`
  - `checkAgentsMdState(scopeRoot: string, paths: ProjectPaths): Promise<Diagnostic[]>`

- [ ] **Step 1: 写 v2 manifest 失败测试**

在 `test/model/manifest.test.ts` 增加：

```ts
const v2Manifest = `version: 2
scope: project
project:
  id: demo
  name: Demo
profile: feature
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: generated
paths:
  agents: .agents
  claude: .claude
`;

it('loads a v2 manifest with targets and a per-target generated record', async () => {
  const root = await tempDir();
  await writeProjectFile(root, 'dab.yaml', v2Manifest);

  const loaded = await loadProjectManifest(root, { scope: 'project' });

  expect(loaded.manifest.version).toBe(2);
  expect(loaded.manifest.scope).toBe('project');
  expect(loaded.manifest.targets[0]).toMatchObject({
    provider: 'claude-code',
    enabled: true,
    options: { minVersion: '2.1.277', instructions: 'generated' },
  });
  expect(loaded.legacy).toBe(false);
});

it('migrates a v1 project manifest in memory and maps the shim to generated instructions', async () => {
  const root = await tempDir();
  await writeProjectFile(root, 'dab.yaml', validManifest);

  const loaded = await loadProjectManifest(root, { scope: 'project' });

  expect(loaded.legacy).toBe(true);
  expect(loaded.manifest.version).toBe(2);
  expect(loaded.manifest.targets).toEqual([
    {
      provider: 'claude-code',
      enabled: true,
      options: { minVersion: '2.1.277', instructions: 'generated' },
    },
  ]);
});

it('rejects a v1 manifest at the global root and a scope mismatch', async () => {
  const home = await tempDir();
  await mkdir(join(home, '.agents'), { recursive: true });
  await writeProjectFile(home, '.agents/dab.yaml', validManifest);

  await expect(loadProjectManifest(home, { scope: 'global' }))
    .rejects.toMatchObject({ code: 'config.manifest-legacy-global' });

  const project = await tempDir();
  await writeProjectFile(
    project,
    'dab.yaml',
    v2Manifest.replace('scope: project', 'scope: global'),
  );
  await expect(loadProjectManifest(project, { scope: 'project' }))
    .rejects.toMatchObject({ code: 'config.scope-mismatch' });
});

it('rejects duplicate target providers', async () => {
  const root = await tempDir();
  await writeProjectFile(
    root,
    'dab.yaml',
    v2Manifest.replace(
      '  - provider: claude-code\n    enabled: true\n    options:\n      minVersion: 2.1.277\n      instructions: generated\n',
      '  - provider: claude-code\n  - provider: claude-code\n',
    ),
  );

  await expect(loadProjectManifest(root, { scope: 'project' }))
    .rejects.toMatchObject({ code: 'config.duplicate-target' });
});
```

在 `test/model/manifest.test.ts` 同时增加 global paths 断言：

```ts
it('resolves global manifest and instruction paths inside $HOME/.agents', async () => {
  const home = await tempDir();
  await mkdir(join(home, '.agents'), { recursive: true });
  const manifest = {
    version: 2 as const,
    scope: 'global' as const,
    project: { id: 'demo', name: 'Demo' },
    profile: 'feature' as const,
    targets: [{
      provider: 'claude-code' as const,
      enabled: true,
      options: { minVersion: '2.1.277', instructions: 'generated' },
    }],
    paths: { agents: '.agents', claude: '.claude' },
  };

  const paths = resolveProjectPaths(home, manifest);

  expect(paths).toMatchObject({
    root: home,
    scope: 'global',
    agents: join(home, '.agents'),
    claude: join(home, '.claude'),
    manifest: join(home, '.agents/dab.yaml'),
    instructions: join(home, '.agents/AGENTS.md'),
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/model/manifest.test.ts`
Expected: FAIL，v2 schema、`legacy`、scope mismatch 或 global paths 不存在。

- [ ] **Step 3: 实现 v2 schema 和 types**

在 `src/model/schemas.ts` 增加：

```ts
export const TARGET_PROVIDERS = ['claude-code', 'codex', 'dsh'] as const;

export const TargetConfigSchema = z
  .object({
    provider: z.enum(TARGET_PROVIDERS),
    enabled: z.boolean().default(true),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const GeneratedTargetSchema = z
  .object({
    provider: z.enum(TARGET_PROVIDERS),
    settings: z
      .object({ path: z.string().min(1), sha256: z.string().regex(SHA256_HEX) })
      .strict()
      .nullable()
      .default(null),
    instructions: z
      .object({
        path: z.literal('.claude/CLAUDE.md'),
        mode: z.enum(['symlink', 'generated']),
        sha256: z.string().regex(SHA256_HEX),
      })
      .strict()
      .nullable()
      .default(null),
    projections: z.array(ProjectionSchema).default([]),
  })
  .strict();

export const GeneratedManifestSchema = z
  .object({ targets: z.array(GeneratedTargetSchema) })
  .strict();

export const ProjectManifestSchema = z
  .object({
    version: z.literal(2),
    scope: z.enum(['project', 'global']),
    project: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        goal: z.string().min(1).optional(),
      })
      .strict(),
    profile: z.literal('feature'),
    targets: z.array(TargetConfigSchema).min(1),
    paths: z
      .object({
        agents: z.string().min(1).default('.agents'),
        claude: z.string().min(1).default('.claude'),
      })
      .strict()
      .default({ agents: '.agents', claude: '.claude' }),
    generated: GeneratedManifestSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const target of value.targets) {
      if (seen.has(target.provider)) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets'],
          message: `duplicate target provider: ${target.provider}`,
        });
      }
      seen.add(target.provider);
    }
  });
```

保留 v1 schema 为 `LegacyProjectManifestSchema`，字段照旧。

在 `src/model/types.ts` 增加 v2 类型、`ProjectPaths` 字段：

```ts
export type TargetProvider = z.infer<typeof TargetConfigSchema>['provider'];
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type GeneratedTarget = z.infer<typeof GeneratedTargetSchema>;
export interface ProjectPaths {
  root: string;
  scope: 'project' | 'global';
  agents: string;
  claude: string;
  manifest: string;
  instructions: string;
}
```

- [ ] **Step 4: 实现迁移、scope-aware load/save 和 helpers**

在 `src/model/project-manifest.ts`：

- `LoadedProjectManifest` 增加 `legacy: boolean`、`scope: Scope`。
- `manifestPath(root, scope)`：project 为 `root/dab.yaml`，global 为 `root/.agents/dab.yaml`。
- `loadProjectManifest(root, options?: { scope?: Scope })`：
  - 默认 scope 为 `'project'`。
  - 使用 `manifestPath` 读取文件；缺失错误 hint 分别指向 `dab init` 或 `dab init ~/.agents`。
  - 先按 `version` 区分 v1/v2。
  - v1 + global → `ConfigError(..., 'config.manifest-legacy-global')`。
  - v1 + project → `migrateV1Manifest`，返回 `legacy: true`。
  - v2 → 校验 `parsed.scope === scope`；不一致抛 `config.scope-mismatch`。
  - 捕获 zod 的 `targets` duplicate issue，转为 `config.duplicate-target`。
- `migrateV1Manifest` 映射：
  - `targets: [{ provider: 'claude-code', enabled: true, options: { minVersion, instructions: claudeMdShim ? 'generated' : 'disabled' } }]`
  - `generated` 映射为 `{ targets: [{ provider: 'claude-code', settings, instructions: instructions ? { ...instructions, mode: 'generated' } : null, projections }] }`
- `resolveProjectPaths(root, manifest)`：
  - `agents = resolveInside(root, manifest.paths.agents)`
  - `claude = resolveInside(root, manifest.paths.claude)`
  - global：`manifest = join(root, '.agents/dab.yaml')`、`instructions = join(root, '.agents/AGENTS.md')`
  - project：`manifest = join(root, 'dab.yaml')`、`instructions = join(root, 'AGENTS.md')`
  - `root` 是 scope root。
- `updateGeneratedManifest(root, generated, options?: { scope?: Scope })`：
  - 加载 manifest；若 `legacy`，先用 `migrateDocumentToV2` 把 document 的 `version`/`scope`/`targets`/`generated` 写为 v2，并删除 `target`。
  - 设置 `generated`，保存。保留文档顶部的注释。
- `getTarget`、`getEnabledTargets`、`getGeneratedTarget`。

- [ ] **Step 5: 让命令使用 scope root 和 v2 字段**

修改 `src/commands/normalize.ts`、`detect.ts`、`policy-explain.ts`、`init.ts`：

- Options 增加 `home?: string`；默认 `homedir()`。
- `normalize`、`detect`、`policy explain` 用 `resolveSourceRoot({ cwd: resolve(options.cwd), home })` 得到 `SourceRoot`，不要再用 `resolve(options.cwd)` 当 root；`init` 继续使用自己的 exact-path `resolveRoot`，global init 在 Task 6 完成。
- 用 `loadProjectManifest(sourceRoot.root, { scope: sourceRoot.scope })`。
- 用 `resolveProjectPaths(sourceRoot.root, manifest)`；所有 target path/source 相对 path 都以 `paths.root` 为基准。
- 把 `checkAgentsMd(root)` 改为 `checkAgentsMd(scopeRoot, paths.instructions, maxLines)`；`checkAgentsMdState(scopeRoot, paths)`、`checkSecrets(scopeRoot, paths)` 读取 `paths.instructions`。相对链接从 `dirname(paths.instructions)` 解析。
- `normalize.ts`/`detect.ts` 暂时用 `getTarget(manifest, 'claude-code')`；缺失时抛 `ConfigError('manifest has no claude-code target', 'target.claude-missing')`。这一步只是过渡，Task 4 会改为 adapter registry。
- Claude options 先解析 `minVersion` 和 `instructions` 的中断版本：
  ```ts
  type InterimClaudeOptions = { minVersion: string; instructions: 'generated' | 'disabled' };
  function parseInterimClaudeOptions(target: TargetConfig): InterimClaudeOptions
  ```
  未知 option 抛 `target.invalid-options`。
- `normalize.ts` 的 generated 写入改为：
  ```ts
  const generated = {
    targets: [{
      provider: 'claude-code',
      settings: { path: '.claude/settings.json', sha256: sha256(settingsContent) },
      instructions: enabled ? { path: '.claude/CLAUDE.md', mode: 'generated', sha256: sha256(renderClaudeMdShim()) } : null,
      projections: discovered.projections,
    }],
  };
  ```
- `detect/checks.ts` 的 `checkSettings`、`checkShim`、`checkProjections` 通过 `getGeneratedTarget(manifest, 'claude-code')` 读取记录。
- `init/templates.ts` 的 `renderDabYaml` 输出 v2 project manifest；`instructions: 'generated'` 暂时保留现有 shim 行为，Task 5 改为 symlink 默认。Task 2 仍只支持 project 模板布局；`templateFiles` 的 scope 参数在 Task 6 加入。
- `init.ts` 的 `existingManifest` 使用 `loadProjectManifest(sourceRoot.root, { scope: sourceRoot.scope })`；manifest 路径使用 `paths.manifest`。

- [ ] **Step 6: 更新 fixtures 和现有测试**

- `test/helpers/initialized.ts` 改为写 v2 manifest，`scope: project`、`targets`、`options.instructions: generated`。
- 保留至少一个 v1 manifest 字符串在 `test/model/manifest.test.ts` 专门测迁移。
- 更新所有 `manifest.target.claudeMdShim`、`manifest.generated?.settings`、`manifest.generated?.instructions`、`manifest.generated?.projections` 的断言，改用 `getTarget`/`getGeneratedTarget`。
- `test/adapter/projection.test.ts` 的 `manifest()` helper 返回 v2。
- `test/hardening.test.ts` 中自定义 manifest 替换逻辑改为 v2 字段。
- 更新 `dab.yaml` 自身：Task 结束时运行 `node dist/cli.js normalize`，确认 `dab.yaml` 变为 v2 且 `node dist/cli.js detect` 无错误。

- [ ] **Step 7: 运行 focused tests**

Run:
```bash
pnpm vitest run test/model/manifest.test.ts test/commands/normalize.test.ts test/commands/detect.test.ts test/commands/init.test.ts test/commands/policy-explain.test.ts test/adapter/projection.test.ts test/hardening.test.ts
```
Expected: PASS。若失败，先修迁移和 generated record 的字段，不要削弱断言。

- [ ] **Step 8: 运行完整测试和 typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean。

- [ ] **Step 9: Commit**

```bash
git add src test dab.yaml
git commit -m "feat: migrate manifests to v2 with scoped targets"
```

---

### Task 3: Source facts、adapter 接口和 Claude adapter

**Files:**
- Create: `src/model/facts.ts`
- Create: `src/adapter/types.ts`
- Create: `src/adapter/registry.ts`
- Create: `src/adapter/claude-code/adapter.ts`
- Create: `src/adapter/claude-code/options.ts`
- Create: `src/adapter/claude-code/settings-plan.ts`
- Create: `test/model/facts.test.ts`
- Create: `test/adapter/claude-adapter.test.ts`
- Modify: `src/adapter/claude-code/projection.ts`
- Modify: `src/commands/normalize.ts`（暂时仍单 target，但改为使用 adapter plan）
- Modify: `src/commands/detect.ts`（暂时仍单 target，但改为使用 adapter detect）
- Modify: `src/detect/checks.ts`

**Interfaces:**
- Consumes: Task 1 的 `Scope`、Task 2 的 manifest types、现有 `discoverAgents`/`discoverSkills`/`discoverRules`/`discoverHooks`/`loadPolicySources`/`discoverProjections`/`compilePolicy`/`renderSettings`。
- Produces:
  - `interface SourceFacts { agents: DiscoveryResult<AgentDefinition>; skills: DiscoveryResult<SkillDefinition>; rules: DiscoveryResult<RuleDefinition>; hooks: DiscoveryResult<LoadedHook>; policies: LoadedPolicySources }`
  - `discoverSourceFacts(root: string, paths: ProjectPaths): Promise<SourceFacts>`
  - `interface TargetNormalizeInput extends TargetContext { fix: boolean; dryRun: boolean; now?: Date }`
  - `interface TargetAdapter { readonly provider: TargetProvider; normalize(input: TargetNormalizeInput): Promise<TargetNormalizePlan>; detect(input: TargetContext): Promise<TargetDetectOutcome> }`
  - `interface TargetNormalizePlan { provider; diagnostics; actions: string[]; generated: GeneratedTarget; settings?: { path; sha256; changed }; instructions?: { path; mode; action; sha256 }; apply(options: { backupRoot: string }): Promise<{ applied: number; backups: string[] }> }`
  - `interface TargetContext { paths; manifest; target; facts; runner? }`
  - `interface TargetDetectOutcome { provider; diagnostics; statuses: TargetFactStatus[] }`
  - `interface TargetFactStatus { kind: 'instructions'|'agent'|'skill'|'rule'|'policy'|'hook'; name: string; status: 'native'|'mapped'|'generated'|'unsupported'|'not-applicable'|'missing'; detail?: string }`
  - `getTargetAdapter(provider: TargetProvider): TargetAdapter | undefined`
  - `parseClaudeTargetOptions(target: TargetConfig): { minVersion: string; instructions: 'generated'|'disabled' }`（Task 5 扩展为包含 `symlink`）

- [ ] **Step 1: 写 facts 和 adapter 失败测试**

`test/model/facts.test.ts`：

```ts
it('discovers agents, skills, rules, hooks and policies once', async () => {
  const project = await makeInitializedProject();

  const facts = await discoverSourceFacts(project.root, {
    root: project.root,
    scope: 'project',
    agents: join(project.root, '.agents'),
    claude: join(project.root, '.claude'),
    manifest: join(project.root, 'dab.yaml'),
    instructions: join(project.root, 'AGENTS.md'),
  });

  expect(facts.agents.items.map((item) => item.name)).toContain('reviewer');
  expect(facts.skills.items.map((item) => item.name)).toContain('doc-sync');
  expect(facts.rules.items.map((item) => item.name)).toContain('testing');
  expect(facts.hooks.items.map((item) => item.spec.id)).toContain('protect-generated');
  expect(facts.policies.project.version).toBe(1);
  expect(facts.policies.adapter.provider).toBe('claude-code');
});
```

`test/adapter/claude-adapter.test.ts`：

```ts
it('plans Claude settings, generated instructions and symlink projections', async () => {
  const project = await makeInitializedProject();
  const manifest = (await loadProjectManifest(project.root)).manifest;
  const paths = resolveProjectPaths(project.root, manifest);
  const target = getTarget(manifest, 'claude-code');
  if (target === undefined) throw new Error('missing target');
  const facts = await discoverSourceFacts(project.root, paths);

  const plan = await claudeCodeAdapter.normalize({
    paths,
    manifest,
    target,
    facts,
    fix: false,
    dryRun: true,
  });

  expect(plan.diagnostics).toEqual([]);
  expect(plan.generated.provider).toBe('claude-code');
  expect(plan.generated.settings?.path).toBe('.claude/settings.json');
  expect(plan.generated.instructions?.mode).toBe('generated');
  expect(plan.generated.projections.map((item) => item.target)).toEqual([
    '.claude/agents/reviewer.md',
    '.claude/skills/doc-sync',
    '.claude/rules/testing.md',
  ]);
});

it('returns per-fact statuses for detect', async () => {
  const project = await makeInitializedProject();
  const manifest = (await loadProjectManifest(project.root)).manifest;
  const paths = resolveProjectPaths(project.root, manifest);
  const target = getTarget(manifest, 'claude-code');
  if (target === undefined) throw new Error('missing target');
  const facts = await discoverSourceFacts(project.root, paths);

  const outcome = await claudeCodeAdapter.detect({ paths, manifest, target, facts });

  expect(outcome.statuses).toEqual(expect.arrayContaining([
    { kind: 'instructions', name: 'CLAUDE.md', status: 'generated' },
    { kind: 'agent', name: 'reviewer', status: 'native' },
    { kind: 'skill', name: 'doc-sync', status: 'native' },
    { kind: 'rule', name: 'testing', status: 'native' },
    { kind: 'policy', name: 'project', status: 'mapped' },
  ]));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/model/facts.test.ts test/adapter/claude-adapter.test.ts`
Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现 `discoverSourceFacts`**

`src/model/facts.ts` 调用现有 discovery，把 diagnostics 合并到一个数组；`loadPolicySources` 的 `DabError` 继续保持抛出，由命令层处理。返回：

```ts
export interface SourceFacts {
  agents: DiscoveryResult<AgentDefinition>;
  skills: DiscoveryResult<SkillDefinition>;
  rules: DiscoveryResult<RuleDefinition>;
  hooks: DiscoveryResult<LoadedHook>;
  policies: LoadedPolicySources;
}

export async function discoverSourceFacts(
  root: string,
  paths: ProjectPaths,
): Promise<SourceFacts>;
```

不要把 adapter 特定逻辑放进这个文件。

- [ ] **Step 4: 让 `discoverProjections` 接受已发现的 facts**

在 `src/adapter/claude-code/projection.ts`：

```ts
export interface ProjectionSources {
  agents: readonly AgentDefinition[];
  skills: readonly SkillDefinition[];
  rules: readonly RuleDefinition[];
}

export async function discoverProjections(
  root: string,
  paths: ProjectPaths,
  sources?: ProjectionSources,
): Promise<ProjectionDiscovery>;
```

当 `sources` 存在时不再调用 `discoverAgents`/`discoverSkills`/`discoverRules`；诊断只来自 hashing 和 duplicate target。现有测试调用不带 `sources` 时行为不变。

- [ ] **Step 5: 抽出 settings plan/apply**

把 `normalize.ts` 中的 `SettingsPlan`、`planSettings`、`applySettings` 移到 `src/adapter/claude-code/settings-plan.ts`，导出：

```ts
export interface SettingsPlan {
  action: 'none' | 'create' | 'backup-and-write';
  path: string;
  sha256: string;
  changed: boolean;
  conflict?: Diagnostic;
}

export async function planSettings(
  root: string,
  generated: GeneratedTarget | undefined,
  expected: string,
): Promise<SettingsPlan>;

export async function applySettings(
  root: string,
  plan: SettingsPlan,
  expected: string,
  backupRoot: string,
): Promise<string[]>;
```

`generated` 是该 target 的记录，不再传整个 manifest。

同时把 `src/adapter/claude-code/projection.ts` 中的 `planClaudeMdShim` 改成 target 记录驱动：

```ts
export async function planClaudeMdShim(
  root: string,
  options: { enabled: boolean; generated?: GeneratedTarget; fix?: boolean },
): Promise<ClaudeMdPlan>;
```

`applyClaudeMdShim` 保持现有的 backup/apply 行为；Task 5 会用 `instructions.ts` 替换这两个函数。

- [ ] **Step 6: 实现 Claude options 和 adapter**

`src/adapter/claude-code/options.ts`：

```ts
export const ClaudeCodeTargetOptionsSchema = z
  .object({
    minVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('2.1.277'),
    instructions: z.enum(['generated', 'disabled']).default('generated'),
  })
  .strict();

export type ClaudeCodeTargetOptions = z.infer<typeof ClaudeCodeTargetOptionsSchema>;

export function parseClaudeTargetOptions(target: TargetConfig): ClaudeCodeTargetOptions;
```

未知字段抛 `ConfigError('invalid claude-code target options: ...', 'target.invalid-options')`。Task 5 会把 `instructions` 枚举扩展为 `symlink | generated | disabled` 并把默认值改为 `symlink`。

`src/adapter/claude-code/adapter.ts`：

```ts
export const claudeCodeAdapter: TargetAdapter = {
  provider: 'claude-code',
  async normalize(input) { /* runtime + settings + instructions + projections */ },
  async detect(input) { /* runtime + settings + instructions + projections + statuses */ },
};
```

`normalize` 必须：

- 用 `parseClaudeTargetOptions(input.target)`。
- 调用 `checkClaudeCode(options.minVersion, input.runner)`；若存在 `backend.version` error，返回带 error 的 plan，且不生成可应用 actions。
- 调用 `discoverProjections(input.paths.root, input.paths, {
  agents: input.facts.agents.items,
  skills: input.facts.skills.items,
  rules: input.facts.rules.items,
})`。
- 调用 `compilePolicy(input.facts.policies.project, input.facts.policies.adapter, input.facts.hooks.items)`。
- 调用 `renderSettings(compiled.effective)`。
- 调用 `planSettings(input.paths.root, getGeneratedTarget(input.manifest, 'claude-code'), settingsContent)`。
- 调用 `planClaudeMdShim(input.paths.root, { enabled: options.instructions !== 'disabled', generated: getGeneratedTarget(input.manifest, 'claude-code'), fix: input.fix })`。
- 调用 `planProjectionActions(input.paths.root, discovered.projections, getGeneratedTarget(...), { fix: input.fix })`。
- 把 conflicts 映射为 diagnostics；`--fix` 时沿用 `withFixWarning` 行为。
- `generated` 填 settings/instructions/projections；instructions mode 固定 `'generated'`（Task 5 改为按 options）。
- `apply` 闭包按顺序调用 `applyProjectionActions`、`applyClaudeMdShim`、`applySettings`，返回 `{ applied, backups }`。

`detect` 必须：

- 调用 `checkClaudeCode`、`checkSettings`、`checkShim`、`checkProjections`。
- 同一个 target 的 diagnostics 去重。
- `statuses` 按 facts 生成：instructions `generated`；agents/skills/rules `native`；policy/hook `mapped`。如果某个 fact 在 projections 中缺失，状态为 `missing`。

- [ ] **Step 7: 暂时让 normalize/detect 调用 adapter，但仍只处理 Claude**

`normalize.ts`：

- 保留现有 common checks，但把 Claude-specific plan 调用替换为 `claudeCodeAdapter.normalize(...)`。
- 用 `getTarget(manifest, 'claude-code')`；缺失时 `ConfigError('target.claude-missing')`。
- 结果仍可保留顶层 `settings`/`shimAction`/`actions` 兼容字段。
- `detect.ts` 用 `claudeCodeAdapter.detect(...)` 替换 Claude-specific checks。

- [ ] **Step 8: 运行 focused tests**

Run:
```bash
pnpm vitest run test/model/facts.test.ts test/adapter/claude-adapter.test.ts test/commands/normalize.test.ts test/commands/detect.test.ts test/adapter/projection.test.ts test/hardening.test.ts
```
Expected: PASS。

- [ ] **Step 9: 运行完整测试和 typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean。

- [ ] **Step 10: Commit**

```bash
git add src test
git commit -m "refactor: introduce source facts and Claude target adapter"
```

---

### Task 4: 多 target normalize、detect 和 policy explain

**Files:**
- Modify: `src/commands/normalize.ts`
- Modify: `src/commands/detect.ts`
- Modify: `src/commands/policy-explain.ts`
- Modify: `src/cli.ts`
- Modify: `src/adapter/registry.ts`
- Modify: `test/commands/normalize-targets.test.ts`（新建）
- Modify: `test/commands/detect-targets.test.ts`（新建）
- Modify: `test/commands/policy-explain.test.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/commands/normalize.test.ts`
- Modify: `test/commands/detect.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `TargetAdapter`、`getTargetAdapter`、`SourceFacts`、`TargetNormalizePlan`、`TargetDetectOutcome`。
- Produces:
  - `NormalizeResult.targets: TargetNormalizeResult[]`
  - `NormalizeResult.actions: string[]`（替代 `ProjectionAction[]`；`formatHuman` 直接输出字符串）
  - `NormalizeResult.shimAction: string`（兼容字段，取 Claude instructions action 的字符串）
  - `TargetNormalizeResult { provider: TargetProvider; actions: string[]; settings?: { path: string; sha256: string; changed: boolean }; instructions?: { path: string; mode: string; action: string; sha256: string }; backups: string[] }`
  - `DetectResult.targets: TargetDetectOutcome[]`
  - `PolicyExplainResult.target: TargetProvider`
  - `PolicyExplainOptions.target?: TargetProvider`
  - CLI `dab policy explain [--agent <name>] [--target <provider>] [--json]`

- [ ] **Step 1: 写多 target 失败测试**

`test/commands/normalize-targets.test.ts`：

```ts
it('blocks every target when a configured target has no adapter', async () => {
  const project = await projectFixture();
  const text = await readFile(join(project.root, 'dab.yaml'), 'utf8');
  await writeFile(
    join(project.root, 'dab.yaml'),
    text.replace(
      '  - provider: claude-code\n    enabled: true\n',
      '  - provider: claude-code\n    enabled: true\n  - provider: codex\n    enabled: true\n',
    ),
  );

  const result = await normalizeProject({ cwd: project.root });

  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((item) => item.code)).toContain('target.unsupported');
  expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
  expect(await lstatOrNull(join(project.root, '.claude/agents/reviewer.md'))).toBeNull();
});

it('applies all configured Claude targets only after every plan is clean', async () => {
  const project = await projectFixture();
  const result = await normalizeProject({ cwd: project.root, dryRun: true });

  expect(result.targets.map((item) => item.provider)).toEqual(['claude-code']);
  expect(result.targets[0]?.settings?.path).toBe('.claude/settings.json');
});

it('rejects a manifest with no enabled target', async () => {
  const project = await projectFixture();
  const path = join(project.root, 'dab.yaml');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('enabled: true', 'enabled: false'));

  const result = await normalizeProject({ cwd: project.root });

  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((item) => item.code)).toContain('target.none');
  expect(await lstatOrNull(join(project.root, '.claude/settings.json'))).toBeNull();
});
```

`test/commands/detect-targets.test.ts`：

```ts
it('reports per-fact target status for a clean Claude project', async () => {
  const project = await makeInitializedProject();
  const result = await detectProject({ cwd: project.root, runner: goodRunner, home: dirname(project.root) });

  expect(result.targets).toHaveLength(1);
  expect(result.targets[0]?.statuses).toEqual(expect.arrayContaining([
    { kind: 'agent', name: 'reviewer', status: 'native' },
    { kind: 'skill', name: 'doc-sync', status: 'native' },
    { kind: 'rule', name: 'testing', status: 'native' },
    { kind: 'policy', name: 'project', status: 'mapped' },
  ]));
});

it('fails detect when a configured target has no adapter', async () => {
  const project = await makeInitializedProject();
  const text = await readFile(join(project.root, 'dab.yaml'), 'utf8');
  await writeFile(
    join(project.root, 'dab.yaml'),
    text.replace(
      '  - provider: claude-code\n    enabled: true\n',
      '  - provider: claude-code\n    enabled: true\n  - provider: codex\n    enabled: true\n',
    ),
  );

  const result = await detectProject({ cwd: project.root, runner: goodRunner, home: dirname(project.root) });

  expect(result.exitCode).toBe(3);
  expect(result.diagnostics.map((item) => item.code)).toContain('target.unsupported');
});
```

`test/commands/policy-explain.test.ts`：

```ts
it('selects a configured target and rejects an unsupported one', async () => {
  const project = await makeInitializedProject();
  const claude = await explainPolicy({ cwd: project.root, target: 'claude-code' });
  expect(claude.target).toBe('claude-code');

  await expect(explainPolicy({ cwd: project.root, target: 'dsh' }))
    .rejects.toMatchObject({ code: 'target.not-configured' });

  const text = await readFile(join(project.root, 'dab.yaml'), 'utf8');
  await writeFile(
    join(project.root, 'dab.yaml'),
    text.replace(
      '  - provider: claude-code\n    enabled: true\n',
      '  - provider: claude-code\n    enabled: true\n  - provider: codex\n    enabled: true\n',
    ),
  );
  await expect(explainPolicy({ cwd: project.root, target: 'codex' }))
    .rejects.toMatchObject({ code: 'target.unsupported' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/commands/normalize-targets.test.ts test/commands/detect-targets.test.ts test/commands/policy-explain.test.ts`
Expected: FAIL，`targets`、`target.unsupported` 或 `target` 选择不存在。

- [ ] **Step 3: 实现 normalize 的 adapter loop**

`normalizeProject`：

- 保持 source safety、facts discovery、hook/agent ID、secrets、AGENTS.md 检查在 adapter 调用之前。
- 若 `getEnabledTargets(manifest).length === 0`，push 一个 error：
  ```ts
  { code: 'target.none', severity: 'error', file: 'dab.yaml',
    message: 'manifest has no enabled targets',
    hint: 'Enable at least one target or omit it from the manifest.' }
  ```
  然后返回 blocked result，不写任何 target。
- `const plans: TargetNormalizePlan[] = []`。
- 遍历 `getEnabledTargets(manifest)`：
  - `const adapter = getTargetAdapter(target.provider)`。
  - 若 `adapter === undefined`，push diagnostic：
    ```ts
    { code: 'target.unsupported', severity: 'error', file: 'dab.yaml',
      message: `no adapter is available for target ${target.provider}`,
      hint: 'Remove or disable the target until its adapter is implemented.' }
    ```
  - 否则 `await adapter.normalize({ paths, manifest, target, facts, fix, dryRun, runner, now })`，收集 plan diagnostics。
- 如果 `hasErrors(diagnostics)`，返回 blocked result，`targets` 为空，不写任何文件。
- dry-run 返回 `targets`（包含 plan 信息），不写。
- 写阶段：按 plans 顺序调用 `plan.apply({ backupRoot })`；合并 backups。
- `generated = { targets: plans.map((plan) => plan.generated) }`，调用 `updateGeneratedManifest(paths.root, generated, { scope: paths.scope })`。
- `NormalizeResult.targets` 每项：
  ```ts
  {
    provider: plan.provider,
    actions: plan.actions,
    settings: plan.settings,
    instructions: plan.instructions,
    backups: applyResult.backups,
  }
  ```
- 顶层 `actions` 改为 `targets.flatMap((item) => item.actions)`；`shimAction` 从第一个 Claude plan 的 `instructions.action` 映射为字符串；`settings`、`backups` 同样从 Claude plan 映射。删除 `describeAction` 对 `ProjectionAction` 的依赖。在 `docs/user/cli.md` 说明新代码应读 `targets`。

- [ ] **Step 4: 实现 detect 的 adapter loop 和 status 输出**

`detectProject`：

- 公共检查后遍历 enabled targets；若没有 enabled target，push `target.none` error；无 adapter 时 push `target.unsupported`。
- 每个 adapter 的 `detect` 返回 diagnostics + statuses。
- `DetectResult.targets` 保存每个 outcome。
- `generated` 记录检查改为 per-target：每个 enabled target 必须有一个 generated record；缺失 push `generated.missing`。
- 人类可读输出在 diagnostics 后增加：
  ```text
  agent reviewer: claude=native
  skill doc-sync: claude=native
  rule testing: claude=native
  instructions CLAUDE.md: claude=generated
  policy project: claude=mapped
  ```
  格式由 `formatStatuses(targets)` 生成；只列 enabled target。
- JSON 输出包含 `targets`。

- [ ] **Step 5: 实现 policy explain target 选择和 CLI flag**

- `PolicyExplainOptions` 增加 `target?: TargetProvider`。
- `explainPolicy` 用 `resolveSourceRoot`、`loadProjectManifest`。
- 选择 target：显式 `options.target`，否则第一个 enabled target；没有 enabled target 抛 `ConfigError('manifest has no enabled targets', 'target.none')`。
- 如果显式 target 不在 manifest 中，抛 `ConfigError('target is not configured', 'target.not-configured')`。
- 如果 target 已配置但不是 `claude-code`，抛 `ConfigError('no adapter is available for target <provider>', 'target.unsupported')`。
- `PolicyExplainResult` 增加 `target`。
- `runPolicyExplain`/`formatHuman` 输出 `Target: <provider>`。
- `src/cli.ts` 的 `dispatchPolicy`：
  - help/usage 增加 `--target <provider>`。
  - `rejectUnknownOptions(args, ['--agent', '--target'])`。
  - `takeOption(args, '--target')` 必须是 `TARGET_PROVIDERS` 之一；否则抛 `UsageError('unknown target: ...', 'usage.invalid-target')`。
  - 传给 `runPolicyExplain`；不影响 `--agent` 的行为。

- [ ] **Step 6: 更新现有 normalize/detect 断言**

- 现有测试的 `result.settings`、`result.shimAction` 仍应存在；新增 `result.targets` 断言。
- `detect` 人类输出测试如果断言完整文本，加入新的 status 行；如果只断言 diagnostics，不需要改。
- `test/cli.test.ts` 的 help 测试增加 `--target`。

- [ ] **Step 7: 运行 focused tests**

Run:
```bash
pnpm vitest run test/commands/normalize-targets.test.ts test/commands/detect-targets.test.ts test/commands/normalize.test.ts test/commands/detect.test.ts test/commands/policy-explain.test.ts test/cli.test.ts
```
Expected: PASS。

- [ ] **Step 8: 运行完整测试和 typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean。

- [ ] **Step 9: Commit**

```bash
git add src test
git commit -m "feat: normalize and detect every configured target"
```

---

### Task 5: Symlink-first instructions、ownership 和 global settings 只读

**Files:**
- Create: `src/adapter/claude-code/instructions.ts`
- Create: `test/adapter/instructions.test.ts`
- Create: `test/helpers/global.ts`
- Modify: `src/adapter/claude-code/adapter.ts`
- Modify: `src/adapter/claude-code/options.ts`
- Modify: `src/adapter/claude-code/projection.ts`
- Modify: `src/adapter/claude-code/settings-plan.ts`
- Modify: `src/commands/normalize.ts`
- Modify: `src/commands/detect.ts`
- Modify: `src/detect/checks.ts`
- Modify: `src/commands/init.ts`（仅 pending 检测）
- Modify: `test/commands/normalize.test.ts`
- Modify: `test/commands/detect.test.ts`
- Modify: `test/commands/init.test.ts`
- Modify: `test/hardening.test.ts`
- Modify: `test/adapter/projection.test.ts`

**Interfaces:**
- Consumes: Task 3/4 的 adapter、generated target、`ProjectPaths`。
- Produces:
  - `type InstructionMode = 'symlink' | 'generated' | 'disabled'`
  - `interface InstructionPlan { action: 'none'|'create'|'repair'|'remove'|'backup-and-repair'|'backup-and-remove'; mode: InstructionMode; path: '.claude/CLAUDE.md'; sha256?: string; conflict?: Diagnostic }`
  - `planInstructions(input: { root: string; paths: ProjectPaths; mode: InstructionMode; generated?: GeneratedTarget; fix?: boolean }): Promise<InstructionPlan>`
  - `applyInstructions(root: string, plan: InstructionPlan, backupRoot?: string): Promise<string[]>`
  - `inspectInstructionTarget(root: string, paths: ProjectPaths, expectedMode: InstructionMode, generated?: GeneratedTarget): Promise<Diagnostic | undefined>`
  - `renderClaudeMdShim(importPath?: string): string`
  - Claude options `instructions` 默认 `'symlink'`，枚举包含 `'symlink'`。

- [ ] **Step 1: 写 instructions 失败测试**

`test/adapter/instructions.test.ts` 先定义一个测试 helper：

```ts
function projectPaths(root: string, scope: 'project' | 'global'): ProjectPaths {
  return resolveProjectPaths(root, {
    version: 2,
    scope,
    project: { id: 'demo', name: 'Demo' },
    profile: 'feature',
    targets: [{
      provider: 'claude-code',
      enabled: true,
      options: { minVersion: '2.1.277', instructions: 'symlink' },
    }],
    paths: { agents: '.agents', claude: '.claude' },
  });
}
```

同时创建 `test/helpers/global.ts`，供 Task 5/6 使用：

```ts
export interface GlobalFixture {
  home: string;
  agents: string;
  claude: string;
}

export async function makeGlobalFixture(): Promise<GlobalFixture> {
  const home = await makeTempDir('dab-home-');
  const agents = join(home, '.agents');
  for (const dir of ['agents', 'skills', 'rules', 'hooks', 'memory', 'policies', 'adapters']) {
    await mkdir(join(agents, dir), { recursive: true });
  }
  await writeProjectFile(home, '.agents/AGENTS.md', '# Global instructions\n');
  await writeProjectFile(home, '.agents/dab.yaml', `version: 2
scope: global
project:
  id: global
  name: Global
profile: feature
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
`);
  await writeProjectFile(home, '.agents/policies/project.yaml', 'version: 1\n');
  await writeProjectFile(home, '.agents/adapters/claude-code.yaml', 'version: 1\nprovider: claude-code\n');
  await writeProjectFile(
    home,
    '.agents/agents/reviewer.md',
    '---\nname: reviewer\ndescription: Reviews changes.\n---\nReview.\n',
  );
  await writeProjectFile(
    home,
    '.agents/skills/doc-sync/SKILL.md',
    '---\nname: doc-sync\ndescription: Keeps docs paired.\n---\nSync docs.\n',
  );
  await writeProjectFile(home, '.agents/rules/testing.md', 'Run tests.\n');
  await writeProjectFile(
    home,
    '.agents/hooks/protect-generated/hook.yaml',
    'id: protect-generated\nevent: pre_tool\nmatcher: Edit|Write\nentry: run.mjs\nrunner: node\ntimeout: 10\norder: 10\n',
  );
  await writeProjectFile(home, '.agents/hooks/protect-generated/run.mjs', 'process.exit(0);\n');
  await writeProjectFile(home, '.agents/memory/INDEX.md', '# Memory\n');
  return { home, agents, claude: join(home, '.claude') };
}
```

`test/adapter/instructions.test.ts` 的主体：

```ts
it('creates a project instruction symlink to AGENTS.md', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, 'AGENTS.md', '# Project\n');
  const paths = projectPaths(project.root, 'project');

  const plan = await planInstructions({
    root: project.root,
    paths,
    mode: 'symlink',
  });
  await applyInstructions(project.root, plan);

  expect(await readlink(join(project.root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');
});

it('creates a global instruction symlink to .agents/AGENTS.md', async () => {
  const home = await makeTempDir('dab-instructions-home-');
  await mkdir(join(home, '.agents'), { recursive: true });
  await writeProjectFile(home, '.agents/AGENTS.md', '# Global\n');
  const paths = projectPaths(home, 'global');

  const plan = await planInstructions({ root: home, paths, mode: 'symlink' });
  await applyInstructions(home, plan);

  expect(await readlink(join(home, '.claude/CLAUDE.md'))).toBe('../.agents/AGENTS.md');
});

it('accepts a managed symlink and flags a broken one', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, 'AGENTS.md', '# Project\n');
  const paths = projectPaths(project.root, 'project');
  const plan = await planInstructions({ root: project.root, paths, mode: 'symlink' });
  await applyInstructions(project.root, plan);

  expect(await planInstructions({ root: project.root, paths, mode: 'symlink' }))
    .toMatchObject({ action: 'none' });

  await rm(join(project.root, '.claude/CLAUDE.md'));
  await symlink('missing.md', join(project.root, '.claude/CLAUDE.md'));
  expect((await planInstructions({ root: project.root, paths, mode: 'symlink' })).conflict?.code)
    .toBe('claude-md.unmanaged');
});

it('backs up an unmanaged file only with fix', async () => {
  const project = await makeProject();
  await writeProjectFile(project.root, 'AGENTS.md', '# Project\n');
  await writeProjectFile(project.root, '.claude/CLAUDE.md', 'user memory\n');
  const paths = projectPaths(project.root, 'project');

  const blocked = await planInstructions({ root: project.root, paths, mode: 'symlink' });
  expect(blocked.conflict?.code).toBe('claude-md.unmanaged');

  const fixed = await planInstructions({ root: project.root, paths, mode: 'symlink', fix: true });
  const backups = await applyInstructions(project.root, fixed, join(project.root, '.dab/backups/test'));
  expect(backups.some((item) => item.endsWith('.claude/CLAUDE.md'))).toBe(true);
  expect(await readlink(join(project.root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/adapter/instructions.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 instructions 计划和应用**

`src/adapter/claude-code/instructions.ts`：

- `renderClaudeMdShim(importPath = '../AGENTS.md')` 生成：
  ```text
  <!-- Generated by DAB from AGENTS.md. Do not edit. Run `dab normalize` to regenerate. -->
  @<importPath>
  ```
- `planInstructions`：
  - 目标固定 `.claude/CLAUDE.md`；source 为 `paths.instructions`。
  - 若 root 级 `CLAUDE.md` 存在，返回 `claude-md.unmanaged` 冲突。
  - `managed` 为 `generated?.instructions !== null && generated?.instructions !== undefined`。
  - `symlink`：
    - 目标不存在 → `create`。
    - 目标是 symlink 且 `resolve(dirname(target), readlink) === resolve(source)` → `none`。
    - 目标是 symlink 但错误 → managed 时 `repair`；未托管时冲突，`fix` 时 `backup-and-repair`。
    - 目标是普通文件 → 内容等于 scope 对应 shim 且 managed 时可 `repair` 为 symlink；否则冲突/`backup-and-repair`。
  - `generated`：
    - 目标不存在 → `create`。
    - 普通文件且内容等于 `renderClaudeMdShim(relativeLink(target, source))` → `none`。
    - 其他情况按 managed/未托管处理。
  - `disabled`：
    - 目标不存在 → `none`。
    - managed → `remove`；未托管 → 冲突，`fix` 时 `backup-and-remove`。
- `applyInstructions`：
  - `none` 返回 []。
  - `backup-and-*` 必须要求 `backupRoot`；先 `backupPath`，再 `rm`。
  - `create`/`repair`：确保 parent；`replaceSymlink` 或 `writeFileAtomic`。
  - `remove`：`rm`。
  - 所有路径先 `assertParentInsideRoot(root, '.claude/CLAUDE.md')`。
- `inspectInstructionTarget`：
  - 供 init pending 检测使用；接受 `generated?: GeneratedTarget`，对 absent/managed/expected 返回 undefined；未托管返回 `claude-md.unmanaged`。managed 包括生成的 shim 和指向 source 的 symlink。

- [ ] **Step 4: 扩展 Claude options 并接入 adapter**

- `ClaudeCodeTargetOptionsSchema` 的 `instructions` 变为 `z.enum(['symlink', 'generated', 'disabled']).default('symlink')`。
- `claudeCodeAdapter.normalize` 用 `planInstructions` 替换 `planClaudeMdShim`。
- `generated.instructions`：
  - `symlink`：`{ path: '.claude/CLAUDE.md', mode: 'symlink', sha256: sha256(await readTextFile(paths.instructions)) }`
  - `generated`：`{ path: '.claude/CLAUDE.md', mode: 'generated', sha256: sha256(renderClaudeMdShim(relativeLink(...))) }`
  - `disabled`：`null`
- `plan.apply` 调用 `applyInstructions`。
- `detect` 用 `planInstructions(..., fix: false)` 产生 diagnostics：
  - action 非 none 且无 conflict → `claude-md.instructions-missing`（目标不存在）或 `claude-md.instructions-drift`。
  - conflict 原样返回。
  - 若 generated record 缺失/不匹配 → `generated.manifest-stale` warning。
- 删除 `checkShim` 的旧实现或让它委托 `checkInstructions`；更新所有调用方。
- `init.ts` 的 pending 检测调用 `inspectInstructionTarget(root, paths, mode, getGeneratedTarget(manifest, 'claude-code'))`，不再要求普通文件。

- [ ] **Step 5: Global settings 只读**

- `claudeCodeAdapter.normalize` 在 `input.paths.scope === 'global'` 时：
  - 不调用 `planSettings`，不创建/读取/写入 `~/.claude/settings.json`。
  - `generated.settings = null`。
  - push warning：
    ```ts
    { code: 'claude-settings.global-not-adopted', severity: 'warning', file: '.claude/settings.json',
      message: 'global Claude settings are user-owned and are not modified by DAB in this phase',
      hint: 'Keep your existing settings; explicit adoption/merge is planned separately.' }
    ```
  - 如果 settings 文件存在，保持字节不变；如果不存在，不创建。
- `claudeCodeAdapter.detect` 在 global scope 跳过 `checkSettings`，同样 push warning；不要因为缺少 settings 报 error。
- `PolicyExplainResult` 的 limitations 增加一条 "global settings are not managed in this phase"；只在 global scope 添加。

- [ ] **Step 6: Ownership 和全量预检测试**

在 `test/commands/normalize.test.ts` 增加：

```ts
it('accepts a managed instruction symlink and repairs it after drift', async () => {
  const project = await projectFixture();
  await normalizeProject({ cwd: project.root });
  expect(await readlink(join(project.root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');

  await rm(join(project.root, '.claude/CLAUDE.md'));
  const repaired = await normalizeProject({ cwd: project.root });
  expect(repaired.ok).toBe(true);
  expect(await readlink(join(project.root, '.claude/CLAUDE.md'))).toBe('../AGENTS.md');
});

it('keeps global settings byte-identical', async () => {
  const home = await makeGlobalFixture();
  const settings = join(home.home, '.claude/settings.json');
  await writeProjectFile(home.home, '.claude/settings.json', '{"permissions":{"allow":["Bash(echo)"]}}\n');

  const result = await normalizeProject({ cwd: home.agents, home: home.home });

  expect(result.ok).toBe(true);
  expect(await readFile(settings, 'utf8')).toBe('{"permissions":{"allow":["Bash(echo)"]}}\n');
  expect(result.targets[0]?.settings).toBeUndefined();
});
```

在 `test/hardening.test.ts` 增加：

```ts
it('does not write any target when a global target path escapes HOME', async () => {
  const home = await makeGlobalFixture();
  const outside = await tempDir();
  await rm(join(home.home, '.claude'), { recursive: true, force: true });
  await symlink(outside, join(home.home, '.claude'), 'dir');

  const result = await normalizeProject({ cwd: home.agents, home: home.home });

  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((item) => item.code)).toContain('path.symlink-escape');
  expect(await readdir(outside)).toEqual([]);
});
```

- [ ] **Step 7: 更新现有测试**

- 所有 `renderClaudeMdShim()` 断言改为 `renderClaudeMdShim('../AGENTS.md')`（默认值仍可用）。
- 原先断言普通文件的地方改为断言 symlink；`planClaudeMdShim` 测试移到 `instructions.test.ts`。
- `test/commands/init.test.ts` 中 `.claude/CLAUDE.md` 的存在断言改为 `lstat` 下的 symlink + `readlink`。
- `test/commands/detect.test.ts` 的 shim drift 测试改为删除/替换 symlink，并断言 `claude-md.instructions-missing` 或 `claude-md.instructions-drift`。
- `test/hardening.test.ts` 的 shim 备份测试改为 symlink 冲突备份。

- [ ] **Step 8: 运行 focused tests**

Run:
```bash
pnpm vitest run test/adapter/instructions.test.ts test/adapter/claude-adapter.test.ts test/commands/normalize.test.ts test/commands/detect.test.ts test/commands/init.test.ts test/hardening.test.ts
```
Expected: PASS。

- [ ] **Step 9: 运行完整测试和 typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean。

- [ ] **Step 10: Commit**

```bash
git add src test
git commit -m "feat: prefer symlinked Claude instructions with managed fallback"
```

---

### Task 6: Scope-aware init 和 global bootstrap

**Files:**
- Create: `test/commands/init-scope.test.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/init/templates.ts`
- Modify: `src/cli.ts`
- Modify: `test/commands/init.test.ts`
- Modify: `test/hardening.test.ts`
- Modify: `test/helpers/initialized.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveSourceRoot`/`assertInitRoot`、Task 2 的 v2 manifest、Task 5 的 instructions。
- Produces:
  - `InitOptions.home?: string`
  - `InitResult.scope: Scope`
  - `renderDabYaml(scan: ScanResult, scope: Scope): string`
  - `templateFiles(scan: ScanResult, scope: Scope, aiAddition?: string): Record<string, string>`
  - `dab init [path]` 在 project/global 各自写正确布局。

- [ ] **Step 1: 写 global init 失败测试**

Task 5 已创建 `test/helpers/global.ts`；本任务的 global init 从空 HOME 开始，直接使用 `makeTempDir`，不需要预置 source facts。

`test/commands/init-scope.test.ts`：

```ts
function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

it('bootstraps global source and projections without writing home AGENTS.md or settings', async () => {
  const home = await makeTempDir('dab-home-init-');
  const captureResult = capture();

  const code = await runInit(
    { cwd: home, path: '.agents', home, json: true },
    captureResult.io,
  );

  expect(code).toBe(0);
  expect(await lstatOrNull(join(home, 'AGENTS.md'))).toBeNull();
  expect(await lstatOrNull(join(home, 'dab.yaml'))).toBeNull();
  expect(await lstatOrNull(join(home, '.agents/AGENTS.md'))).not.toBeNull();
  expect(await lstatOrNull(join(home, '.agents/dab.yaml'))).not.toBeNull();
  expect(await readlink(join(home, '.claude/CLAUDE.md'))).toBe('../.agents/AGENTS.md');
  expect(await lstatOrNull(join(home, '.claude/settings.json'))).toBeNull();

  const manifest = await loadProjectManifest(home, { scope: 'global' });
  expect(manifest.manifest.scope).toBe('global');
  expect(manifest.manifest.targets[0]?.provider).toBe('claude-code');
});

it('refuses to init inside an existing project source root', async () => {
  const root = await makeTempDir('dab-init-nested-');
  await mkdir(join(root, '.agents/skills/new'), { recursive: true });
  await writeFile(join(root, 'dab.yaml'), 'version: 2\n');

  const code = await runInit(
    { cwd: join(root, '.agents/skills/new'), json: true },
    capture().io,
  );

  expect(code).toBe(3);
  expect(await lstatOrNull(join(root, '.agents/skills/new/AGENTS.md'))).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/commands/init-scope.test.ts`
Expected: FAIL，global 布局或 nested guard 不存在。

- [ ] **Step 3: 让 init 使用 source root 和 scope**

`initializeProject`：

- 解析 init path 为绝对 `initRoot`；用 `assertInitRoot({ root: initRoot, home: options.home ?? homedir() })` 得到 `scope`。
- project：
  - `scopeRoot = initRoot`
  - `sourceRoot = join(initRoot, '.agents')`
  - `manifestPath = join(initRoot, 'dab.yaml')`
  - `instructionsPath = join(initRoot, 'AGENTS.md')`
- global：
  - `scopeRoot = dirname(initRoot)`（`initRoot` 必须是 `home/.agents`）
  - `sourceRoot = initRoot`
  - `manifestPath = join(initRoot, 'dab.yaml')`
  - `instructionsPath = join(initRoot, 'AGENTS.md')`
- `scanProject(initRoot)`。
- `paths` 使用 `resolveProjectPaths(scopeRoot, manifest)`；如果 manifest 不存在，构造临时 v2 manifest（`scope`、`targets: [claude-code instructions symlink]`、`paths`）。
- Safety checks 用 `scopeRoot` 和相对路径 `.agents`、`.claude`。
- `findGeneratedConflicts` 用 `scopeRoot`；global 不检查 settings；instructions 用 `inspectInstructionTarget`。
- `writeIfMissing(scopeRoot, relative, ...)`：
  - project：`AGENTS.md`、`dab.yaml`、`.agents/...`
  - global：`.agents/AGENTS.md`、`.agents/dab.yaml`、`.agents/...`
- `ensureDir(join(paths.agents, 'notes'))`。
- 成功时调用 `normalizeProject({ cwd: initRoot, home: options.home ?? homedir() })`；global 的 `cwd=home/.agents` 会被解析为 global。
- `InitResult` 增加 `scope`，`root` 保持 `initRoot`（`dab init ~/.agents` 显示该路径）。
- `formatInit` 输出 `dab init <root> scope=<scope>`。

- [ ] **Step 4: 更新模板**

`src/init/templates.ts`：

```ts
export function renderDabYaml(scan: ScanResult, scope: Scope): string {
  return `version: 2
scope: ${scope}
project:
  id: ${JSON.stringify(scan.projectId)}
  name: ${JSON.stringify(scan.projectName)}
profile: feature
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

export function templateFiles(
  scan: ScanResult,
  scope: Scope,
  aiAddition?: string,
): Record<string, string> {
  const agentsMd = scope === 'global' ? '.agents/AGENTS.md' : 'AGENTS.md';
  const manifest = scope === 'global' ? '.agents/dab.yaml' : 'dab.yaml';
  return {
    [agentsMd]: renderAgentsMd(scan, aiAddition),
    [manifest]: renderDabYaml(scan, scope),
    '.agents/agents/implementer.md': renderImplementerAgent(),
    // 其余 .agents 文件保持不变
  };
}
```

- [ ] **Step 5: 更新 init existing manifest 和迁移**

- 读取 existing manifest 时用 `loadProjectManifest(scopeRoot, { scope })`；global 的 manifest 在 `.agents/dab.yaml`。
- 如果 existing manifest 是 v1 project，init 继续；`normalizeProject` 会写入 v2。
- 如果 global 存在 v1 manifest，`loadProjectManifest` 抛 `config.manifest-legacy-global`，init 不写任何文件。

- [ ] **Step 6: 更新现有 init tests 和 helpers**

- `test/commands/init.test.ts` 的 project init 断言 v2 manifest、symlink instructions、`scope: project`。
- 原有 pending `.claude/CLAUDE.md` 测试改为 unmanaged file（不是 symlink），仍然 pending。
- `test/helpers/initialized.ts` 的 manifest 写成 v2，instructions 用 symlink；`makeInitializedProject` 仍能用于现有测试。
- `test/hardening.test.ts` 的 init 安全测试继续通过；新增 nested init 测试在 `init-scope.test.ts`。

- [ ] **Step 7: 运行 focused tests**

Run:
```bash
pnpm vitest run test/commands/init-scope.test.ts test/commands/init.test.ts test/hardening.test.ts test/commands/normalize.test.ts test/commands/detect.test.ts
```
Expected: PASS。

- [ ] **Step 8: 运行完整测试和 typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean。

- [ ] **Step 9: Commit**

```bash
git add src test
git commit -m "feat: initialize project and global scopes with v2 manifests"
```

---

### Task 7: 文档、路线图和最终验证

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/architecture.md`、`docs/architecture.zh.md`、`docs/architecture.i18n.yaml`
- Modify: `docs/development.md`、`docs/development.zh.md`、`docs/development.i18n.yaml`
- Modify: `docs/user/cli.md`、`docs/user/cli.zh.md`、`docs/user/cli.i18n.yaml`
- Modify: `docs/user/claude-code.md`、`docs/user/claude-code.zh.md`、`docs/user/claude-code.i18n.yaml`
- Modify: `docs/roadmap.md`、`docs/roadmap.zh.md`、`docs/roadmap.i18n.yaml`
- Modify: `docs/superpowers/plans/README.md`
- Modify: `dab.yaml`（由 normalize 生成）

**Interfaces:**
- Consumes: 前 6 个任务的代码行为。
- Produces: 与实现一致的用户文档、路线图和本地验证结果。

- [ ] **Step 1: 更新架构文档**

英文和中文同步说明：

- `AGENTS.md`/`.agents` 是唯一 source；project/global scope 独立。
- `SourceRoot` 解析规则：`dab init [path]` 精确路径，其他命令向上查找；global 仅 `$HOME/.agents`。
- v2 manifest 的 `scope`、`targets`、per-target generated record。
- target adapter 只映射和提供 provider options，不拥有 facts。
- 所有 target 预检通过后才写入；unmanaged 冲突不静默覆盖。
- Claude instructions 默认 symlink；generated shim 是显式 fallback。
- 本阶段 global settings 只读；Codex/DSH adapter 和 adoption/merge 是后续计划。

- [ ] **Step 2: 更新 CLI 文档**

`docs/user/cli.md/.zh.md` 必须包含：

- `dab init [path]` 的 project/global 布局和 `dab init ~/.agents`。
- 从子目录运行命令时的 root 发现。
- `dab policy explain --target <provider>`。
- v2 `dab.yaml` 示例（project 和 global）。
- `normalize` 的 per-target `targets` 输出和全量预检语义。
- global settings 只读说明。
- 现有 flags 语义不变。

- [ ] **Step 3: 更新 Claude Code 文档**

`docs/user/claude-code.md/.zh.md`：

- `.claude/CLAUDE.md` 默认 symlink 到 scope 的 `AGENTS.md`；global 为 `../.agents/AGENTS.md`。
- generated import shim 的 fallback 配置和适用场景。
- managed/unmanaged 冲突和 `--fix` 备份。
- global settings 本阶段不写入。

- [ ] **Step 4: 更新路线图**

`docs/roadmap.md/.zh.md`：

- 把 cross-harness alignment 从 v0.4 前面的位置调整到 v0.1.x 的第一优先级，或在 v0.1 之后增加 "v0.1.x Alignment" 阶段。
- 明确列出：v0.1.x Foundation + Claude；后续 Codex；后续 DSH；global settings adoption/merge；v0.2 Evidence；v0.3 Memory。
- 删除任何与 "no global command / independent scopes" 冲突的表述。

- [ ] **Step 5: 更新 AGENTS.md 项目地图**

增加：

- `src/model/scope.ts`：scope/root 解析。
- `src/model/facts.ts`：common facts discovery。
- `src/adapter/types.ts`：target adapter 契约。
- `src/adapter/claude-code/adapter.ts`：Claude target adapter。
- `src/adapter/claude-code/instructions.ts`：instructions artifact。
- `docs/superpowers/` 已存在；不需要重复。
- 规则 5 的 `docs/superpowers` 例外已经存在；确认没有矛盾。

- [ ] **Step 6: 更新 pairing records**

Run:
```bash
pnpm run verify-translation-pairing --write
```
Expected: no issues。

- [ ] **Step 7: 运行文档门禁**

Run: `pnpm doc-sync`
Expected: `doc sync: no issues found.`

- [ ] **Step 8: 迁移并验证本仓库自身**

Run:
```bash
pnpm build
node dist/cli.js normalize
node dist/cli.js detect
```
Expected:
- `dab.yaml` 变为 `version: 2`、`scope: project`、`targets`，`generated.targets[0].provider === 'claude-code'`。
- `.claude/CLAUDE.md` 是 symlink，指向 `../AGENTS.md`。
- `dab detect` 输出 `No issues found.`

- [ ] **Step 9: 完整验证**

Run:
```bash
pnpm test
pnpm typecheck
pnpm doc-sync
node dist/cli.js detect
node dist/cli.js normalize --dry-run
node dist/cli.js policy explain
```
Expected: tests/typecheck/doc-sync 全绿；detect 无问题；normalize dry-run 无写入；policy explain 正常输出 `Target: claude-code`。

- [ ] **Step 10: Commit**

```bash
git add AGENTS.md docs dab.yaml
git commit -m "docs: document scoped targets and Claude alignment"
```

---

## Self-Review

- Spec coverage:
  - Scope/roots：Task 1、2、6。
  - Manifest v2/targets/generated records：Task 2。
  - Adapter mapping only/provider options：Task 3、4。
  - Native-first/symlink-first：Task 5（Claude projections 已 symlink；instructions 改为 symlink）。
  - Ownership/conflicts/failure semantics：Task 4、5。
  - Global settings：Task 5 只读；adoption/merge 明确留给后续计划。
  - Migration：Task 2、6。
  - Testing/acceptance：每个任务 + Task 7。
  - Codex/DSH：明确不在本计划，后续计划。
- Review Focus 对应测试：
  1. Task 1 nested/global 测试；Task 6 nested init 测试。
  2. Task 2 scope mismatch/legacy global 测试。
  3. Task 5 global `.claude` symlink escape 测试；现有 project escape 测试保留。
  4. Task 4 codex + Claude 全量阻断测试；Task 5 target 预检测试。
  5. Task 5 managed symlink/unmanaged backup/global settings byte-identical 测试。
- Type consistency:
  - `ProjectPaths` 的 `root` 始终是 scope root；`agents`/`claude`/`manifest`/`instructions` 为绝对路径。
  - `GeneratedManifest` 是 `{ targets: GeneratedTarget[] }`；所有读取通过 `getGeneratedTarget`。
  - `TargetNormalizePlan.generated` 是 `GeneratedTarget`；normalize 只写 `plans.map(plan => plan.generated)`。
  - `InstructionMode` 在 Task 5 扩展为三值；Task 2/3 的中断版本只使用 `generated`/`disabled`，Task 5 更新测试。
