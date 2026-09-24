---
status: done
created: 2026-09-24
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: Claude permissions when app runs as root
owner: SoSo
related: [docs/dev/fixes/done--agent-permission-toggle.md]
---

# Keep Claude usable when the app runs as root

Claude rejects bypassPermissions under root, so a saved Full auto setting prevents turns from starting.

---

## 1. Root-safe launch

- [x] **Use Claude's prompted permission mode under root** — `server/drivers/claude.ts:230`. Start the broker so turns can complete.
- [x] **Show the effective mode and reject unsupported Full auto changes** — `server/drivers/claude.ts:205`, `server/index.ts:1600`, `src/components/SettingsScreen.tsx:323`.
- [x] **Cover root behavior with isolated tests** — `server/drivers/claude.test.ts:50`, `server/instances-permission.test.ts:90`.

Verified with Node 24: 23 focused tests pass and TypeScript type checking passes.
