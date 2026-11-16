English | [中文](cli.zh.md)

# CLI

The public command is `dab`. All commands support `--json`, and exit codes distinguish usage, validation and backend problems.

## `dab init`

```bash
dab init [path] [--profile feature] [--ai] [--dry-run]
```

Scans the repository and writes missing authored files. Authored conflicts stop before writes. Unmanaged `.claude` conflicts are reported as pending and left to `dab normalize --fix`. `--dry-run` previews authored writes and pending conflicts without writing. `--ai` asks Claude Code for a proposal and writes only after confirmation; it cannot be combined with `--dry-run`.

## `dab detect`

```bash
dab detect [--json]
```

Runs checks without writing. It verifies Claude Code version, ancestor instruction files, projections, settings, policy, hooks, memory, secrets, AGENTS.md size and links.

## `dab normalize`

```bash
dab normalize [--dry-run] [--fix] [--json]
```

Plans or applies projection repairs, the `.claude/CLAUDE.md` shim, `.claude/settings.json`, `dab.yaml` hashes and `.gitignore`. Conflicts stop before writes. `--fix` backs up conflicting files under `.dab/backups/` before replacing them.

## `dab policy explain`

```bash
dab policy explain [--agent <name>] [--json]
```

Shows provider and version, default mode, allow/ask/deny rules, hooks in execution order, source files and limitations. With `--agent`, it adds the role's tools, disallowed tools, permission mode, memory mode and appended hooks.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Internal error |
| `2` | Usage or configuration error |
| `3` | Validation failure |
| `4` | Incompatible Claude Code version |

## JSON output

Successful JSON output is sorted and stable. Errors use the same envelope:

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

## Common examples

```bash
dab init
dab detect
dab normalize --dry-run
dab normalize
dab policy explain --agent reviewer
```

## Notes

- Generated files are never edited by hand.
- `.claude/settings.local.json` is user-owned and never read or written by DAB.
- `--fix` is explicit because it can replace conflicting files after backing them up.
