---
paths: ["docs/**", "README.md", "CONTRIBUTING.md", ".agents/notes/**"]
---
Human-facing documentation is paired English and Simplified Chinese.

- Every `foo.md` has `foo.zh.md` and `foo.i18n.yaml`, except `docs/superpowers/specs/` and `docs/superpowers/plans/`, which are Chinese-only unless explicitly requested.
- The superpowers exception skips pairing, not the link or wrap checks.
- Update both languages and the record in the same change.
- Keep headings, lists, tables, fenced code and inline code structurally identical.
- Run `pnpm doc-sync` before committing.
- Do not translate commands, paths, configuration keys or code blocks.
