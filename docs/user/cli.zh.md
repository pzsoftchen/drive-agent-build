[English](cli.md) | 中文

# CLI

公开命令是 `dab`。所有命令都支持 `--json`，退出码区分配置用法、校验和后端问题。

## `dab init`

```bash
dab init [path] [--profile feature] [--ai]
```

扫描仓库，写入缺失的编写文件，然后运行 normalize。已有编写文件会被跳过。`--ai` 让 Claude Code 生成提案，确认后才写入。

## `dab detect`

```bash
dab detect [--json]
```

只检查不写入。它验证 Claude Code 版本、祖先指令文件、投影、settings、策略、hooks、记忆、敏感信息、AGENTS.md 大小和链接。

## `dab normalize`

```bash
dab normalize [--dry-run] [--fix] [--json]
```

规划或应用投影修复、`.claude/CLAUDE.md` 垫片、`.claude/settings.json`、`dab.yaml` 哈希和 `.gitignore`。冲突会在写入前停止。`--fix` 会在替换前把冲突文件备份到 `.dab/backups/`。

## `dab policy explain`

```bash
dab policy explain [--agent <name>] [--json]
```

展示 provider 和版本、默认模式、allow/ask/deny 规则、按执行顺序排列的 hooks、来源文件和限制。使用 `--agent` 时会追加角色的 tools、disallowed tools、权限模式、记忆模式和后追加的 hooks。

## 退出码

| 代码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 内部错误 |
| `2` | 用法或配置错误 |
| `3` | 校验失败 |
| `4` | Claude Code 版本不兼容 |

## JSON 输出

成功的 JSON 输出已排序且稳定。错误使用相同的信封：

```json
{
  "ok": false,
  "error": {
    "code": "usage.unknown-command",
    "message": "unknown command: wat",
    "exitCode": 2
  }
}
```

## 常见示例

```bash
dab init
dab detect
dab normalize --dry-run
dab normalize
dab policy explain --agent reviewer
```

## 说明

- 生成文件永远不手工编辑。
- `.claude/settings.local.json` 归用户所有，DAB 从不读写它。
- `--fix` 必须显式指定，因为它可能在备份后替换冲突文件。
