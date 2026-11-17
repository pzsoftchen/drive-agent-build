[English](architecture.md) | 中文

# 架构

DAB 是控制面，不是 Agent runtime。它把编写的源事实编译为 harness 配置，并让两侧保持可比较。本阶段只有 Claude Code 是已实现的 target。

## 事实源

| 事实 | 编写位置 | 投影 |
|---|---|---|
| 项目指令 | `AGENTS.md` | `.claude/CLAUDE.md` 符号链接或生成垫片 |
| 角色 | `.agents/agents/` | `.claude/agents/` 符号链接 |
| Skills | `.agents/skills/` | `.claude/skills/` 符号链接 |
| 规则 | `.agents/rules/` | `.claude/rules/` 符号链接 |
| 共享安全策略 | `.agents/policies/project.yaml` | `.claude/settings.json` |
| Claude Code 策略 | `.agents/adapters/claude-code.yaml` | `.claude/settings.json` |
| Hooks | `.agents/hooks/` | `.claude/settings.json` |
| 共享记忆 | `.agents/memory/` | 按需读取 |
| 个人记忆 | Claude Code 自动记忆 | 机器本地 |
| 决策 | `.agents/notes/` | 按需读取 |
| 元数据 | `dab.yaml` | 逐 target 的生成记录 |

Global scope 使用同样的结构，编写位置是 `~/.agents/`，target root 是 `$HOME`。Project 和 global scope 相互独立：DAB 从不合并两者，也不提供 `dab global` 命令。

## Scope 与 Roots

| Scope | Source root | Manifest | Target roots |
|---|---|---|---|
| Project | `<repo>/.agents/` 和 `<repo>/AGENTS.md` | `<repo>/dab.yaml` | `<repo>` 下 |
| Global | `~/.agents/` 和 `~/.agents/AGENTS.md` | `~/.agents/dab.yaml` | `$HOME` 下 |

- 位置决定 scope。Manifest 的 `scope` 字段只校验解析出的 scope，绝不覆盖它。
- `dab init [path]` 把 `path` 或当前目录作为确切的 source root，并在缺失时创建它。`dab init ~/.agents` 引导 global scope。
- 其他命令从当前目录向上查找最近的、包含 `dab.yaml` 或 `.agents/` 的目录。位于 `$HOME/.agents` 内时改用 global scope。
- `scope: global` 的 manifest 必须解析到 `$HOME/.agents`；`scope: project` 的 manifest 不得解析到那里。
- `dab init` 拒绝在已有 source root 内部创建 source root，因此嵌套 `.agents` tree 是错误。
- Project 命令只写入仓库根下；global 命令只写入 `$HOME` 下。超出 scope root 的 target path 是错误。

## 核心循环

1. `dab init` 扫描仓库并为一个 scope 写入编写骨架。
2. `dab normalize` 解析 scope root，预检每个启用的 target，并在全部预检通过后才写入。
3. `dab detect` 在不写入的前提下检查漂移、所有权和 scope。
4. `dab policy explain --target <provider>` 展示单个 target 的最终结果。

## Target 与 Adapter

v2 manifest 声明 `scope`、`targets` 和逐 target 的生成记录：

```yaml
version: 2
scope: project
targets:
  - provider: claude-code
    enabled: true
    options:
      minVersion: 2.1.277
      instructions: symlink
paths:
  agents: .agents
  claude: .claude
```

- Target adapter 把 common facts 映射到一个 harness，并解析该 target 的 provider options。Adapter 绝不拥有 agent、skill 或 rule 定义。
- Common facts 位于 `.agents/`；provider 专属策略位于 `.agents/adapters/<provider>.yaml`；provider options 位于 target 的 `targets` 条目。
- 每个 target 在 `generated.targets` 下按 provider 记录自己的 settings、instructions 和 projections。
- 本阶段只有 `claude-code` 有 adapter。启用 `codex` 或 `dsh` target 会以 `target.unsupported` 失败，而不是跳过或写入部分配置。
- Codex、DSH 和 global settings adoption/merge 属于后续计划系列，不在本阶段。

## 所有权与失败语义

