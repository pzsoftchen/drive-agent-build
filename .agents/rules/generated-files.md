---
paths: [".claude/**"]
---
Generated files under `.claude/` are DAB build artifacts.

- Do not edit `.claude/settings.json`, `.claude/CLAUDE.md`, or projected agents, skills and rules.
- Change `AGENTS.md` or `.agents/` and run `node dist/cli.js normalize`.
- Use `node dist/cli.js detect` to inspect drift.
- Use `--fix` only after reviewing the conflict and backup path.
