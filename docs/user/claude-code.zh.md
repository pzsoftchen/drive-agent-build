[English](claude-code.md) | 中文

# Claude Code 集成

DAB 面向 Claude Code `>=2.1.277`，只写入公开配置格式。本阶段它是唯一已实现的 target。

## Claude Code 读取什么

- `.claude/CLAUDE.md` 提供项目指令，默认是指向 `AGENTS.md` 的符号链接。
- `.claude/agents/` 提供项目子 Agent。
- `.claude/skills/` 提供项目 Skills。
- `.claude/rules/` 提供路径规则。
- `.claude/settings.json` 提供权限和 hooks。
- `.claude/settings.local.json` 提供本地用户设置，归用户所有。

`AGENTS.md` 仍是唯一编写指令源。Global scope 在 `$HOME` 下使用同样的布局，指令位于 `~/.agents/AGENTS.md`。

## 指令产物

- `.claude/CLAUDE.md` 在 project scope 是指向 `../AGENTS.md` 的符号链接，在 global scope 指向 `../.agents/AGENTS.md`。
- 部分 Claude Code 构建会关闭原生 `AGENTS.md` 加载，部分文件系统也无法可靠跟随链接。此时在 target 上设置 `instructions: generated`，改为写入导入垫片：project scope 为 `@../AGENTS.md`，global scope 为 `@../.agents/AGENTS.md`。
- 设置 `instructions: disabled` 会不写入指令产物，并移除 managed 产物。
- 根 `CLAUDE.md` 归用户所有且始终致命；把内容合并进 `AGENTS.md` 后删除它。
- 该产物记录为 `generated`，绝不是 `native`，因为 DAB 物化了 Claude Code 读取的文件。

```yaml
targets:
  - provider: claude-code
    enabled: true
    options:
      instructions: generated
```

## 所有权与冲突

- DAB 逐项链接 agents、skills 和 rules，而不是链接整个目录。这样后续可以保留 provider 专属文件，并让所有权明确。
- 生成记录决定所有权。已记录的 instruction 产物或 projection 符号链接发生漂移时会原地修复（`repair`/`repair-link`），不需要 `--fix` 或备份。
- 已记录的 settings 与预期内容不一致时会先备份再重写，即使该 path 是符号链接或目录。
- Projection target 上的物理文件或目录即使已记录也是冲突；未记录且尚不匹配预期产物的 path 是 unmanaged。`dab normalize --fix` 会先把它备份到 `.dab/backups/` 再替换；没有 `--fix` 时 `normalize` 拒绝写入。
- `normalize` 会采用并记录未记录但已指向预期 source 的符号链接，或已匹配配置模式的 instruction 产物，无需重写。身份检查使用真实路径，因此逃逸 scope root 的符号链接 `.claude` 目录会失败，而不是写到目录之外。

## 记忆模型

- 团队共享事实放在 `.agents/memory/`，并在拉取请求中评审。
- 个人自动记忆留在机器本地，从不提交。
- Agent 可以使用 `memory: user` 或 `memory: local`，但 `memory: project` 会被拒绝，因为它会形成第二套团队记忆。
- `dab eval` 计划在 v0.2 提供，并将使用空记忆目录。
- Global scope 会跳过祖先和个人记忆检查，因为用户级 Claude 数据不是项目产物。

## 权限与 hooks

项目策略被编译进 `.claude/settings.json`。项目 deny 规则是 Claude Code 文件工具的硬边界，但 `Bash`、包装命令和其他工具可以绕过路径规则。Agent 定义可以收窄工具并追加 hooks，但不能移除项目 hooks。Project-level hook 脚本会检查路径逃逸、换行符、执行权限和敏感信息。Agent-level hooks 只接受结构和重复 id 校验，不执行同等强度的 shell 安全审查。

## Global Settings

- 本阶段 `~/.claude/settings.json` 归用户所有。DAB 报告警告，不读取、不写入、不合并该文件。
- `$HOME/.gitignore` 同样只读。
- Global 的 instructions、agents、skills 和 rules 仍通过 `$HOME` 下的投影文件对齐。
- 显式 global settings adoption 和 merge 属于后续计划；在此之前请在你自己的 settings 中维护 global 权限和 hooks。

## 故障排查

1. 运行 `dab detect --json`，按 code 阅读诊断。
2. 运行 `dab normalize --dry-run` 查看计划的修复。
3. 只有在检查备份路径后才运行 `dab normalize --fix`。
4. 运行 `dab policy explain --target claude-code --agent <name>` 查看最终权限。
5. 运行 `dab --help` 查看命令列表。
