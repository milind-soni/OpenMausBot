# Self-modify: agents editing Astra's own code

Astra's agents can propose, apply, and roll back edits to this app's own
TypeScript. The capability is opt-in, and every edit travels the same pipeline
whoever starts it — a bot turn through the `self_modify` tool, or an operator
clicking Apply in Settings → Self-modify.

## What can be edited

Only `server/`, `shared/`, and `src/` sources, and only
`.ts/.tsx/.mts/.cts/.css/.json` files. Everything else — `electron/`,
`scripts/`, `docs/`, `ios/`, `android/`, `third_party/`, `node_modules`, the
user's home — is out of scope by construction rather than by pattern matching.

The machinery that makes self-modification safe sits on a protected list
(`server/self-modify.ts` and its tests, `electron/self-modify-watchdog.mjs`,
`package.json`, `pnpm-lock.yaml`, CI workflows, and anything under
`server/self-modify*`). A proposal that touches them is refused — a
comment-only touch counts — and so is any content that would disarm a guard
(`ASTRA_SELF_MODIFY`, the revert/verify helpers, the watchdog path), wherever
that content appears. The system can propose; it cannot touch its own leash.

## The pipeline

1. **Propose.** A proposal carries a reason and 1–8 whole files, each an
   `edit`, `create`, or `delete`. It is validated against the rules above and
   lands in `~/.astra/self-modify/pending/` — at most 20 waiting; a duplicate
   id, or an id that already has a journal entry, is refused.
2. **Apply.** The journal entry is written first, with byte-exact copies of
   every original, and only then are files written. Nothing is applied by
   halves: the journal is the undo record, and a crash mid-apply leaves a
   recoverable entry rather than a half-applied mystery.
3. **Preflight.** Changed server/shared `.ts` files must parse (Node's
   strip-types parse probe, the same mode the harness runs under), and a
   dependency change must `npm install --ignore-scripts`. Any failure reverts
   immediately and settles the entry as `reverted`.
4. **Trial boot.** An edit that touches `server/`, `shared/`, or
   `package.json` is only *proven* by the next start: boot adopts the entry,
   spawns the detached watchdog, and promotes it to `verified` when the
   listener is up. A crash, a wedged event loop, or a failed startup restores
   the originals — from the boot guard, the watchdog, or startup
   reconciliation, in that order of who notices first.
5. **Verify or revert.** Renderer-only edits have no boot to prove them, so
   the operator marks them verified by hand. Anything unproven can be reverted
   byte-for-byte at any time, and turning the feature off reverts whatever is
   still unproven.

Only one server-touching proposal may sit at `applied` at a time: a second one
would be built on files the first was about to restore.

## Where it is controlled

- **Feature flag:** `features.selfModify` in `~/.astra/config.json`, or
  `ASTRA_SELF_MODIFY=1`. It is read per request, so the switch takes effect
  without a restart.
- **Settings → Self-modify** (desktop): the switch, the inbox (Apply asks
  twice; Discard drops), the journal (per-entry Revert and Mark verified), and
  one **Revert all unproven** action.
- **Agent tool:** `self_modify` in the agents MCP proxy, only offered while
  the feature is on, with actions `list`, `propose`, `apply`, and `discard`.
  A turn may apply at most four edits; anything heavier is a report for the
  person, not a loop.

Renderer sources are read at build time. A dev server picks an applied `src/`
edit up on reload; a packaged app shows it after the next packaging run. Server
code takes effect on the next start, which is also where the trial boot judges
it.

## Verification

- `server/self-modify.test.ts` — the file-level mechanics on throwaway project
  roots: path/key refusals, journal snapshots, preflight-gated apply with
  immediate revert, byte-exact restore, the pending inbox (including
  submission, caps, and duplicate ids), and the trial-boot lifecycle.
- `server/self-modify.e2e.test.ts` — the server wiring on an isolated fixture:
  off by default, toggled live, journal listing, trial-boot adoption and
  verification, and the boot-crash revert.
- `server/drivers/agents-proxy.test.ts` — the bot tool against a scripted
  harness stub: proposing, listing, applying (with the restart notice for
  server edits), discarding, argument refusals, and that the tool is absent
  unless the harness opted in.
- `server/index.test.ts` — the internal door: feature-gated, capability-bound,
  leash refusals, discard, and unknown ids.
- `src/components/SelfModifySection.test.ts` — the console's markup: the
  failsafe list, the inbox rows (including invalid ones), the journal's
  statuses and actions, and the switch writing only the feature flag.
