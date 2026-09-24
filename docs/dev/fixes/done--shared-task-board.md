---
status: done
created: 2026-08-13
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: shared task board
owner: codex
related: []
---

# Add a shared task board for users and agents

Add a server-backed Kanban board where users and agents can create, inspect, claim, delegate, and update structured project work. This task includes live synchronization, project and agent assignment, searchable filters, safe concurrent claiming, and agent-facing tools. Autonomous background scheduling and external issue-tracker synchronization are out of scope.

Review feedback on 2026-08-13: an agent bulk-imported valid tasks by replacing `tasks.json` directly. The already-running harness retained its earlier in-memory snapshot, so the board remained empty. The task returned to implementation to add safe external-file reconciliation, board-open refresh, and clearer agent guidance.

---

## 1. Task domain and persistence

- [x] **Define and persist structured task records** — `server/tasks.ts:1`, `server/store.ts:1`. Store status, project, assignee, type, priority, tags, descriptive content, actor metadata, timestamps, and a revision while validating malformed or stale writes. Reconcile valid external file replacements before reads or mutations.
- [x] **Expose task commands and live task events through the harness** — `server/index.ts:1`. Support list, create, update, claim, delegate, and delete operations with conflict-safe state transitions and SSE updates.

## 2. User task board

- [x] **Add a first-class Task Board destination** — `src/App.tsx:1`, `src/components/Sidebar.tsx:1`, `src/state/store.tsx:1`. Integrate board navigation and live task state without adding a second client transport. Refresh the canonical board snapshot whenever the destination opens.
- [x] **Build an accessible, filterable Kanban interface** — `src/components/TaskBoardScreen.tsx:1`. Let users create, edit, move, assign, filter, and remove tasks using the existing visual system and keyboard-accessible controls.

## 3. Agent task tools

- [x] **Let agents discover, claim, create, update, and delegate tasks** — `server/drivers/agents-proxy.ts:1`, `server/index.ts:1`. Add authenticated MCP tools that attribute changes to the calling bot and return actionable conflict details. Explicitly prohibit direct `tasks.json` edits.

## 4. Verification and documentation

- [x] **Cover persistence, API, agent-tool, and reducer behavior** — `server/tasks.test.ts:1`, `server/index.test.ts:1`, `server/drivers/agents-proxy.test.ts:1`, `src/lib/taskBoard.test.ts:1`. Use isolated test data and observable events rather than real user storage or sleeps. Cover external replacement followed by reads and mutations.
- [x] **Document the shared task workflow and its boundaries** — `README.md:1`. Explain user controls, agent commands, filtering, claiming semantics, and the lack of autonomous scheduling in the first version.
