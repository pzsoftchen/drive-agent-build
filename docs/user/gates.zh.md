[English](gates.md) | 中文

# 项目门禁

门禁是 `dab init` 和 `dab normalize` 生成的项目本地执行入口。runner 检查 DAB 源漂移，并运行项目自己的 code 和 docs 命令。门禁文件始终 project-only：global scope 不生成它们，门禁也不新增 `dab` 命令。

## 文件

| 路径 | 归属 | 用途 |
|---|---|---|
| `.agents/gates.yaml` | authored | 门禁 mode、命令和项目配置需求。 |
| `scripts/dab-check.mjs` | generated | 稳定 runner；不包含项目命令。 |
| `scripts/dab-gates.json` | generated | 从 authored 配置和 scanner 结果编译的快照。 |

- `.agents/gates.yaml` 是 authored source。`dab init` 和 `dab normalize` 只在缺失时创建，永不覆盖。
- `scripts/dab-check.mjs` 带 `// dab-gate-runner: <version> sha256=<hash>` 标记。`scripts/dab-gates.json` 记录 `generated.dabVersion` 和规范化 `gates` 对象的 SHA-256 hash。
- Normalize 更新未修改的较旧 runner 或过期快照。被修改、无版本或较新的生成文件会保留并产生 warning；永不覆盖或降级。
- runner 只读取 JSON 快照。它不解析 YAML，也不内嵌项目命令。

## 前置条件

- 运行 runner 需要 Node.js `>=24.9`。
- 固定 `source` gate 需要 DAB 二进制。runner 依次解析 `DAB_BIN`、`node_modules/.bin/dab`、`dab`（位于 `PATH`），最后是 `npx --no-install @saydone/dab`；它永不从网络安装。
- Xcode、Android SDK、Maven、Gradle 或 Swift 等项目工具必须已安装。缺少工具会让对应命令失败，绝不静默跳过。

## 配置

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

- `version` 为 `1`；未知版本是配置错误。
- `source.mode` 始终是 `required`，不能关闭。
- `code.commands` 接受 `test`、`typecheck`、`lint` 和 `build`。命令条目必须有且只有一个 `command` 或 `xcodebuild`。
- `command` 是项目可信的命令字符串，由平台 shell 在项目根目录执行。`command: null` 表示命令需要项目配置，不是通过。
- `xcodebuild` 要求 `project` 或 `workspace` 二选一，并提供 `scheme` 和 `destination`；`configuration` 可选。Normalize 会把它编译成快照中等价的 `xcodebuild test ...` 命令。
- `docs.command` 可选。没有它时 docs gate 报告 `SKIP`，因为生成的 docs 和 practice 已由 `source` gate 检查。
- 显式空 `code.commands: {}` 是允许的。当配置和 scanner 都没有命令时，runner 报告 `WARN`，`dab detect` 报告 `verification.commands-empty`；两者都不是假通过。当 scanner 检测到命令而配置为空时，`dab detect` 改为报告 `verification.command-missing`。

`test` 和 `typecheck` 是 scanner 要求的维度。当 scanner 检测到其中一个而配置省略它时，`dab detect` 报告 error（`verification.command-missing`）。唯一的豁免方式是显式写入 `mode: off`；删除键不是豁免。

| Mode | 失败行为 |
|---|---|
| `required` | Runner 非零退出；`dab detect --strict` 把缺失的必需命令视为 error。 |
| `check` | 报告 `WARN`；只在 `--strict` 时阻断。 |
| `advisory` | 报告 `WARN`；只在 `--strict` 时阻断。 |
| `off` | 报告 `SKIP`；显式豁免，永不视为通过。 |

`check` 和 `advisory` 当前共享 runner 行为。`check` 用于项目计划提升的检查，`advisory` 用于可选或高成本工作。

## 命令与退出码

```bash
node scripts/dab-check.mjs
node scripts/dab-check.mjs --strict
node scripts/dab-check.mjs --json
```

- runner 先执行 `source`，再执行每个已配置的 code 和 docs 命令。失败后不会短路。
- 人类输出为每个 gate 打印一行 `GATE <id> <STATUS>`，最后打印 `GATE RESULT PASS|FAIL exit <code>`。
- `--json` 输出 `{ schemaVersion, gates, ok }`。每个 gate 包含 `id`、`status`、`required`、`command`、`exitCode` 和 `durationMs`；输出会截断为简短摘要。
- `0`：所有 required gate 通过；check 和 advisory gate 可以有 warning。
- `1`：至少一个 required gate 失败，或 `--strict` 提升了 warning。
- `2`：快照无效或缺失、命令未解析、缺少 DAB 二进制或其他 runner 错误。

每个 gate 状态是 `PASS`、`FAIL`、`WARN`、`SKIP`、`CONFIG` 或 `ERROR` 之一。`CONFIG` 覆盖 `command: null` 条目和无效或缺失快照；缺少 DAB 二进制是 `ERROR`。两者都以 `2` 退出，且 `CONFIG` 无论条目 mode 如何都退出 `2`。使用 `mode: off` 显式豁免命令。

## Detect 集成

`dab detect` 增加 project-only 的 `Verification` 组，检查 config、runner、快照、命令接线和 CI 引用，不执行项目命令。`dab detect --strict` 是固定的 `source` gate。

