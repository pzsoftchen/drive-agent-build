# G1 Gate 设计

状态：已批准，随 `0.1.3` 实现并发布；实现计划：[2026-11-25-g1-gate.md](../plans/2026-11-25-g1-gate.md)。本文档不包含实现代码。

## 1. 问题

DAB 0.1.2 已经能生成 docs、notes、authoring skills，并用 `detect --strict` 检查配置漂移；但消费项目拿到的仍主要是模板和说明，没有一个稳定的项目本地执行入口。

结果是：

- 生成的 docs 和 skills 可以长期不运行、不检查；
- `detect` 是检查器，不是团队或 CI 每天会执行的命令；
- Java、iOS、Android 项目没有 code gate 的检测和命令适配；
- 同变更更新（代码改了，测试/docs/notes 有没有跟上）没有执行位置。

G1 仍然是最高的执行层缺口，G4（skill 更新治理）已在 0.1.2 完成。deepseek-harness 的对照说明执行层不是“多写规则”，而是把 `check:all`、pre-push 和 CI gates 串成项目每天都会运行的路径；DAB 目前有检查器，缺少把检查器产品化的 runner。

## 2. 目标

1. 项目拥有一个稳定的本地 gate 入口：`node scripts/dab-check.mjs`，并可在任意 CI 中调用。
2. Gate 按维度独立报告，不在第一个失败处短路。
3. 技术栈只影响 code gate 的命令来源，不影响 DAB 的产品模型。
4. 首批支持已有栈和 Java、iOS、Android 的检测；无法可靠推断的命令必须标记为 `needs-config`，不能假装通过。
5. `dab detect` 能报告 gate runner、配置、必需命令和 CI 接线的状态。
6. `dab init` / `dab normalize` 只在缺失时创建；受管 runner 只更新未修改副本；global scope 不生成 gate。
7. 不新增 `dab` 命令。

## 3. 非目标

- 不实现 G9 的 diff 启发式“代码变更必须改 docs/notes”；`change` gate 留给 G9。
- 不替代项目测试框架、lint、构建工具或 CI 提供商。
- 不生成 GitHub Actions workflow（v1 提供文档片段和 detect 提示，避免接管项目 CI）。
- 不判断测试质量、架构质量、评审质量；这些仍是 behavioral/review 范畴。
- 不自动执行 `xcodebuild -list`、`gradle tasks` 等可能依赖外部 SDK、网络或耗时的探测命令。
- 不复制 deepseek-harness 的具体 gate 清单；只借鉴执行层机制。

## 4. 设计原则

Gate 模型拆成三个正交概念：

1. **Gate 维度**：保护什么；
2. **强制级别**：失败是否阻断；
3. **技术栈 provider**：具体执行什么命令。

技术栈是 provider，不是 profile。不要让 Java、iOS、Android 变成新的 DAB profile。

## 5. Gate 模型

### 5.1 v1 维度

| 维度 | 负责方 | 内容 | 默认级别 |
|---|---|---|---|
| `source` | DAB | `dab detect --strict`：source、投影、所有权、scope、practice 状态 | `required` |
| `code` | 项目 | test、typecheck、lint、build；命令来自 scanner 或项目配置 | test/typecheck 默认 required；lint/build 默认 advisory |
| `docs` | DAB + 项目 | DAB 的 docs/practice 检查；可选项目 docs 命令 | `check` |
| `change` | 项目 + DAB | 同变更更新 | 不在 v1；G9 |

`source` 是固定的 required 维度，项目不能通过配置关闭它。项目可以使用 DAB 的 policy/practice 配置调整具体检查，但不能把 source gate 静默关掉。

### 5.2 强制级别

| 级别 | 失败行为 | 用途 |
|---|---|---|
| `required` | gate runner 非零退出 | 确定性、不可妥协的检查 |
| `check` | 报告 warning；`--strict` 时失败 | 需要可见但可能暂不阻断的检查 |
| `advisory` | 报告 warning，永不单独阻断 | lint/build 等成本或策略可变项 |
| `off` | 明确跳过，报告 `SKIP` | 项目明确不使用该检查 |

`off` 不是“自动通过”；输出必须显示 `SKIP` 和原因。不能把未配置的命令当成通过。

### 5.3 状态

每个 gate/command 输出一个状态：

