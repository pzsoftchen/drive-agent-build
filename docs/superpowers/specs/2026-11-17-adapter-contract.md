# DAB Target Adapter Contract 规范

## 状态

已批准。实现计划：[2026-11-17-adapter-contract.md](../plans/2026-11-17-adapter-contract.md)。

## 背景

跨 harness foundation 已经引入 `TargetAdapter`，但公共模型和公共命令仍然直接包含 Claude Code 的结构。当前 Claude-only 版本可以工作，但这会让 Codex/DSH adapter 继续把 provider 分支塞回公共层。

已确认的耦合点：

| 位置 | 当前耦合 |
|---|---|
| `src/model/schemas.ts` | `GeneratedTarget.instructions.path` 固定为 `.claude/CLAUDE.md` |
| `src/model/project-manifest.ts` | 公共 `ProjectPaths` 包含 `claude`，并据此解析 `.claude` |
| `src/commands/normalize.ts` | 直接导入 Claude options、projection、version check，并硬编码 `.claude` 安全路径 |
| `src/commands/detect.ts` | 硬编码 `.claude/agents`、`.claude/skills`、`.claude/rules` 和 provider label |
| `src/commands/policy-explain.ts` | 直接依赖 Claude `compilePolicy`、`parseClaudeTargetOptions`、`readClaudeVersion` 和 Claude 专属 `EffectivePolicy` |
| `src/commands/init.ts` | 直接导入 Claude instruction/options/projection，并硬编码 `.claude` |
| `src/detect/checks.ts` | 公共检查直接导入 Claude `buildManagedHookCommands` 等 hook command 构造逻辑，并导入 Claude `planInstructions`/硬编码 `.claude` 路径 |
| `src/adapter/types.ts` | `TargetAdapter` 只有 `normalize`/`detect`，没有 target root、instruction artifact、policy explanation 契约 |

## 目标

- 公共 manifest、路径和命令只表达 scope、source、target、generated record 和 diagnostics。
- Claude 专属的 target root、settings/instructions 路径、projection roots、runtime 和 policy explanation 由 Claude adapter 提供。
- 新增 adapter 时只注册 adapter 和 manifest target，不修改 `normalize`、`detect`、`init`、`policy-explain` 的 provider 分支。
- 保持现有 Claude Code 行为和 v2 manifest 数据可用；不要求用户手改已有 `dab.yaml`。

## 非目标

- 本 spec 不实现 Codex 或 DSH adapter。
- 不改变 agent、skill、rule、policy 或 hook 的 source 格式。
- 不引入跨 scope 继承或 global settings merge。
- 不把 Claude Code 的权限规则抽象成通用权限语言；provider policy explanation 保持 provider 自有结构。
- 不为了抽象而复制 source facts 到各 adapter。

## Target Layout

Adapter 必须能够描述自己写入的 target root 和 artifact 位置：

```ts
interface TargetLayout {
  provider: TargetProvider;
  /** Scope-root-relative directory owned by this target. */
  targetRoot: string;
  /** Scope-root-relative settings artifact, when the provider has one. */
  settingsPath?: string;
  /** Scope-root-relative instruction artifact. */
  instructionsPath: string;
  /** Scope-root-relative projection roots for source facts. */
  projectionRoots: {
    agents?: string;
    skills?: string;
    rules?: string;
  };
}
```

约束：

- 所有路径必须相对于 scope root，不允许绝对路径、`~`、`..` 或 symlink escape。
- `targetRoot` 不得与 `.agents/` source root 重叠。
- Adapter 负责验证 provider options 对 layout 的影响；公共命令只使用 layout，不解释 provider path。
- `TargetAdapter` 增加 `layout(manifest, target): TargetLayout` 或等价的同步描述方法。
- `ProjectPaths` 只保留 `root`、`scope`、`agents`（source root）、`manifest`、`instructions`（source instructions），移除 `claude`。

## Instruction Artifact

Instruction artifact 是 target 自有文件，公共 schema 不固定其路径：

- `GeneratedTarget.instructions.path` 从字面量 `.claude/CLAUDE.md` 改为 provider 校验的 scope-relative string。
- Adapter 负责 artifact mode（`symlink`、`generated`、`disabled`）、source instructions 路径、target 路径、hash 和 fallback。
- `TargetNormalizePlan.instructions` 继续提供公共摘要，但 `path` 和 `mode` 的类型由 adapter contract 约束，不在 common schema 写死。
- 现有 v2 记录路径保持有效；不要求 v3 manifest 迁移。Adapter 读取记录时必须验证 path 是自己 layout 的 artifact。

## Policy Explanation

`policy explain` 只负责选择 target、收集 source facts、调用 adapter 和输出结果。Provider policy 的编译和展示归 adapter：

```ts
interface TargetPolicyExplanation {
  provider: TargetProvider;
  runtime: {
    installed: boolean;
    version?: string;
    compatible: boolean;
    minimum?: string;
  };
  /** Provider-owned JSON payload; Claude keeps its current effective shape. */
  effective: unknown;
  sections: Array<{ title: string; lines: string[] }>;
  sources: string[];
  limitations: string[];
  agent?: unknown;
  diagnostics: Diagnostic[];
}
```

