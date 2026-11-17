---
name: feature-delivery
description: Delivers one scoped DAB feature with failing tests, implementation, docs and verification.
---
# Feature delivery

1. Read `AGENTS.md` and the task.
2. Find the smallest relevant module and test file.
3. Write a failing test.
4. Run the focused test and confirm the expected failure.
5. Implement the smallest change.
6. Run `pnpm test` and `pnpm typecheck`.
7. Update English and Chinese docs and the pairing record.
8. Run `pnpm doc-sync`.
9. Summarize changed files, tests and risk.
