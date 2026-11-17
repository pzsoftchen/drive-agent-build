---
paths: ["src/**", "test/**"]
---
Write a failing test before production code.

- Watch the test fail for the expected reason.
- Run the focused test, then `pnpm test`.
- Do not weaken a test to hide an unrelated failure.
- Keep generated TypeScript out of `src/`.
