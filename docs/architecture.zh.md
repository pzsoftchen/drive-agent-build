[English](architecture.md) | 中文

# 架构

DAB 是控制面，不是 Agent runtime。它把项目的编写事实编译为 Claude Code 配置，并让两侧保持可比较。

## 事实源

| 事实 | 编写位置 | 投影 |
|---|---|---|
| 项目指令 | `AGENTS.md` | `.claude/CLAUDE.md` 导入垫片 |
| 角色 | `.agents/agents/` | `.claude/agents/` 符号链接 |
| Skills | `.agents/skills/` | `.claude/skills/` 符号链接 |
| 规则 | `.agents/rules/` | `.claude/rules/` 符号链接 |
| 共享安全策略 | `.agents/policies/project.yaml` | `.claude/settings.json` |
| Claude Code 策略 | `.agents/adapters/claude-code.yaml` | `.claude/settings.json` |
| Hooks | `.agents/hooks/` | `.claude/settings.json` |
| 共享记忆 | `.agents/memory/` | 按需读取 |
| 个人记忆 | Claude Code 自动记忆 | 机器本地 |
| 决策 | `.agents/notes/` | 按需读取 |
| 元数据 | `dab.yaml` | 生成的哈希 |

## 核心循环

1. `dab init` 扫描仓库并写入编写骨架。
2. `dab normalize` 编译策略、写入 settings 并投影符号链接。
3. `dab detect` 在不写入的前提下检查漂移。
4. `dab policy explain` 展示最终生效的结果。

## 组件

- `src/cli.ts` 分发命令并拥有退出码。
- `src/commands/` 实现 `init`、`detect`、`normalize` 和 `policy explain`。
- `src/model/` 解析编写文件并发现 agents、skills、rules、hooks 和 memory。
- `src/adapter/claude-code/` 编译策略、渲染 settings 并管理投影。
- `src/detect/` 包含漂移和安全检查。
- `src/init/` 扫描仓库并渲染模板。
- `src/docs/` 运行双语文档门禁。

## 生成输出

- `.claude/settings.json` 是确定性的构建产物。
- `.claude/CLAUDE.md` 是 `AGENTS.md` 的生成导入垫片。
- `.claude/agents/`、`.claude/skills/` 和 `.claude/rules/` 包含逐项符号链接。
- `dab.yaml` 保存生成哈希和投影清单。
- `.dab/backups/` 在 `--fix` 替换冲突前保存原始文件。

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
- 无法表达的 provider 语义会显式失败，而不是静默扩大权限。