- `PASS`：命令成功；
- `FAIL`：required 命令失败；
- `WARN`：check/advisory 失败或存在非阻断问题；
- `SKIP`：明确 off 或无命令且不是 required；
- `CONFIG`：必需命令未解析或配置无效；
- `ERROR`：runner 自身无法执行（DAB 不可用、配置读取失败等）。

## 6. 项目配置

### 6.1 `.agents/gates.yaml`

gate 定义属于 authored source，放在 `.agents/gates.yaml`。DAB 使用已有的 `yaml` 依赖解析，新增 Zod schema。

示例（Node）：

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
      typecheck:
        command: pnpm typecheck
        mode: required
      lint:
        command: pnpm lint
        mode: advisory
  docs:
    mode: check
```

示例（Android）：

```yaml
version: 1
gates:
  source:
    mode: required
  code:
    commands:
      test:
        command: ./gradlew test
        mode: required
      lint:
        command: ./gradlew lint
        mode: advisory
      build:
        command: ./gradlew assembleDebug
        mode: advisory
  docs:
    mode: check
```

示例（iOS Xcode，使用结构化字段）：

```yaml
version: 1
gates:
  source:
    mode: required
  code:
    commands:
      test:
        xcodebuild:
          workspace: App.xcworkspace
          scheme: App
          destination: platform=iOS Simulator,name=iPhone 16
        mode: required
      lint:
        command: swiftlint
        mode: advisory
  docs:
    mode: check
```

如果项目使用 Fastlane，可以把 test 写成普通命令：

```yaml
      test:
        command: bundle exec fastlane test
        mode: required
