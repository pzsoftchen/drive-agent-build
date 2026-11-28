# G9 同变更门禁设计

状态：已批准；实现计划：[2026-11-28-g9-change-gate.md](../plans/2026-11-28-g9-change-gate.md)。本文档不包含实现代码。

## 1. 问题

G1 已经给消费项目一个稳定的执行入口：

- `scripts/dab-check.mjs` 先运行不可绕过的 `source` gate，再运行 code/docs 命令；
- `.agents/gates.yaml` 是 authored 配置，`scripts/dab-gates.json` 是生成快照；
- `dab detect` 有 project-only 的 `Verification` 组。

但它仍不知道“这次变更改了什么”。Agent 可以只改代码、不改 tests/docs/notes，所有 gate 仍然通过。G9 要补的是：

> 代码变更是否伴随相应的测试、文档或决策记录。

这不是代码正确性检查，也不是评审替代品，而是把“同一变更新”从个人习惯变成可见、可配置的检查。

## 2. 目标

1. 在现有 gate runner 中增加可配置的 `change` 维度，不新增 `dab` 命令。
2. 默认使用 **advisory**：先让问题可见，不制造大量误报 hard block。
3. 项目可以把 `change` 升级为 `required`，把同变更要求变成真正的门禁。
4. 对 code/tests/docs/notes 做路径级分类，不做 AST 或语义推断。
5. 本地和 CI 使用同一个 `scripts/dab-check.mjs`，不绑定 GitHub。
6. 既有 `.agents/gates.yaml` 保持兼容；缺少 `change` 配置时视为未启用。

## 3. 非目标

- 不检查测试质量、文档质量或代码正确性。
- 不要求每个代码变更都改 docs/notes；默认只把缺失暴露为 warning。
- 不生成 PR description、不做 code review、不做自动修复。
- 不绑定 CODEOWNERS、GitHub PR API 或任何单一 CI provider。
- 不新增 `dab change` / `dab check` / `dab upgrade` 命令。
- 不自动修改 `.agents/gates.yaml` 或生成 CI workflow。

## 4. 设计原则

- **Advisory first**：路径规则只能证明“没有改某类文件”，不能证明“应该改”；默认不阻断。
- **Explicit opt-in**：项目通过 `mode: required` 选择阻断，而不是 DAB 替项目决定。
- **Diff is evidence, not intent**：只读取 git 变更路径，不猜测变更目的。
- **Local/CI parity**：同一个 runner、同一个配置、同一个退出码。
- **Fail loud on missing input**：base ref 不存在、仓库不可读或配置无效是 `CONFIG`，不是 pass。

## 5. Gate 模型

`change` 是 G1 gate runner 的第四个维度：

| 维度 | 内容 | 默认 |
|---|---|---|
| `source` | `dab detect --strict` | required |
| `code` | test/typecheck/lint/build | 按命令 |
| `docs` | generated docs / project docs command | check |
| `change` | code/tests/docs/notes 的 diff 关联 | advisory |

`change` 使用与现有 gate 相同的模式：

- `required`：不满足 configured checks 时失败，exit `1`；
- `check`：warning，`--strict` 时失败；
- `advisory`：warning，正常不失败；
- `off`：明确跳过，输出 `SKIP`。

`CONFIG`（base 无法解析、配置无效、git 不可用）始终 exit `2`；不能被 `advisory` 或 `off` 静默吞掉。`off` 是唯一显式关闭方式。

## 6. 配置

### 6.1 `.agents/gates.yaml`

新增可选的 `change` 段。现有 `version: 1` 配置仍然有效；缺少 `change` 等价于 `off`，但 DAB 生成的 starter 默认写入 advisory 配置。

```yaml
version: 1
gates:
  source:
    mode: required
  code:
    commands:
      test:
        command: pnpm test
        mode: required
  docs:
    mode: check
  change:
    mode: advisory
    checks: [tests, docs]
    base: origin/main
```

