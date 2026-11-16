---
name: doc-sync
description: Updates paired English and Chinese DAB documentation and runs the documentation gates.
---
# Documentation sync

1. Identify the English source and its `.zh.md` translation.
2. Update both sides and the `.i18n.yaml` record in the same change.
3. Keep headings, lists, tables, fenced code and inline code structurally identical.
4. Run `pnpm run verify-translation-pairing --write` after confirming the pair.
5. Run `pnpm doc-sync` and fix every failure.
