---
status: review
created: 2026-11-18
updated: 2026-11-18
scope: mid-response steering
owner: Yv
related: [review--room-user-cut-in.md]
---

# Course-correct running bots

User approved `docs/dev/plans/implementation--mid-turn-steering.md` on 2026-11-18.

- [?] Native Claude and Codex steering — `server/drivers/claude.ts`, `server/drivers/codex.ts`.
- [?] Reliable saved-message delivery and fallback in chats and rooms — `server/index.ts`.
- [?] Enter to steer, Alt+Enter to queue, transcript labels — `src/components/Composer.tsx`.
- [?] Driver/server tests and isolated UI verification.

## Verification and limits

- Typecheck passes. All 19 room/runtime tests pass, including native Claude/Codex input in DMs and rooms, attachment bytes and file context, repeated corrections, retained streamed text without duplication, unsupported-provider restart, late delivery, native refusal, Stop cancellation, and usage recovery after a delivered correction.
- Driver tests verify open Claude stdin and result cleanup, Codex native thread/turn identifiers, accepted and rejected RPC input, and steering after completion. The focused three-file run passed 58 tests before the additional usage-recovery test; that test passes in the final 19-test runtime file.
- Final Node 24.19.0 verification: typecheck passes; full suite 513/515 across 66 files. The only failures are the same two pre-existing `server/schedules-runtime.test.ts` backup-retry failures. All 19 room/runtime tests and all native driver tests pass. Earlier checks also ran under the shell’s Node 22 default.
- Live Codex 0.164.0, `gpt-6-luna`, isolated server at port 8978: sent correction after the shell `sleep 20` command started; correction marked native, final answer `CORRECTED`, exactly one turn start and one completion. Test thread: `e423465c-fa81-4a5a-a19a-b81a93140996`.
- Claude Code 2.1.312 live check could not reach a shell command: its account reported the five-hour usage limit. No claim of live Claude success. Fake-process protocol/server tests pass.
- Studio Preview attempt: session failed with “Preview frame did not become ready”, then reported stopped. No further actions taken in that session. Desktop fallback used a separate Electron renderer and profile (`/tmp/gbs-steering-desktop-profile`), loading the exact frontend from port 5298 against isolated server data. Native keyboard input verified the busy placeholder, Alt+Enter's queue chip, deferred send after completion, Enter's immediate correction, fallback tooltip, and “Stopped and redirected” label with retained partial reply. Accessibility and screenshot inspected; no persistent screenshot file claimed.
- Isolated data: `/var/folders/w8/_pb66q4j6cl7h6v3txs5nv4c0000gn/T/gbs-steering-qa-70gf0h87`. Real user data was not used for test messages. Real provider authentication was used only for the two small native checks. No active schedules remained.
- Trello synchronization failed with “Workspaces are full”; local board remains authoritative.
- User review pending after restarting Studio. Scheduled-run steering and edits during a running turn remain outside the supported scope of this change.