约束：

- `policy-explain.ts` 不再导入 `compilePolicy`、`parseClaudeTargetOptions`、`readClaudeVersion` 或 Claude `EffectivePolicy`。
- Claude adapter 负责把 project policy、adapter policy、hooks 和 agent 编译成 sections/limitations，并保留现有 JSON 字段作为 Claude-specific payload（可由 adapter 定义）。
- 公共命令只负责 target selection、source root、facts discovery、通用 diagnostics 和 human/JSON envelope。
- 如果没有 adapter 能解释某个 target，必须 fail loud，不能回退到 Claude 编译器。

## Generated Records

长期目标是把 provider-specific generated records 变成 provider-owned artifacts，但本阶段不要求一次完成：

- 保留 `generated.targets[]` 的 per-provider record。
- `settings` 和 `instructions` 的 path 由 adapter layout 校验；公共 schema 不出现 `.claude`。
- Projection target 仍由 adapter 生成并记录 source hash、target hash/link 信息。
- 如果 Codex/DSH 需要不同的 artifact 形态，再引入通用 `artifacts[]` schema；不在本阶段预先设计未知格式。

## Common Command Changes

### `normalize`

- 从 adapter layout 获取 target root、settings/instructions/projection 路径和安全检查目录。
- 移除 `parseClaudeTargetOptions`、`discoverProjections`、`checkClaudeCode` 的直接导入。
- 通用流程：source safety → facts → enabled target loop → adapter plan → all-target preflight → apply → generated records。
- Runtime check 由 adapter plan 提供；后端 exit code 仍由公共结果映射。

### `detect`

- 从 adapter detect outcome 获取 target diagnostics 和 per-fact status。
- 通用 source safety 只检查 source root 和 adapter 声明的 target roots。
- Provider label 和 status 展示由 adapter contract 提供，不在公共 `TARGET_LABELS` 里硬编码 Claude。
- Backend exit priority 仍由公共 `buildResult` 保留。

### `init`

- 从 adapter layout 获取 target root、instructions/settings 路径和模板 projection roots。
- Claude 模板、`CLAUDE.md`、`.claude/**` 规则和 policy adapter 文件仍属于 Claude adapter 的初始化模板。
- 公共 init 只负责 scope、source skeleton、manifest、安全和 adapter loop。

### `policy explain`

- 只调用选定 target 的 `adapter.explainPolicy(...)`。
- 公共 result 包含 target、runtime、sections、sources、limitations、diagnostics；Claude-specific details 由 adapter 扩展。
- `--agent` 的 discovery 和 source facts 保持公共；agent policy 的解释由 adapter 完成。

## 验收

- `src/commands/normalize.ts`、`detect.ts`、`init.ts`、`policy-explain.ts` 不再导入 `src/adapter/claude-code/*`，除 registry 选择外不出现 `.claude` 字面量。
- `src/detect/checks.ts` 不再直接导入 Claude hook command 构造逻辑、`planInstructions` 或硬编码 `.claude` 路径；agent hook 校验通过 adapter contract 或者公共检查接收 adapter 提供的 validator 和 artifact layout。
- `src/model/schemas.ts` 的 generated instructions path 不再是 `.claude/CLAUDE.md` 字面量。
- `ProjectPaths` 不再包含 `claude`。
- Claude `policy explain` 的 `effective` payload 保持当前 JSON 字段；公共命令只透传 provider-owned payload，不重新解释字段。
- 一个测试用 fake adapter 证明：注册第二个 provider 后，normalize/detect/policy explain 不需要修改公共命令。
- 现有 Claude Code 测试、normalize/detect/init/policy-explain 行为、v2 manifest 和 global read-only 行为保持不变。
- `pnpm test`、`pnpm typecheck`、`pnpm doc-sync` 通过。

## Rollout

1. 增加 `TargetLayout` 和 adapter layout 契约，迁移 Claude layout。
2. 移除 `ProjectPaths.claude` 和公共 `.claude` 安全检查，改由 adapter layout 提供。
3. 移除 generated instruction path 字面量，由 adapter 校验。
4. 增加 adapter `explainPolicy`，迁移 Claude policy explanation。
5. 移除公共命令中的 Claude imports，增加 fake adapter 测试。
6. 之后再开始 Codex adapter。

## Open Questions

- `policy explain` 的 JSON 是否需要保持当前的 Claude-specific `effective` 字段，还是允许按 provider 返回不同 payload。
- 通用 `sections` 是否足够表达未来的 Codex/DSH policy，还是需要 provider-specific renderer。
- `init` 的投影模板是否全部移入 adapter，还是保留一个公共模板骨架加 adapter overlay。
- 是否需要 v3 generated artifact schema；本 spec 建议等 Codex/DSH 格式明确后再决定。
