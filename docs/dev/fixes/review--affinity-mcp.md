---
status: review
created: 2026-11-19
updated: 2026-11-19
scope: Affinity desktop MCP integration
owner: Yv
related: [review--curated-apps-and-edits.md]
---

# Add Affinity to curated Apps

User requested Affinity MCP support. Shared task: `9ce5fc25-479c-4499-b7bf-b9a2ca661b3b`. Technical plan: `docs/dev/plans/implementation--affinity-mcp.md` (approved by the user, 2026-11-19).

- [?] Discover installed Affinity protocol, endpoint, auth, actions, and SDK requirements — `docs/dev/plans/implementation--affinity-mcp.md:5`.
- [?] Obtain technical plan approval before application changes — `AGENTS.md:37`.
- [?] Implement bounded persistent SSE connection with safe endpoint handling — `server/apps/mcp-client.ts:1` and new transport module.
- [?] Add Affinity catalog entry, actual icon, token-free setup, and Buddy guidance — `server/apps/catalog.ts:11`, `src/components/AppSetupDialog.tsx:1`.
- [?] Verify actions, renders, Edits compatibility, setup UI, and build — `server/apps/apps.test.ts:1`, new transport tests.
- [?] Commit implementation and move work to review — this document.

Read-only discovery completed successfully. No application source, native permissions, user documents, or external reports were changed. UI inspection is limited by unavailable Studio Preview and native ScreenCaptureKit capture failure.

## Verification — 2026-11-19

- Production build and final typecheck pass. Full suite: 536 passing, two known schedule backup-recovery failures (same cases established before this work). Final focused run after the remaining tests were added: 43/43 passing across app transport/status, setup rendering, and proxy tests. Tag parsing also passed in the earlier focused run.
- Fake SSE checks cover persistent sessions, exact initialization version, preamble-dependent script execution, concurrent request correlation, split UTF-8/multiline frames, invalid data, connection closure, unauthorized access, missing endpoints, POST/response timeouts, unsafe endpoints/redirects, idle expiry, resetting settings, and no automatic script replay.
- Static React rendering verifies Affinity has no token field, enables Test connection without a token, and has no misleading Disconnect control. Edits still renders its token field and requires a token before testing a new connection. This does not substitute for a live interactive UI check.
- Real Affinity 3.3.3, through the new app routing: discovered 11 actions; read the preamble and SDK topics; created a separate document, added a visible filled rectangle, saved it, and rendered its spread to JPEG. The original document's session remained open; scripts targeted only the new test document.
- Test artifact left for inspection: `/Users/esoefildine/Desktop/TEST · Studio Affinity MCP 20261119-1141.af`. Render evidence: `/tmp/affinity-live-render.jpg` (a filled rectangle is visible). No paid model calls, paid Canva AI, permission changes, shared-hint requests, or SDK issue reports were made.
- Live discovery also found that execute_script can put a JavaScript error in text while returning isError=false. Buddy guidance now calls this out. Affinity deprecated getUserDesktopPath in favor of userDesktopPath; guidance supports both.
- Remaining QA limit: Studio Preview reports unavailable and native ScreenCaptureKit inspection failed (-3811). No interactive Apps/setup/picker walkthrough is claimed. Actual app icon is extracted from the installed Affinity app and bundled locally.
