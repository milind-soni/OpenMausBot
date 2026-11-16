---
status: todo
created: 2026-11-16
updated: 2026-11-16
scope: bot-controlled desktop Preview testing
owner: Yv
related: []
---

# Let bots test websites inside Preview

Implementation awaits explicit approval of `docs/dev/plans/implementation--bot-preview-testing.md`, as required by AGENTS.md for complex work. Only planning documentation has been changed.

- [ ] Implement owned sessions, bounded command broker and bot tools — `server/preview-testing.ts` (new), `server/drivers/agents-proxy.ts`.
- [ ] Implement desktop bridge and actual Preview guest inspection/input/screenshots/diagnostics — `electron/preview-testing.mjs` (new), `electron/main.mjs`.
- [ ] Add visible bot ownership, session selection and Stop/take-control — `src/components/PreviewFrame.tsx`, `src/components/MobilePreviewPanel.tsx`, `src/components/PreviewScreen.tsx`.
- [ ] Wire supported provider tools independently of peer-delegation depth; document capability limits — `server/index.ts`, `server/contracts.ts`.
- [ ] Verify local fixture end to end, concurrent ownership, cancellation, actual viewport/evidence, isolation and regressions; document results for review.