- 只有当 manifest 的生成记录表明 DAB 创建了某个 target path 时，它才是 managed：指向预期 source 的符号链接，或与记录哈希匹配的生成文件。
- 其他已存在的文件、目录或外来符号链接是 unmanaged。`normalize` 和 `detect` 报告冲突，冲突存在时 `normalize` 不写入任何内容。
- `dab normalize --fix` 在采用前把 unmanaged target path 移入带时间戳的 `.dab/backups/` 目录。没有 `--fix` 时，DAB 永不替换或删除 unmanaged path。
- 已配置但没有安全映射的 target 是错误。一个 target 失败会阻止所有 target 的写入，因此运行不会留下半对齐的树。
- `--dry-run` 运行同一预检和退出码，但不写入。
- 根 `CLAUDE.md` 归用户所有，始终是致命冲突。

## Claude Code 指令

- `.claude/CLAUDE.md` 默认是指向 scope 指令的符号链接：project scope 为 `../AGENTS.md`，global scope 为 `../.agents/AGENTS.md`。
- `instructions: generated` 改为写入 `@../AGENTS.md` 导入垫片。当 Claude Code 构建无法跟随符号链接时使用它。
- `instructions: disabled` 不写入指令产物，并移除 managed 产物。
- Managed 产物原地修复。Unmanaged 产物需要 `--fix`，且会先备份。
- 指令记录为 `generated` 状态，绝不是 `native`，因为 DAB 物化了 Claude Code 读取的产物。

## Global Settings

- Global scope 可以在 `$HOME` 下对齐 instructions、agents、skills 和 rules。
- 本阶段 `~/.claude/settings.json` 归用户所有：DAB 报告警告，不读取、不写入、不合并它。
- `$HOME/.gitignore` 同样归用户所有且只读。
- 显式的 global settings adoption 和 merge 属于后续计划。

## 组件

- `src/cli.ts` 分发命令并拥有退出码。
- `src/commands/` 实现 `init`、`detect`、`normalize` 和 `policy explain`。
- `src/model/` 解析编写文件、解析 scope 并发现 agents、skills、rules、hooks 和 memory。
- `src/adapter/types.ts` 定义 target adapter 契约。
- `src/adapter/registry.ts` 把 provider 名映射到 adapter；只注册了 `claude-code`。
- `src/adapter/claude-code/` 编译策略、渲染 settings 并管理指令和投影产物。
- `src/detect/` 包含漂移和安全检查。
- `src/init/` 扫描仓库并渲染模板。
- `src/docs/` 运行双语文档门禁。

## 生成输出

- `.claude/settings.json` 是确定性的 project 产物；本阶段 global settings 只读。
- `.claude/CLAUDE.md` 默认是指向 scope 指令的符号链接，生成的导入垫片是显式 fallback。
- `.claude/agents/`、`.claude/skills/` 和 `.claude/rules/` 包含逐项符号链接。
- `dab.yaml` 保存 `scope`、`targets` 以及逐 target 的生成记录，包含 source 哈希、target 哈希和投影清单。
- `.dab/backups/` 在 `--fix` 采用 unmanaged path 前保存原始文件。

## 策略编译

共享策略只覆盖路径读写限制、命令执行限制和少量能力集合。Claude Code 专属规则放在 adapter 中。deny 优先，精确的 allow/deny 冲突会让编译失败，而不是扩大权限。

```yaml
version: 1
defaultMode: default
write:
  deny:
    - .claude/settings.json
execute:
  ask:
    - git push
```

## 文档门禁

每个人类文档使用 `foo.md`、`foo.zh.md` 和 `foo.i18n.yaml`。门禁检查语言切换、章节结构、围栏代码、行内代码、链接 locale 和哈希。`AGENTS.md` 等指令文件保持英文单源，并由链接、排版和预算门禁覆盖。

## 边界

- DAB 不运行自己的 Agent Loop。
- DAB 不导入 Claude Code 内部实现。
- DAB 从不编辑 `.claude/settings.local.json`。
- Adapter 只映射 facts 和解析 provider options；绝不拥有 agent、skill 或 rule 定义。
- 无法表达的 provider 语义会显式失败，而不是静默扩大权限；一个 target 失败会阻止所有写入。
- 本阶段 DAB 不合并 project 和 global scope，也不采用 global settings。
- 路径 deny 规则是工具级护栏，不是沙箱；`Bash`、`Grep`、`Glob`、`NotebookEdit` 和包装命令可以绕过。
- Hooks 是可信的可执行代码；DAB 只检查元数据和静态安全，不检查运行时行为。
- v0.1 没有 eval 循环；证据工作记录在 `docs/roadmap.md`。
- v0.1 只接受默认的 `.agents` 和 `.claude` 路径。