- 缺失 config、runner 或快照，以及未修改但过期的产物，都是 warning，会让 `--strict` 失败。
- 无效、不可读或格式错误的配置是 error：`verification.config-invalid`、`verification.config-unreadable` 或 `verification.config-yaml`。
- scanner 检测到但配置省略的必需命令是 `verification.command-missing`，即 error。
- 未解析命令是 `verification.command-needs-config`，会让 `--strict` 失败的 warning；runner 报告 `CONFIG`。
- 被修改、无版本和较新的 runner 或快照会保留并保持非 strict：`verification.runner-modified`、`runner-unversioned`、`runner-newer`、`snapshot-modified`、`snapshot-unversioned` 和 `snapshot-newer`。
- 缺少 CI 引用是 `verification.ci-missing`，非 strict。完全没有命令是 `verification.commands-empty`，非 strict。
- 受管门禁路径不是普通文件或会逃逸项目时，`verification.artifact-path` 是 error；planning 和写入之间文件被并发修改时，`verification.artifact-concurrent-change` 是 normalize 阶段的 warning。
- `verification.starter-invalid` 表示 scanner 默认值生成了无效 starter；应作为 DAB bug 报告。

升级既有项目时，先运行 `dab normalize` 再运行 `dab detect --strict`，以便创建或刷新缺失、过期的门禁产物。被保留的 modified、unversioned 和 newer 产物需要人工评审。

空命令 warning 在不同工具间可能不同：`dab detect` 让 `verification.commands-empty` 保持非 strict，因为它描述项目状态；而 `node scripts/dab-check.mjs --strict` 会让 runner 的 `WARN` 变成退出码 `1`。

## 技术栈检测

`dab init` 和 `dab normalize` 在不执行构建工具的情况下检测这些技术栈：

| Stack | 证据 | Starter 命令 |
|---|---|---|
| Java Maven | `pom.xml`；`mvnw` 或 `mvnw.cmd` | `./mvnw test` 和 compile，或 `mvn test` 和 compile。 |
| Java Gradle | 没有 Android plugin 的 `build.gradle[.kts]` 或 `settings.gradle[.kts]` | `./gradlew test` 和 `classes`，或对应的 `gradle` 命令。 |
| Android | Android Gradle plugin 或 `app/src/main/AndroidManifest.xml` | `./gradlew test`、`lint`、`assembleDebug`；unit test，不是 connected test。 |
| iOS SwiftPM | `Package.swift` | `swift test`、`swift build`；`swiftlint` 在存在 `.swiftlint.yml` 时加入。 |
| iOS Xcode | `*.xcodeproj`、`*.xcworkspace`、`Podfile` 或 `Cartfile` | test 为 `needs-config`；不猜 scheme 或 destination。 |
| Node、Python、Go、Rust | 现有 lockfile 和构建文件 | 保持现有 scanner 行为。 |

- 优先使用 wrapper。在 Windows 上，runner 把 `./mvnw` 映射为 `mvnw.cmd`，把 `./gradlew` 映射为 `gradlew.bat`。
- Maven 加 Gradle/Android 是有歧义的，保持 `needs-config` 并产生 scanner warning；保留一个构建系统或设置显式命令。
- Android 抑制重复的 Java Gradle 命令。SwiftPM 优先于 Xcode 证据；只有 Xcode 的项目始终是 `needs-config`。
- starter 选择一个主技术栈，每个维度一个命令。需要多个技术栈命令的混合仓库必须覆盖 `.agents/gates.yaml`；v1 没有多命令维度。

## Xcode 与 Fastlane

Xcode test 和 build 命令必须显式配置。不要依赖猜测的 scheme、configuration 或模拟器。

```yaml
      test:
        xcodebuild:
          workspace: App.xcworkspace
          scheme: App
          destination: platform=iOS Simulator,name=iPhone 16
        mode: required
```

如果项目使用 Fastlane，改为写普通命令：

```yaml
      test:
        command: bundle exec fastlane test
        mode: required
```

- 把 scheme 作为 shared scheme 提交。
- 没有 `scheme`/`destination` 或 Fastlane 命令时，`.agents/gates.yaml` 保留 `command: null` 和 `needs` 说明。`dab detect` 报告 `verification.command-needs-config`，runner 报告 `CONFIG`；永不报告假通过。
- DAB 不运行 `xcodebuild -list` 或 `xcrun simctl list`；请自行选择 destination。

## CI

DAB 不生成 CI 文件。手动把同一个 runner 加入 CI provider，保证本地和 CI 行为一致：

```yaml
- run: node scripts/dab-check.mjs --strict
```

GitLab CI 示例：

```yaml
gate:
  script:
    - node scripts/dab-check.mjs --strict
```

`dab detect --strict` 会在没有已识别的 CI 文件时报告非 strict 的 `verification.ci-missing` warning；识别依据是引用 `scripts/dab-check.mjs`。CI 接线与 provider 无关；DAB 不要求 GitHub Actions。

## 相关

- [CLI](cli.zh.md)
- [Claude Code 集成](claude-code.zh.md)
- [架构](../architecture.zh.md)
- [G1 Gate 设计](../superpowers/specs/2026-11-25-g1-gate-design.md)