```

如果 Xcode 项目尚未提供 scheme/destination，则保留 `command: null` 和 `needs`，不要猜测：`dab detect` 报告 `verification.command-needs-config`，runner 报 `CONFIG`。

规则：

- `version` 目前为 `1`，未知版本 fail loud。
- `source.mode` 只能是 `required`。
- `code` 至少有一个命令；没有检测到任何命令时允许空对象，但 `detect` 和 runner 都必须报告 `CONFIG`/`WARN`，不能静默通过。
- `command` 是项目可信的命令字符串；DAB 不执行 shell 拼接之外的动态求值。
- `command` 与 `xcodebuild` 二选一；`xcodebuild` 必须提供 `scheme` 和 `destination`，并且 `project`/`workspace` 二选一；缺任何必需字段都是 `needs-config`，不能降级为通过。
- `xcodebuild` 由 normalize 规范化为等价的 `xcodebuild test ...` 命令写入快照；项目应提交 shared scheme。
- `docs.command` 可选；没有项目 docs 命令时输出 `SKIP`，并说明生成的 docs/practice 已由 `source` gate 检查，不视为失败。
- `test` 和 `typecheck` 是 scanner 默认的必需维度。scanner 检测到对应命令而配置省略该维度时，`detect` 报 error（`verification.command-missing`）；唯一的豁免方式是显式写入 `mode: off`，不能通过删除键静默通过。
- `mode: off` 是显式豁免：runner 在任何命令状态下先输出 `SKIP`，不检查 `command: null`，也不把未配置当成通过。
- `command: null` 表示需要项目配置，不得当作跳过；除 `mode: off` 外，runner 输出 `CONFIG` 并以 `2` 退出，不区分配置的 mode。
- 配置和 scanner 都没有命令时允许 `code.commands: {}`：`detect` 报非 strict warning（`verification.commands-empty`），runner 报 `WARN`。runner 的 `--strict` 会让该 `WARN` 导致退出码 `1`，而 `detect` 不会让 `commands-empty` 失败；空命令集是项目状态，不是配置漂移。
- 配置键未知、类型错误、命令为空字符串是 error。
- `.agents/gates.yaml` 不存在时，`init`/`normalize` 按 scanner 结果生成 starter；已存在时永不覆盖。
- 生成文件 `scripts/dab-check.mjs` 和 `scripts/dab-gates.json` 不属于 authored source；它们由 normalize 管理，具体更新规则见 7.1 和 10.2。

### 6.2 配置来源优先级

1. `.agents/gates.yaml` 中显式的 `command` 或 `xcodebuild`；
2. scanner 的检测结果（仅在 `.agents/gates.yaml` 缺失时用于生成 starter，不回填已有配置）；
3. 无命令：明确 `SKIP`/`CONFIG`，不猜测。

项目可以在配置里覆盖 scanner 的检测，例如 iOS 项目必须提供 scheme/destination，或 Java 项目使用自定义 Maven profile。

### 6.3 生成快照 `scripts/dab-gates.json`

runner 不直接解析 YAML，而是读取 normalize 生成的无依赖 JSON 快照：

```json
{
  "version": 1,
  "generated": {
    "dabVersion": "0.1.2",
    "sha256": "<canonical-gates-sha256>"
  },
  "gates": {
    "source": { "mode": "required" },
    "code": {
      "commands": {
        "test": { "command": "pnpm test", "mode": "required" }
      }
    },
    "docs": { "mode": "check" }
  }
}
```

- 快照是生成物，不是 authored source；source of truth 始终是 `.agents/gates.yaml`，scanner 只用于配置缺失时的 starter。
- `sha256` 覆盖规范化后的 `gates` 对象，不覆盖 `generated` 元数据。
- `normalize` 从 authored 配置编译快照；runner 只读快照。
- 手工修改快照会被 detect 报告为 modified；normalize 不静默覆盖用户修改，除非快照仍是 DAB 管理的未修改版本。
- 快照让 runner 不需要 YAML 解析器，也避免把每个项目命令嵌入 runner 代码。

## 7. Gate runner 与生成快照

### 7.1 文件职责

- `scripts/dab-check.mjs`：稳定 runner，负责执行和聚合，不嵌入项目命令。
- `scripts/dab-gates.json`：由 `.agents/gates.yaml` 编译出的配置快照，runner 只读它。

这是主流工具常见的“稳定 runner + 声明式配置”形态（`pre-commit`、`lefthook`、Nx、Turborepo 都是 runner 稳定、配置留在仓库）。把命令嵌进生成 runner 虽然也能工作，但每次改命令都要重写代码，难 review，也违背配置与执行分离。

使用 Node 而不是 `.sh`：

- DAB 本身要求 Node >= 24.9；
- Java/Android 项目也可能在 Windows 上开发；
- iOS 的 Xcode 只在 macOS，但 runner 本身可以跨平台；
- Node 可以直接 spawn 项目命令、读取 JSON 快照并统一输出。

生成文件都带明确 header：

```text
// dab-gate-runner: <dab-version> sha256=<hash>
```

JSON 快照使用 `generated.dabVersion` / `generated.sha256` 记录来源和内容哈希。

更新规则：

- runner 代码稳定；只有 DAB 升级需要更新时，normalize 才更新未修改的旧 runner；
- 快照由 normalize 从 authored 配置重新编译；
- 用户修改过 runner 或快照时保留并报告 modified，不静默覆盖；
- 快照缺失或无效时 runner 报 `CONFIG`，不能退回内置命令或静默通过。

### 7.2 执行语义

runner：

1. 从项目根目录读取 `scripts/dab-gates.json`；
2. 先运行 source gate：`dab detect --strict`；
3. 再按快照运行 code/docs 命令；
4. 每个 gate 独立收集状态、退出码、耗时和输出摘要；
5. 所有 gate 都跑完再汇总，不短路；
6. 任一 required 失败或 CONFIG，非零退出；
7. `--strict` 让 check/advisory 的失败也导致非零退出；
8. `--json` 输出机器可读结果；人类输出保持简短，完整输出可流式显示。

DAB 二进制解析顺序：

1. `DAB_BIN` 环境变量；
2. 项目 `node_modules/.bin/dab`；
3. PATH 中的 `dab`；
4. `npx --no-install @saydone/dab`（禁止网络安装）。

找不到 DAB 时输出 `GATE source ERROR` 和安装提示，不得跳过 source gate。

### 7.3 退出码

- `0`：所有 required 通过；check/advisory 可有 warning；
- `1`：至少一个 required 失败；
- `2`：配置无效、必需命令无法解析、runner 无法执行。

`--strict` 只改变 check/advisory 是否导致 `1`，不改变 `2`。

## 8. 技术栈检测

### 8.1 数据模型

`ScanResult` 增加 `stacks: ScanStack[]`，保留现有 `language` 作为文档/模板的展示主语言；`ScanStack` 至少包含：

```ts
interface ScanStack {
  id: 'node' | 'python' | 'go' | 'rust' | 'java-maven' | 'java-gradle'
    | 'android' | 'ios-swiftpm' | 'ios-xcode';
  language: ProjectLanguage;
  platform?: 'android' | 'ios';
  commands: ScanCommandSet;
  evidence: string[];
  diagnostics: Diagnostic[];
}
```

`ProjectLanguage` 增加 `java`、`kotlin`、`swift`、`objective-c`。`platform` 与语言分离，避免把 Android/iOS 当成语言。

检测只读文件，不在 `init` 时执行 `xcodebuild`、`gradle` 或 `mvn`。

### 8.2 检测矩阵

| Stack | 检测证据 | 默认命令 | 说明 |
|---|---|---|---|
| Java Maven | `pom.xml`；`mvnw`/`mvnw.cmd` | `./mvnw test` / `mvn test`；`./mvnw -DskipTests compile` | 有 wrapper 用 wrapper；无 wrapper 用 `mvn` |
| Java Gradle | `build.gradle[.kts]` 或 `settings.gradle[.kts]`，且无 Android plugin | `./gradlew test` / `gradle test`；`./gradlew classes` | 与 Android 冲突时 Android 优先 |
| Android | Gradle 文件含 `com.android.application`/`com.android.library`，或 `app/src/main/AndroidManifest.xml` | `./gradlew test`；`./gradlew lint`；`./gradlew assembleDebug` | 默认不跑 `connectedAndroidTest`；需要设备 |
| iOS SwiftPM | `Package.swift` | `swift test`；`swift build`；有 `.swiftlint.yml` 时 `swiftlint` | 可自动执行 |
| iOS Xcode | `*.xcodeproj` 或 `*.xcworkspace`；`Podfile`/`Cartfile` 作为证据 | test/build 由 `xcodebuild` 结构化字段或 Fastlane command 提供；缺失为 `needs-config`；有 `.swiftlint.yml` 时 `swiftlint` | 不猜 scheme、configuration、simulator destination；要求 shared scheme |
| Node/TS/JS | 现有 `package.json` + lockfile | 现有 scanner 命令 | 保持不变 |
| Python | 现有 pyproject/setup/requirements | pytest/ruff/mypy（检测到才加入） | 保持不变 |
| Go | `go.mod` | `go test ./...`、`go build ./...`、`go vet ./...` | 保持不变 |
| Rust | `Cargo.toml` | `cargo test`、`cargo build`、`cargo clippy -- -D warnings` | 保持不变 |

### 8.3 冲突和缺工具

- Android 与 Java Gradle 同时命中：选择 Android 作为 primary，Java Gradle 不重复加入 code 命令；evidence 保留。
- SwiftPM 与 Xcode 同时命中：SwiftPM 作为可自动执行的 primary；Xcode 只报告证据和 `needs-config`，不重复跑 test。
- Maven 与 Gradle 同时命中：报告 `scan.multiple-java-builds` warning，不自动二选一；需要 `.agents/gates.yaml` 覆盖或删除多余构建文件。
- wrapper 存在但不可执行：保留命令，runner 运行失败时 fail loud；不静默退回系统工具。
- 工具不存在（`mvn`、`gradle`、`swift`、`xcodebuild`）：命令仍是检测结果；gate 失败并提示安装/配置，不静默 skip。
- iOS Xcode 的必需 test 命令未配置：生成 `command: null` 或缺少 `xcodebuild.scheme`/`destination`，detect 报告 `verification.command-needs-config`，runner 报 `CONFIG`；不能以“没检测到命令”作为通过。
- Xcode scheme 应提交为 shared scheme；`dab detect` 可以把 `xcodebuild -list -json` 和 `xcrun simctl list devices` 作为提示，但 runner 不自动执行探测，也不自动选择 destination。

### 8.4 默认 required/advisory

- test：检测到可执行命令时为 `required`；
- typecheck：Node/Python 等有检测结果时为 `required`，无命令则不生成；
- lint：默认 `advisory`；
- build：默认 `advisory`，避免每次 gate 都做完整打包；
- `needs-config` 的 test：如果配置为 required，则阻断，直到项目填写 scheme/destination 或 Fastlane command；
- 项目可以在 `.agents/gates.yaml` 中改写任何非 source 命令的级别。

## 9. `dab detect` 的 Verification 组

在 `dab detect` 的 checklist 增加 `Verification` 组。实际诊断码和 strict 映射如下：

| 检查 | 级别 | `--strict` |
|---|---|---|
| `verification.config-missing` | warning | 失败 |
| `verification.config-invalid` | error | 失败 |
| `verification.config-unreadable` | error | 失败 |
| `verification.config-yaml` | error | 失败 |
| `verification.starter-invalid` | error | 失败 |
| `verification.runner-missing` | warning | 失败 |
| `verification.runner-stale` | warning | 失败 |
| `verification.runner-modified` | warning | 不失败 |
| `verification.runner-unversioned` | warning | 不失败 |
| `verification.runner-newer` | warning | 不失败 |
| `verification.snapshot-missing` | warning | 失败 |
| `verification.snapshot-stale` | warning | 失败 |
| `verification.snapshot-modified` | warning | 不失败 |
| `verification.snapshot-unversioned` | warning | 不失败 |
| `verification.snapshot-newer` | warning | 不失败 |
| `verification.command-needs-config` | warning | 失败 |
| `verification.command-missing` | error | 失败 |
| `verification.commands-empty` | warning | 不失败 |
| `verification.ci-missing` | warning | 不失败 |
| `verification.artifact-path` | error | 失败 |
| `verification.artifact-concurrent-change` | warning | 不适用 |

映射规则：

- 任何 error 都使 `detect` 以校验失败退出，`--strict` 不改变这一点。
- warning 默认使 `--strict` 失败；`runner-modified`、`runner-unversioned`、`runner-newer`、`snapshot-modified`、`snapshot-unversioned`、`snapshot-newer`、`commands-empty` 和 `ci-missing` 是保留状态或项目状态，保持非 strict。
- `artifact-path` 表示配置、runner 或快照路径冲突，是阻断性 error。
- `artifact-concurrent-change` 不会由 `detect` 产生：它表示 plan 与 apply 之间文件被并发修改，只在 `normalize` 写入阶段报告为 warning；写入被保留，不会覆盖用户修改。
- `starter-invalid` 表示 scanner 默认值生成了无效 starter，是 DAB 自身错误，不应由项目配置修复。

`source` gate 始终由 `dab detect --strict` 自己检查；Verification 组只检查 runner、snapshot、config 和命令接线，不执行项目命令。

升级既有项目时先运行 `dab normalize` 补齐或更新配置、runner 和快照，再运行 `dab detect --strict`；否则缺失或过期的生成物会让 strict 失败。`normalize` 保留 modified、unversioned 和 newer 生成物，这些状态不会因重跑而自动消失，需要人工核对。

### 9.1 报告内容

每行至少包含：

- gate 维度或命令；
- 当前状态；
- 预期命令/配置要求；
- 修复入口：`dab normalize`、编辑 `.agents/gates.yaml`、或补充 CI 调用。

CI 缺失只提示，不指定 GitHub Actions；文档提供 GitHub Actions、GitLab CI 等调用片段，v1 不自动写 CI 文件。

## 10. init / normalize

### 10.1 `dab init`

full 模式：

- 扫描 stacks；
- 缺失 `.agents/gates.yaml` 时按 scanner 生成 starter；
- 缺失 `scripts/dab-check.mjs` 时生成稳定 runner；
- 缺失 `scripts/dab-gates.json` 时生成配置快照；
- 已存在的配置、脚本、CI 文件一律保留；
- Xcode 项目生成 `needs-config`，不猜 scheme。

### 10.2 `dab normalize`

project scope：

- adoption/converge 补齐缺失的 gates 配置、runner 和快照；
- 配置存在时只校验，不覆盖；
- runner 未修改且版本较旧时更新；
- runner 被修改时保留并报告 `verification.runner-modified`；runner 无 marker 时保留并报告 `verification.runner-unversioned`；版本较新或无法比较时保留并报告 `verification.runner-newer`；
- 从 authored 配置重编译快照；快照被修改时保留并报告 `verification.snapshot-modified`；快照无生成元数据时保留并报告 `verification.snapshot-unversioned`；版本较新或无法比较时保留并报告 `verification.snapshot-newer`；
- 配置与快照不一致时报告 `verification.snapshot-stale`，等待 normalize 重渲染；
- 配置无效时阻止写入（all-or-nothing），不写部分 runner 或快照。

global scope：

- 不生成 gates 配置、runner 或快照；`detect` 也不要求 global gate。

### 10.3 与其他 pack 的关系

新增 `verificationPack`，加入 `PRACTICE_PACKS`，project-only：

- `targets()` 声明 `.agents/gates.yaml`、`scripts/dab-check.mjs` 和 `scripts/dab-gates.json`；
- `files()` 生成 starter、稳定 runner 和配置快照；
- 不经过 Claude target 投影，不写入 `.claude/`；
- 与 managed skills 使用相同的“只更新未修改受管文件”原则，但不复用 skill 目录布局；
- `scripts/` 仍受项目根路径校验，不能逃逸。

## 11. Runner 输出

人类可读示例：

```text
GATE source              PASS
GATE code.test           PASS   pnpm test
GATE code.typecheck      FAIL   pnpm typecheck (exit 2)
GATE code.lint           WARN   pnpm lint (advisory)
GATE docs                SKIP   not configured
GATE verification        WARN   CI not wired
```

JSON 示例：

```json
{
  "schemaVersion": 1,
  "gates": [
    {
      "id": "code.test",
      "status": "pass",
      "required": true,
      "command": "pnpm test",
      "exitCode": 0,
      "durationMs": 1200
    }
  ],
  "ok": true
}
```

JSON 不包含完整 stdout/stderr，只包含截断摘要或 `output` 路径；避免大输出污染 agent 上下文。

## 12. CI 接线

v1 不自动生成 CI 文件。主流工具通常提供 CI 片段或显式生成器，而不是在普通 init 中静默写 `.github/workflows/`：

- CI 提供商、权限、分支策略和发布流程因项目而异；
- workflow 是安全敏感文件，自动生成容易覆盖既有 release pipeline；
- `projen` 那类“CI 也由工具全量生成”的模式要求项目整体采用该工程模型，不适合作为 DAB 的默认行为。

本地和 CI 使用同一个 runner，保证 parity：

```yaml
- run: node scripts/dab-check.mjs --strict
```

`dab detect` 对没有 CI 接线的项目给出非 strict warning。未来如果增加 CI 生成，必须是显式 opt-in，只创建缺失文件，并标注 generated；不能默认接管项目 CI。

## 13. 安全与可移植性

- `.agents/gates.yaml` 是 authored source，命令是项目可信输入；DAB 不执行来自未确认网络的命令。
- runner 使用 `spawn`/`execFile` 的参数形式或明确 shell；不得把用户输入拼进 shell。
- 项目命令可以读取环境变量；DAB 不注入 token。
- `npx --no-install` 只允许本地已安装的 DAB，禁止网络安装。
- 不自动修改 `.github/`、`package.json` 或构建脚本。
- iOS/Android 的命令可能依赖 Xcode/Android SDK；缺工具时 fail loud，不假通过。
- 路径必须相对项目根；拒绝逃逸路径。

## 14. 测试与验收

### 14.1 Scanner

- Java Maven（wrapper/无 wrapper）→ 正确 test/compile；
- Java Gradle（wrapper/无 wrapper）→ test/classes；
- Android Gradle + plugin → android primary，test/lint/build；
- iOS SwiftPM → swift test/build；SwiftLint 可选；
- iOS Xcode → needs-config，绝不生成猜测的 xcodebuild；
- Maven+Gradle 冲突 → warning；
- Android+Java Gradle → Android primary，不重复命令；
- 现有 Node/Python/Go/Rust 行为不变。

### 14.2 Config / runner

- config schema 接受/拒绝正确，包括 `command`/`xcodebuild` 互斥和 Xcode 必填字段；
- required/advisory/check/off 状态；
- snapshot 编译稳定，hash 覆盖 `gates` 对象；
- runner 只读 snapshot，不内嵌项目命令；
- 所有 gate 执行后汇总，不短路；
- `--strict` 只提升 check/advisory；
- required 命令缺失 → CONFIG + 非零；
- DAB 不存在 → source ERROR + 非零；
- JSON 输出稳定；
- Windows 下 wrapper 选择（至少逻辑测试）。

### 14.3 Detect / normalize

- 缺失 config/runner/snapshot → 报告并 strict 失败；
- stale/modified/unversioned runner 和 snapshot 的状态；
- Xcode 结构化字段/Fastlane 配置的 detect 提示；
- init 只创建缺失文件；
- normalize 更新未修改 runner 和快照、保留 modified；
- global 不生成；
- 配置无效时零写入；
- 现有项目升级不覆盖 `.agents/gates.yaml`，并正确报告 runner/snapshot 状态。

### 14.4 验收

- Node、Java Maven、Java Gradle、Android、iOS SwiftPM 的 fixture 都能生成可执行 gate；
- iOS Xcode fixture 在缺少 scheme/destination 时明确输出 `CONFIG`，不输出假的 pass；
- 提供 `xcodebuild` 结构化字段或 Fastlane command 后，Xcode fixture 能生成 runner；
- 一个 required 失败时 runner 非零，其他 gate 仍运行；
- `dab detect --strict` 能发现缺失/过期 runner 和 snapshot；
- `dab normalize --dry-run` 与真实 apply 的报告一致；
- 文档提供 CI 片段，不自动写 CI。

## 15. 备选方案

**新增 `dab check` 命令。** 被拒绝：G1 的验收要求不新增命令；项目需要的是本地/CI 可调用的 runner，不是又一个需要 DAB 安装的入口。

**把所有命令硬编码在 DAB。** 被拒绝：项目技术栈和命令差异大；iOS 必须由项目提供 scheme/destination；硬编码会产生错误 gate。

**只生成一个 shell 脚本。** 被拒绝：Windows 的 Java/Android 开发需要跨平台；Node 已是 DAB 的前置条件。

**把项目命令嵌进 managed runner。** 不作为最终方案：它把配置和执行代码绑在一起，每次改命令都要重写 runner，难 review，也偏离 pre-commit/Nx/Turborepo 的稳定 runner 模式。最终选择稳定 `scripts/dab-check.mjs` + 生成 `scripts/dab-gates.json` 快照；marker 只用于生成物一致性。

**直接复制 deepseek-harness 的 `check:all`。** 被拒绝：它的 gate 清单是项目特定的；DAB 应复用聚合机制和技术栈适配，而不是复制业务命令。

**v1 自动生成 CI workflow。** 推迟：provider、权限和发布流程差异过大；先提供稳定 runner + 文档片段 + detect 提示。`projen` 式全量生成要求项目整体采用该模型，不作为 DAB 默认行为。

## 16. 风险

- 技术栈检测误判：用 evidence 和显式配置覆盖；冲突时 warning，不静默选择。
- iOS Xcode 无法自动配置：needs-config 是设计的一部分，不是遗漏；shared scheme 和 destination 由项目提供。
- 运行完整 build/lint 成本高：默认 advisory，项目按需升级。
- runner/snapshot 漂移：runner marker、snapshot hash + detect stale。
- 项目修改 runner 或 snapshot：保留并 warning，绝不静默覆盖。
- 生成的 runner/snapshot 增加项目文件：只在缺失时创建，清晰标注 generated/managed。
- Windows wrapper 选择：Java/Android 使用 `mvnw.cmd`/`gradlew.bat` 时必须有逻辑测试。

## 17. 迁移与兼容

- 0.1.2 项目：首次 `dab normalize` 补齐 gates 配置、稳定 runner 和快照；已有同名文件不覆盖。
- 没有检测到可执行命令的项目：生成空配置或 `needs-config`，detect 明确提示，不假通过。
- 已有 `.agents/gates.yaml`：按新 schema 校验；无效则阻止写入并给出迁移提示。
- 已有旧 runner（内嵌命令版本）：报告 stale；normalize 在未修改时替换为稳定 runner + 快照，修改过的保留并提示迁移。
- 不改变现有 manifest schema 的 `schemaVersion`；gate 配置和快照是独立文件。
- 不改变 `.claude/` 生成规则。

## 18. 已确定的边界

1. `.agents/gates.yaml` 始终 project-only；未来 profile 只生成 starter，不作为运行时 gate 来源。
2. runner 使用稳定代码 + 生成 `scripts/dab-gates.json` 快照；新增独立的 `dab-gate` generated marker，不复用 `dab-skill` 语义。
3. iOS Xcode 使用 shared scheme + 显式 destination，或 Fastlane command；缺失时 `CONFIG`，不自动执行 `xcodebuild -list` 选择。
4. CI v1 不自动生成；只提供片段和 detect 提示。未来若生成，必须显式 opt-in、只补缺失文件、标注 generated。
5. G1 不实现 change gate；同变更逻辑留给 G9。

## 19. 后续可选项

- 显式 opt-in 的 CI workflow 生成器。
- 在 detect 提示中展示 `xcodebuild -list -json` / `xcrun simctl list` 的命令示例，但不自动执行。
- G9 的 diff-aware change checklist/CI 检查。
- 为 gate snapshot 增加更多技术栈 provider；新增 provider 不改变 runner 协议。
