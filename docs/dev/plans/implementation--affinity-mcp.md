# Affinity desktop MCP integration

Requested by the user on 2026-11-19. Status: awaiting implementation approval under AGENTS.md. Work branch: `feat/affinity-mcp`; isolated worktree: `/Users/esoefildine/Documents/Dev/GBS-worktrees/yv-affinity`.

## Verified requirements

- Installed Affinity by Canva version 3.3.3 listens on IPv6 loopback, port 6767. `GET http://[::1]:6767/sse` emits an SSE `endpoint` event pointing to `/message?session_id=…`.
- The installed app rejects protocol `2025-06-18`; its advertised supported version is `2025-11-25`.
- Read-only discovery returns 11 tools: SDK documentation, script execution, document/selection rendering, saved scripts, hints, and SDK issue reporting. The connection did not require a bearer token. Setup must follow Affinity's own Model Context Protocol settings, not Edits' token instructions.
- `execute_script` requires the SDK preamble to have been read. Maintain the same connection between discovery, documentation reads, execution, and rendering.
- SDK filesystem access, when permitted by Affinity, is limited to the Desktop. Do not copy user files or broaden permissions automatically.
- Native app icon is available at `/Applications/Affinity.app/Contents/Resources/AppIcon.icns`.
- Existing harness app tools already forward image content from app results to Buddies through `renderAppResult`; verify this path for Affinity renders.

## Implementation

1. **Connection layer** (`server/apps/mcp-client.ts`, new SSE transport module/tests): add an explicit local SSE transport alongside existing streamable HTTP. Affinity uses `2025-11-25`; leave Edits' handshake unchanged. Parse incremental UTF-8 SSE frames, endpoint/message events, correlate request IDs, initialize once, and retain the session with bounded idle cleanup. Bound connect, handshake, POST, and response waits. Cancel/close on failure, setting changes, and shutdown. Reconnect on the next operation after failure; never automatically replay a script or other mutating action. Reject redirects and server-advertised endpoints outside the original loopback origin. Handle concurrent discovery/calls without duplicate initialization or crossed responses.
2. **Catalog and setup** (`server/apps/catalog.ts`, `store.ts`, `status.ts`, `use.ts`, `src/state/apps.ts`, `src/components/AppSetupDialog.tsx`, `AppsScreen.tsx`): register `affinity`, category design, actual bundled icon, `+affinity`, default endpoint `http://[::1]:6767/sse`, no-token auth, and verified setup instructions. Hide the token field for no-token apps and enable Test connection. Keep normal model support tags, status, advanced address, and composer discovery. A no-token app is controlled by its native MCP switch; do not show a misleading token-based Disconnect action. Saving custom addresses resets the transport/session; testing default connection should not require writing settings.
3. **Buddy guidance** (`catalog.ts`, existing prompt path): describe vector design, photo editing, page layout, reusable scripts, and visual inspection without promising every design task succeeds. Require SDK preamble/relevant docs before scripts, render for verification, respect native permission failures and Desktop access, ask before copying files, never send SDK reports or shared hints without explicit user permission. Explain that reconnecting requires rereading the preamble.
4. **Documentation** (`README.md`, repository board): describe Affinity setup, local connection, supported Buddies, and native permissions. Preserve Edits instructions.

## Verification and delivery

- Fake SSE server tests for initialization/version, persistent session and preamble-dependent execution, concurrent requests, split/multiline frames, malformed responses, unauthorized/stopped server, deadlines, stream closure, redirect/foreign endpoint rejection, and no automatic script replay.
- App tests for no-token status/setup, `+affinity`, action forwarding, image results, setting changes/session cleanup, and Edits regressions. Tests use disposable data and local fake servers only.
- Run typecheck, relevant tests, full suite, and production build. Report the two previously known schedule recovery failures separately if still present.
- Read-only handshake against installed Affinity, then a clearly named `TEST ·` document workflow, provided creation can be isolated from the user's open document. Do not save over existing documents, consume paid AI credits, enable native permissions, or send reports/hints externally.
- Use Studio Preview for Apps/setup/picker UI QA and screenshots once available. Native capture currently fails with ScreenCaptureKit error -3811; Preview currently reports unavailable. Report any unresolved visual QA limitation honestly.
- Commit locally. Merge only within the user's authorized delivery scope; do not push. Move implemented board items to review for user verification.

## Sources

- Official product: https://www.affinity.studio/
- Official SDK: https://sdk.affinity.studio/3.3.3/js/
- Vendor connector listing: https://claude.com/marketplace/connectors/affinity-106b90
- Installed Affinity MCP initialize/tools-list/preamble responses observed 2026-11-19 (no authentication secrets collected).
