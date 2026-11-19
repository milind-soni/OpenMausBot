---
status: review
created: 2026-11-19
updated: 2026-11-19
scope: explicit Buddy consent in the approval box
owner: Yv
related: [review--affinity-mcp.md]
---

# Route permission requests through the approval box

User reported an Affinity file-copy request appearing as prose and requiring a typed “proceed.” Implement the requested existing approval-box behavior as a focused extension of the shared MCP proxy and permission-card path. Shared task: `170abbe6-60ce-4e96-a27d-d05b73dd91a3`.

- [?] Add shared `request_approval` and prompt guidance for MCP-capable Buddies — `server/drivers/agents-proxy.ts:29`, `server/approval-requests.ts:1`, `server/apps/catalog.ts:57`.
- [?] Show Allow / Deny / Always allow, await the decision, scope remembered permissions by Buddy/action/destination, and reject stale/foreign answers — `server/index.ts:287`.
- [?] Deny on timeout, disconnection, dismissal or stopped turn, and exclude explicit consent from idle auto-approval — `server/approval-requests.ts:1`, `src/lib/permissionAutoApprove.ts:13`.
- [?] Verify direct chat, rooms, remembered approvals, revocation, cancellation, proxy forwarding and live visible controls — `server/room-activity.test.ts:275`, `server/approval-requests.test.ts:1`.

Implementation uses a conversation capability accepted only while the matching Buddy owns the active thread. No action is executed by request_approval; it returns the decision to the calling Buddy. Approval requests are not treated as ordinary questions or automatically extracted from assistant prose.

## Verification

- Build and final typecheck pass. Full suite: 548 passing, two known pre-existing schedule backup-recovery failures; no new failures. Includes explicit approval broker, proxy, direct chat, rooms, remembered permission, revocation, stale response, cancellation and idle-exclusion regressions.
- Studio Preview, isolated app on port 8980, fake MCP-capable Buddy, disposable data and inert app endpoints: the actual approval box showed Allow / Deny / Always allow, remained waiting beyond 26 seconds without an auto-approve countdown, and Deny returned approved=false. Always allow returned approved=true/always=true; the same action/scope on a subsequent turn returned approved=true without another box. No real file copy or paid model request occurred.
- Evidence: `/Users/esoefildine/Documents/Dev/GererBuildStudio/.gbs-preview-evidence/35b25a49-9791-4b1b-8689-81bec31bdde0.png`. The first capture included an internal action ID in the scope explanation; final copy says “this action” instead. Diagnostics: no page/network errors; only the existing Electron development CSP warning.
- Test fixture correction: fake ACP session/load now restores the injected MCP configuration, matching the real session/load contract. Without that correction, resumed test turns silently omitted the shared tools. Conversation-scoped capabilities remain stable for reused MCP processes, while the endpoint requires an active matching bot/thread.
- Explicit consent applies to MCP-capable Buddies. Provider permission cards retain their existing idle-auto-approval behavior. Existing prose messages are historical; requests are not inferred from arbitrary text.
