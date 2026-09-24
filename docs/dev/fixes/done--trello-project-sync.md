---
status: done
created: 2026-08-14
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: trello project sync
owner: claude
related: [done--shared-task-board]
---

# Complete the shared task board and add per-project Trello sync

Finish the shared task board's agent/user parity, then add a genuinely new capability: connect
the user's own Trello account from Settings, link any registered project to a Trello board
(existing or newly created), and keep that project's tasks synced both ways. Out of scope:
Trello webhooks (no public endpoint to receive them from a local machine — sync is push-on-write
plus poll/pull instead), and any change to the separate repository-maintenance board sync
(`pnpm trello:sync`, `docs/dev/fixes/TRELLO.md`), which this work does not touch.

---

## 1. Agent/user parity

- [x] **Add a `delete_task` agent tool with matching internal route** — `server/drivers/agents-proxy.ts:113`, `server/index.ts:1028`. Agents now have full parity with the UI: list, create, claim, update, delegate, and delete.
- [x] **Give Codex-driven bots task board access** — `server/drivers/codex.ts` (`agentsConfigOverrides`, `capabilities.agentsMcp: true`). Codex's `app-server` has no per-thread `mcpServers` RPC param, so the agents-proxy is mounted via `-c mcp_servers.gbs_agents.*` TOML overrides at spawn time — verified end to end against a live `codex app-server` via `mcpServerStatus/list` before landing. Antigravity (`agy` CLI) still has no equivalent mechanism (confirmed via `agy --help`); it needs upstream ACP support before it can offer these tools.

## 2. Trello account connection

- [x] **Add write-only `trello` config with a browser token-authorize handshake** — `server/config.ts:13`, `server/trello.ts:1`, `server/index.ts` (`/api/trello/authorize-url`, `/trello/callback`, `/api/trello/token`). The app API key is pasted once in Settings; the personal token comes from Trello's own authorize page, never typed by hand.
- [x] **Add Settings UI to connect/disconnect Trello** — `src/components/ApiKeys.tsx:9`, `src/components/SettingsScreen.tsx` (`TrelloConnectionRow`, `ConnectionsSection`).

## 3. Project ↔ board linking

- [x] **Persist per-project Trello links** — `server/trelloLinks.ts:1` (`TrelloLinkStore`), atomic writes and external-change reconciliation, same style as `TaskStore`.
- [x] **Add board list/create/link/unlink/sync-now routes** — `server/index.ts` (`/api/trello/boards`, `/api/trello/links`, `/api/trello/links/:projectId`, `/api/trello/links/:projectId/sync`).
- [x] **Add a Trello linking modal reachable from the Task Board** — `src/components/TaskBoardScreen.tsx` (`TrelloLinkModal`), pick an existing board or create one, per registered project.

## 4. Two-way sync engine

- [x] **Track the mirrored Trello card on each task and a distinct sync actor** — `server/tasks.ts` (`trelloCardId`, `trelloCardUrl`, `linkTrelloCard`, `TaskActor` `"sync"` kind), mirrored client-side in `src/lib/taskBoard.ts`.
- [x] **Push local task changes to Trello and pull board changes back** — `server/trelloSync.ts:1` (`TrelloSync.pushTask`, `archiveTask`, `pullProject`, 45s poller). Pull only applies a Trello-side change when the card is both newer and actually different, so a pull immediately after a push is always a no-op.
- [x] **Wire push/archive into every task mutation route** — `server/index.ts`, public and internal `/api/tasks*` / `/api/internal/tasks*` handlers.
- [x] **Show the linked Trello card on cards and in the task detail modal** — `src/components/TaskBoardScreen.tsx` (`TaskCard`, `TaskModal`).

## 5. Verification and documentation

- [x] **Cover the Trello client, link store, and sync engine** — `server/trello.test.ts`, `server/trelloLinks.test.ts`, `server/trelloSync.test.ts`. Mocked `fetch`, real `TaskStore`/`TrelloLinkStore` instances, covering push create/update/404-recreate, archive, pull new-card creation, pull idempotency (no echo), pull conflict resolution, and `sync`-actor attribution.
- [x] **Cover the new HTTP surface and `delete_task`** — `server/index.test.ts`, `server/drivers/agents-proxy.test.ts`.
- [x] **Document the feature** — `README.md` ("Link a project to Trello"), `.env.example` (clarify `TRELLO_API_KEY` also seeds the in-app connection).

`pnpm typecheck`, `pnpm test` (218 passing), and `pnpm build` all pass. A manual pass against a
real Trello account (connect, link, push, pull, "Sync now", disconnect) is left for the reviewer
since it requires live Trello credentials this session does not have.
