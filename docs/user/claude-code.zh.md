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

## Frontmatter 兼容性

- Agent、skill 和 rule frontmatter 可能随 Claude Code 演进而获得新的顶层字段。
- DAB 校验它解释的字段，并对未知顶层字段发出警告；fact 仍会被投影。
- 警告会提示接近的已知字段（例如 `pathz` → `paths`）。scope 或权限 key 的拼写错误会扩大实际生效的规则或工具集，因此 CI 中应把这些警告视为错误。
- DAB 自有的 hook、policy、manifest 或 memory YAML 中的未知字段仍然是错误。

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
- 物理 `.claude/agents/*.md` 文件或 `.claude/skills/<dir>` 目录是 import 候选，不是 unmanaged 冲突。其他未记录且尚不匹配预期产物的 path 是 unmanaged。`dab normalize --fix` 会先把 unmanaged path 备份到 `.dab/backups/` 再替换或移除；没有 `--fix` 时 `normalize` 拒绝写入。
- 未记录为 projection 的条目符号链接由 `--fix` 在存在 authored `.agents` source 时先备份再修复。没有 authored source 的链接是冲突，必须手动移除；DAB 从不导入或删除 unmanaged 链接。
- `normalize` 会采用并记录未记录但已指向预期 source 的符号链接，或已匹配配置模式的 instruction 产物，无需重写。身份检查使用真实路径，因此逃逸 scope root 的符号链接 `.claude` 目录会失败，而不是写到目录之外。

## Adoption 与 import

- `dab normalize` 会把物理 `.claude/agents/*.md` 文件和 `.claude/skills/<dir>/SKILL.md` 目录复制到 authored `.agents` 树。本阶段不导入 rules、`.claude/settings.json`、hooks 和 `CLAUDE.md`。
- `.agents` 是事实源。现有 source 文件或 skill 目录永不被覆盖；当 `.claude` 内容不同时，normalize 会警告并保留 `.agents` 副本。
- 原 `.claude` 条目会备份到 `.dab/backups/<timestamp>/` 并替换为逐项符号链接。首次 import 会复制整个 skill 目录（包括额外文件）；当 `.agents/skills/<name>` 已存在时，额外文件不会合并，并保留在备份中。
- Import 使用 `.claude` 的 basename 或目录名。frontmatter `name` 仍是 fact id；不一致会警告，但不会重命名条目。
- Import 不需要 `--fix`。`.claude/agents` 或 `.claude/skills` 上的目录符号链接是冲突，因为 DAB 逐项拥有条目。
- `dab detect` 在每个 phase 都以只读方式运行同一份 import 计划，因此已初始化 scope 会报告 `[IMPORTABLE]`，且不会把同一条目再报告为 unmanaged 或 physical-copy 漂移。
- `dab init` 从不 import：它在现有 `.claude` 树上保持既有行为，adoption/import 仍是 normalize 的职责。
- `dab normalize --dry-run` 预览 import、backup 和 symlink 计划，包括计划备份路径。人类输出列出 adoption source 动作、import 动作和备份。
- 任何非法候选都会阻止所有写入：不采用 source、不执行 import、不备份。导入新条目的那次运行会在下一次运行时记录这些投影，因此重跑 `dab normalize` 可让 `dab detect` 干净。
- Global scope 在 `$HOME` 下使用相同规则：`$HOME/.claude` 下的物理条目会导入 `~/.agents` 并链接回去。`~/.claude/settings.json` 和 `$HOME/.gitignore` 保持只读。

## 记忆模型

- 共享记忆是高级、可选能力。DAB 默认不生成 `.agents/memory/`；已有文件仍会被校验和管理。
- 团队共享事实放在 `.agents/memory/`，并在拉取请求中评审。
- 个人自动记忆留在机器本地，从不提交。
- Agent 可以使用 `memory: user` 或 `memory: local`，但 `memory: project` 会被拒绝，因为它会形成第二套团队记忆。
- `dab eval` 计划在 v0.2 提供，并将使用空记忆目录。
- Global scope 会跳过祖先和个人记忆检查，因为用户级 Claude 数据不是项目产物。

## 权限与 hooks

Hooks 是高级、可选能力。DAB 默认不生成 `.agents/hooks/`；已有 hooks 仍会被校验并投影到 `.claude/settings.json`。

项目策略被编译进 `.claude/settings.json`。项目 deny 规则是 Claude Code 文件工具的硬边界，但 `Bash`、包装命令和其他工具可以绕过路径规则。Agent 定义可以收窄工具并追加 hooks，但不能移除项目 hooks。Agent hooks 必须调用受管 `.agents/hooks/<id>/` 条目生成的命令；任意 inline shell 命令都会被拒绝。接受的形式是 node hook 的 `node "${CLAUDE_PROJECT_DIR}/.agents/hooks/<id>/<entry>"` 或 exec hook 的 `"${CLAUDE_PROJECT_DIR}/.agents/hooks/<id>/<entry>"`；agent hook id 不得与项目 hook id 冲突。Hook 脚本会检查路径逃逸、重复 id、换行符、执行权限和敏感信息。

## Global Settings

- 本阶段 `~/.claude/settings.json` 归用户所有。DAB 报告警告，不读取、不写入、不合并该文件。
- `$HOME/.gitignore` 同样只读。
- Global 的 instructions、agents、skills 和 rules 仍通过 `$HOME` 下的投影文件对齐。
- 显式 global settings adoption 和 merge 属于后续计划；在此之前请在你自己的 settings 中维护 global 权限和 hooks。

## 故障排查

1. 运行 `dab detect --json`，按 code 阅读诊断；`[IMPORTABLE]` 条目指出已初始化和 preflight scope 中 normalize 将采用的 `.claude` agents 和 skills。
2. 运行 `dab normalize --dry-run` 查看计划的 source 和修复动作；加 `--json` 并阅读 `adoption.imports` 预览 import。
3. 运行 `dab normalize` 执行 adoption 和 import，并在 import 后重跑以记录新投影。
4. 只有在检查备份路径后才运行 `dab normalize --fix` 处理非 import 冲突。
5. 运行 `dab policy explain --target claude-code --agent <name>` 查看最终权限。
6. 运行 `dab --help` 查看命令列表。
