---
status: done
created: 2026-08-15
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: model switch history
owner: codex
related: []
---

# Preserve context across model switches

Ensure that a bot which starts its next turn on a newly selected model or provider receives the active visible conversation history. This covers fresh provider sessions without changing the existing native-session continuation behavior.

---

## 1. Server context handoff

- [x] **Replay the active transcript when a newly selected provider has no resumable session** — `server/index.ts:448`. Keep the latest user message separate and provide prior visible text turns as context to the fresh session.
- [x] **Cover cross-instance model switching end to end** — `server/branching.test.ts:1`. Assert that the newly selected model receives the prior turn as well as the new request.
