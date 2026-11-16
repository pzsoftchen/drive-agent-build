---
paths: ["docs/**", "README.md", "CONTRIBUTING.md", ".agents/notes/**"]
---
Human-facing documentation is paired English and Simplified Chinese.

- Every `foo.md` has `foo.zh.md` and `foo.i18n.yaml`.
- Update both languages and the record in the same change.
- Keep headings, lists, tables, fenced code and inline code structurally identical.
- Run `pnpm doc-sync` before committing.
- Do not translate commands, paths, configuration keys or code blocks.