字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `advisory` | `required` / `check` / `advisory` / `off` |
| `checks` | `[tests, docs]` | `tests` / `docs` / `notes`，至少一项（`off` 时允许空） |
| `base` | `origin/main` | git base ref；`DAB_CHANGE_BASE` 环境变量优先 |
| `paths.code` | scanner 推导 + 常见源码目录 | code 路径 glob |
| `paths.tests` | 常见测试路径 | tests 路径 glob |
| `paths.docs` | `docs/**`、README/CHANGELOG/AGENTS | docs 路径 glob |
| `paths.notes` | `.agents/notes/**` | notes 路径 glob |
| `ignore` | generated/依赖/锁文件 | 不参与分类的路径 |

- `checks` 的顺序固定为 `tests`、`docs`、`notes`，输出稳定。
- `paths` 省略时使用默认；显式配置覆盖默认。
- `ignore` 优先于所有分类；`.claude/**`、`dist/**`、`build/**`、`node_modules/**`、`scripts/dab-check.mjs`、`scripts/dab-gates.json`、`.agents/skills/dab-*/**`、锁文件默认忽略。
- 未知字段、空路径、无效模式是 schema error，阻止 normalize。

### 6.2 路径分类

先应用 `ignore`，再按以下顺序分类：

1. `tests`：测试路径；
2. `docs`：文档路径；
3. `notes`：`.agents/notes/**`；
4. `code`：源码路径；
5. 其他：不参与。

测试路径优先于 code，避免 `src/foo.test.ts` 被同时算作 code 和 tests。docs/notes 优先于 code，避免 `.agents/notes/...` 被误算为代码。

默认 path 规则由 scanner 的 source dirs 与常见语言目录推导；无法推导时使用保守列表：

- code：`src/**`、`app/**`、`lib/**`、`packages/**`、`cmd/**`、`server/**`；
- tests：`test/**`、`tests/**`、`__tests__/**`、`**/*.test.*`、`**/*.spec.*`、`src/test/**`、`app/src/test/**`、`androidTest/**`；
- docs：`docs/**`、`README*`、`CHANGELOG*`、`AGENTS.md`、`CONTRIBUTING*`；
- notes：`.agents/notes/**`。

glob 使用 Node 内置匹配能力或项目内已测试的最小匹配器；不引入新的运行时依赖。

### 6.3 配置来源

- `.agents/gates.yaml` 是 authored source；`normalize` 只为缺失配置生成 starter，不覆盖已有配置。
- starter 默认写入 `change: { mode: advisory, checks: [tests, docs], base: origin/main }`。
- 已有项目缺少 `change` 时保持有效，`detect` 只显示 `change OFF`；不会自动改写用户配置。
- `DAB_CHANGE_BASE` 环境变量优先于 `change.base`，用于 CI 或本地临时比较。

## 7. Diff 采集

runner 只使用只读 git 命令：

1. 解析 base：`DAB_CHANGE_BASE` > `change.base`；默认 `origin/main`。
2. 计算 `merge-base(base, HEAD)`；没有 merge base 时 `CONFIG`。
3. 收集三类路径并集：
   - committed：`git diff --name-only --diff-filter=ACMR <merge-base>...HEAD`；
   - staged：`git diff --cached --name-only --diff-filter=ACMR`；
   - unstaged：`git diff --name-only --diff-filter=ACMR`。
4. 去重、按 POSIX 路径排序；忽略文件不进入分类。

说明：

- CI 使用 branch diff；本地未提交修改也会被纳入，避免“本地通过、CI 失败”的假象。
- rename/copy 使用新路径；删除文件不计入新增 code/docs/tests，避免把删除误判为新增内容。
- 没有 git 仓库或 base 不可解析时，`change` 为 `CONFIG`；项目可以用 `mode: off` 明确关闭。
- 不执行 fetch、不访问网络、不写 git 状态。

## 8. 检查规则

只有存在 `code` 变更时才评估耦合；docs-only、tests-only、generated-only 变更直接 `PASS`/`SKIP`。

