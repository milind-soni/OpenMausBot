# Upgrading production from the desktop backend

Production Convex runs `desktop-archive:backend/convex`. This release keeps that schema byte for byte and pushes the
web app's `convex/` on top. The steps below were rehearsed on a local copy (2026-11-01). Nothing was run against
production.

## Rehearsal (local only)

```sh
# 1. The current production code on a fresh local deployment
git archive desktop-archive backend shared server scripts/testing | tar -x -C /tmp/archive
cd /tmp/archive/backend && npm install
unset CONVEX_DEPLOYMENT CONVEX_DEPLOY_KEY; export CONVEX_AGENT_MODE=anonymous
npx convex dev --once --local-cloud-port 3280 --local-site-port 3281

# 2. Production-shaped data through its own functions (auth:signup, workspaces, projects, tasks, comments,
#    realtime:send/openDirect/markRead/registerFile, agents + agentThreads + agentRuns running/queued/finished),
#    plus pending jobs for agentRuns.promoteQueued/expireStale, standup.runAll/runProject and realtime.cleanup
#    scheduled a few minutes ahead (a throwaway internal mutation). Then stop that backend.

# 3. The upgrade: same database, this repository's convex/
cp -a /tmp/archive/backend/.convex <repo>/ && cd <repo>
printf 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n' > .env.local
npx convex dev --once --local-cloud-port 3280 --local-site-port 3281
```

## Findings

- The push succeeds in about 5 s: no schema validation errors, no index added or removed.
- The six pending jobs (`agentRuns.promoteQueued`, `agentRuns.expireStale`, `standup.runAll` with and without `now`,
  `standup.runProject`, `realtime.cleanup`) ran on the upgrade stubs and finished as `success`. Every other function
  production schedules still exists with compatible arguments. Crons that this release drops are removed by the push.
- Sign-in with an existing password, the board, issue view, comments, Inbox and MCP work on the old rows, on desktop
  and on a phone. `list_issues`, `get_issue` and `create_issue` on a new personal access token answer with issue links.
  `claude mcp list` connects. An older-protocol `initialize` (2025-06-18) also works.
- Fixed: chat history. The desktop app stored chat in Convex (`teamChatMessages`, `teamChatFiles`,
  `teamDirectConversations`, `teamChatReads`); the web app reads chat from the Next server's store, so history looked
  empty after the upgrade. The first chat request in a workspace now copies its workspace and direct messages,
  attachment files and read markers once (`legacyChat.exportPage` over the signed bridge). This needs the same
  `ORIGIN_INTEGRATION_SECRET` in Convex and the Next server. A failed copy is logged and retried after 5 minutes.
- Not carried over, by design: project conversations (`project:<id>`), agent threads and runs, standups and other
  desktop-only tables. Their rows stay in Convex untouched.
- Desktop apps still open during the upgrade lose the functions they call. Ask people to close them first.

## Production checklist

1. Back up: `npx convex export` with the production deploy key, run by the operator.
2. Check the production Convex environment has `ORIGIN_INTEGRATION_SECRET`, `ORIGIN_PUBLIC_URL` and
   `ORIGIN_SEALING_KEY` (keep an existing sealing key; changing it makes stored GitHub credentials unreadable).
3. `/home/z4mbo/Dev/.origin-tools/cvx/schema-parity.sh <repo>` prints `same` for every file.
4. Deploy Convex (`npx convex deploy`), then the Next server with the same secret and the persistent `/data/origin`.
5. Smoke: sign in, open a board and an issue, open Chat (history appears), check `/api/mcp` answers 401 without a
   token, read both logs.
6. In a later release, remove the upgrade stubs (`convex/agentRuns.ts`, `standup.ts`, `realtime.ts`) once no job
   scheduled by the old code can still be pending.
