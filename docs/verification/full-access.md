# Full Access workflows

Run the isolated integration recipe:

```sh
pnpm exec vitest run server/full-access-workflows.e2e.test.ts
pnpm exec vitest run server/team-setup-requests.test.ts server/profile-requests.test.ts server/routine-requests.test.ts
pnpm exec electron scripts/smoke-approval-modes.cjs --all-threads-only
pnpm typecheck
pnpm lint
```

The test launches its own temporary server through `launchVerificationServer`,
creates fixture bots and tasks, then stops that exact child before seeding
Full Access into its disposable saved state. It restarts against the same
temporary home with a restricted environment. No production grant bypass or
live application data is used. Both server processes are stopped before the
fixture is removed.

The repository's scripted Claude fixture calls the real injected agents MCP
proxy. Its tool choices and final narration are deterministic, not evidence
of a real provider's planning quality or authentication.

## What it checks

- One Full Access turn updates the Chief's profile, creates a monthly cron
  routine with an explicit timezone, saves an enabled skill, creates a named
  Research team and specialist, and updates the active Chief's own setup.
- A later turn updates the named skill, pauses the routine, updates the
  specialist, and deletes that exact specialist through the normal lifecycle.
  Saved profiles, routines, skill content, scope grants, and deletion are
  checked independently of the scripted reply.
- Immediate tool results say the change was applied. No unanswered review
  card or extra setup continuation appears, and new specialists retain Ask.
- Real peer coordination succeeds with `approvePeerComms` enabled. Its one
  downstream summary is expected; unrelated setup continuations are not.
- An explicit Ask sibling retains four pending reviews even though the bot
  default is Full. Conversely, an explicit Full thread applies its profile
  change while the bot default remains Ask.
- An expired turn token is refused, and Full does not authorize changes to
  an existing bot outside the Chief's team scope.

## Evidence and limits

The desktop smoke uses a disposable Electron utility-process server and the
real private approval bridge. It covers one confirmed Full Access grant for
all existing, archived and future threads, including mixed Claude, Codex,
Grok and Antigravity providers. Other bots and per-thread model choices stay
unchanged. The real settings confirmation is driven in a hidden fixture
window, including Cancel, the all-threads checkbox and the committed result.
Screenshots are saved under `.omb-scratch/verify-evidence/provider-fixes/`.
Provider processes are fake; this does not test live account access.

The fixture retains `<server-log>.full-access.json` beside its server log.
It contains safe request/results, persisted-state snapshots, and bounded MCP
call evidence with thread IDs and provider permission modes. It excludes
the injected bearer token and provider environment. Temporary app data is
removed after the run.

The first recipe verifies server and MCP behavior, not the rendered review UI,
desktop permission-grant gesture, or real-model instruction following. The
test starts from fixture-only saved grants; it does not test granting Full
Access through the desktop.
