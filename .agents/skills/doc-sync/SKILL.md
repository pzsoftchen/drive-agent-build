---
name: doc-sync
description: Updates paired English and Chinese DAB documentation and runs the documentation gates, including Chinese-only superpowers specs and plans.
---
# Documentation sync

1. For `docs/superpowers/specs/` and `docs/superpowers/plans/`, update the Chinese-only source directly and skip pairing unless the user explicitly requests a bilingual pair.
2. For all other documentation, identify the English source and its `.zh.md` translation.
3. Update both sides and the `.i18n.yaml` record in the same change.
4. Keep headings, lists, tables, fenced code and inline code structurally identical.
5. Run `pnpm run verify-translation-pairing --write` after confirming the pair.
6. Run `pnpm doc-sync` and fix every failure.