| 检查 | 条件 | 不满足 |
|---|---|---|
| `tests` | code 变更且没有 tests 变更 | warning；`mode: required` 时失败 |
| `docs` | code 变更且没有 docs 变更 | warning；`mode: required` 时失败 |
| `notes` | code 变更且没有 notes 变更 | warning；`mode: required` 时失败 |

- 一个 code 变更可以同时满足 tests/docs/notes。
- `checks` 未列出的维度不评估。
- 没有 code 变更时，所有 checks 输出 `SKIP (no code changes)`。
- `mode: off` 输出一行 `SKIP (change gate off)`，不执行 git diff。
- 不满足的检查输出可操作的 detail：缺少 tests/docs/notes；不是“代码有问题”。

## 9. Runner 集成

快照新增可选的 `change`：

```json
{
  "version": 1,
  "generated": { "dabVersion": "0.1.4", "sha256": "..." },
  "gates": {
    "source": { "mode": "required" },
    "code": { "commands": {} },
    "docs": { "mode": "check" },
    "change": {
      "mode": "advisory",
      "checks": ["tests", "docs"],
      "base": "origin/main",
      "paths": { "...": "..." },
      "ignore": ["..."]
    }
  }
}
```

runner 执行顺序：

1. `source`；
2. `code`；
3. `docs`；
4. `change`。

`change` 不短路；所有维度都跑完再汇总。`change` 的状态/退出码沿用 G1：

- `PASS`/`SKIP`：不导致失败；
- `WARN`：`--strict` 时失败；
- `FAIL`：required 不满足；
- `CONFIG`：base/配置/git 错误，exit `2`。

JSON 增加一项：

```json
{
  "id": "change",
  "status": "warn",
  "required": false,
  "command": "git diff",
  "exitCode": 0,
  "durationMs": 12
}
```

具体 detail（缺少 tests/docs/notes、base ref）放在人类输出和 diagnostics；JSON 保持稳定字段，不塞完整 diff。

## 10. `dab detect`

`dab detect` 不执行 git diff，只检查配置接线：

- `Verification` 组增加 `change` 行：
  - 缺失 `change`：`SKIP` / `change OFF`，非 strict；
  - 配置有效：`[OK] change (advisory; tests,docs; base origin/main)`；
  - 配置无效：`verification.config-invalid` error；
- `dab detect` 不运行 `git diff`，避免把本地未提交状态误报为项目健康问题。
- `change` 的 diff 检查只在 runner/CI 执行；这是“本地/CI 共用 runner”的职责分离。

如果未来需要 detect 显示 change 状态，必须新增明确的只读接口，不能复用 normalize 写入。

## 11. CI 与本地使用

