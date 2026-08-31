# Localization pipeline (lingo.dev)

Status: scaffold — the JSON catalog migration lands in this same PR before
it leaves draft.

- `i18n.json` — source `en`, seven targets, JSON bucket at
  `src/locales/[locale].json`.
- `i18n.lock` — seeded from the hand-authored packs at migration time, so
  the first pipeline run translates NOTHING; only future en-catalog deltas
  are sent out.
- `.github/workflows/i18n.yml` — on en-catalog changes on main, translates
  the delta and opens a PR. Inert until the `LINGO_API_KEY` repo secret is
  set (add with: `gh secret set LINGO_API_KEY -R milind-soni/OpenMausBot`).
- Engine: the workspace key must have an engine enabled in the lingo.dev
  dashboard (or add a `provider` block + a model API key for BYO mode).
- Local run: `LINGO_API_KEY=… npx lingo.dev@latest run`.
- Hand-edits to packs remain welcome; the lockfile only tracks the SOURCE
  side, so human fixes to translations are never overwritten.
