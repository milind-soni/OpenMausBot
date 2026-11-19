---
status: doing
created: 2026-11-19
updated: 2026-11-19
scope: Affinity desktop MCP integration
owner: Yv
related: [review--curated-apps-and-edits.md]
---

# Add Affinity to curated Apps

User requested Affinity MCP support. Shared task: `9ce5fc25-479c-4499-b7bf-b9a2ca661b3b`. Technical plan: `docs/dev/plans/implementation--affinity-mcp.md` (awaiting approval).

- [?] Discover installed Affinity protocol, endpoint, auth, actions, and SDK requirements — `docs/dev/plans/implementation--affinity-mcp.md:5`.
- [~] Obtain technical plan approval before application changes — `AGENTS.md:37`.
- [ ] Implement bounded persistent SSE connection with safe endpoint handling — `server/apps/mcp-client.ts:1` and new transport module.
- [ ] Add Affinity catalog entry, actual icon, token-free setup, and Buddy guidance — `server/apps/catalog.ts:11`, `src/components/AppSetupDialog.tsx:1`.
- [ ] Verify actions, renders, Edits compatibility, setup UI, and build — `server/apps/apps.test.ts:1`, new transport tests.
- [ ] Commit implementation and move work to review — this document.

Read-only discovery completed successfully. No application source, native permissions, user documents, or external reports were changed. UI inspection is limited by unavailable Studio Preview and native ScreenCaptureKit capture failure.