推荐 CI：

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: node scripts/dab-check.mjs --strict
```

- GitHub Actions 的 `fetch-depth: 0` 保证 base 可解析。
- 非 GitHub CI 设置 `DAB_CHANGE_BASE` 或 `change.base`。
- 项目可以先以 `advisory` 观察，再 opt-in 为 `required`。
- DAB 不生成 CI 文件，只提供片段和 detect 提示。

## 12. 文档和本地行为

- starter 的 `change` 默认 advisory；`checks: [tests, docs]`，`notes` 不默认要求。
- README / gates 文档说明：
  - advisory 不是硬门禁；
  - required 是项目选择；
  - docs-only / generated-only 不触发 code 耦合；
  - missing base 是 CONFIG；
  - `DAB_CHANGE_BASE` 用法。
- `change` 不替代 PR checklist；两者可以同时存在。
- 不自动修改 `.agents/gates.yaml`；已有项目保持无 `change` 也有效。

## 13. 迁移与兼容

- G1 配置 `version: 1` 保持；`change` 是可选 add-only 字段。
- 缺少 `change` 的既有项目不报错；starter 只在缺失 `.agents/gates.yaml` 时包含默认 advisory。
- `scripts/dab-gates.json` 快照增加 `change`；旧快照没有 `change` 仍可运行，runner 视为 off。
- `scripts/dab-check.mjs` 版本更新；managed runner 只更新未修改的旧版本，modified/unversioned/newer 保留。
- `dab detect` 对缺失 `change` 显示非 strict `SKIP`，不阻塞现有项目升级。

## 14. 备选方案

**所有 code 变更都 hard require tests/docs。** 被拒绝：文档、配置、生成器、纯重构和实验性变更会产生大量误报；G9 的核心是可见性和项目选择，不是替项目判断。

**只提供 PR checklist。** 不够：checklist 不会运行，也无法进入本地 runner；可以作为补充，不能作为唯一机制。

**新增 `dab change` 命令。** 被拒绝：与 G1 的“不新增命令”一致，runner 已经是项目入口。

**只做 GitHub Actions。** 被拒绝：DAB 不应绑定单一 CI provider；runner 和 `git diff` 已经可移植。

**用 AST/语义分析判断是否“需要测试/docs”。** 超出 G9；不可靠且会引入语言特定复杂度。

**把 notes 默认设为 required。** 被拒绝：不是每个代码变更都需要决策记录；notes 默认不检查，项目可显式加入。

## 15. 风险

- 路径分类误判：显式 `paths`/`ignore` 覆盖；只影响 warning。
- base ref 不可用：明确 `CONFIG`，不假通过。
- 本地未提交变更与 CI 结果不同：runner 同时纳入 staged/unstaged，CI 用 branch diff；文档说明差异。
- 大 monorepo 的路径数量：只处理路径名，不读取内容；设置合理 ignore。
- 用户把 advisory 误认为 hard gate：文档和输出明确标注 `WARN`/`advisory`。
- 未来多栈/多包路径：通过 `paths` 覆盖，不引入 profile。

## 16. 测试与验收

### 配置

- `change` 可选；缺失时合法；
- `mode`/`checks`/`paths`/`ignore` 校验；
- `mode: off` 允许空 checks；
- 未知字段 fail；
- starter 包含 advisory tests/docs；既有配置不被改写。

### 分类

- code-only、test-only、docs-only、notes-only、generated-only；
- test 路径优先于 code；
- ignore 优先；
- 删除/rename 的处理；
- 默认路径和 scanner source dirs。

### Diff / runner

- branch diff、staged、unstaged 并集；
- base 不存在 → CONFIG/exit 2；
- no code changes → SKIP；
- tests/docs/notes 缺失 → WARN；
- required → FAIL/exit 1；
- `--strict` 提升 advisory/check；
- change 与 source/code/docs 同时运行，不短路；
- JSON 稳定。

### detect / normalize

- detect 显示 change 配置行，不运行 diff；
- 缺失 change 为非 strict SKIP；
- invalid change error；
- normalize 保留既有配置，starter 只写一次；
- 旧 snapshot 无 change 时 runner 视为 off；
- no new command / no network / no auto CI。

## 17. 开放问题

1. 默认 base 用 `origin/main` 还是 `main`？本文档选择 `origin/main`，并允许 `DAB_CHANGE_BASE` 覆盖。
2. `docs` 是否应默认 advisory？本文档选择 advisory，不默认 required。
3. `notes` 是否默认检查？本文档选择不检查，项目显式加入 `notes`。
4. 是否评估删除文件？本文档只把新增/修改路径作为内容证据；删除由 review 判断。
5. 是否自动生成 PR checklist？本文档只提供文档片段，不自动生成。

## 18. 与 G1 的关系

- G9 复用 G1 的 `.agents/gates.yaml`、stable runner、snapshot、detect Verification 和 managed update，不新增命令。
- `source` 仍是不可绕过的第一 gate；`change` 只是附加维度。
- G1 的 `change` 配置在 G9 中从“预留/未实现”变成可选实现；G1 的 existing config 兼容。
- G9 完成后，L2 的执行层从“能运行检查”补齐为“能检查变更关联”。
