# Token efficiency verification

This recipe covers ACP/Pi instruction receipts and opt-in private room
continuations. Every command below uses a disposable fixture; do not point it
at a live OpenMausBot URL or home directory.

## Focused verification

Run from the repository root:

```sh
pnpm exec vitest run \
  server/system-prompt.test.ts \
  server/turn-context.test.ts \
  server/drivers/prompt-plan.test.ts \
  server/drivers/acp/instruction-receipts.test.ts \
  server/drivers/acp/acp.test.ts \
  server/drivers/acp/prompt-composer.test.ts \
  server/drivers/acp/opencode-go.test.ts \
  server/drivers/acp/cursor.test.ts \
  server/drivers/codex.test.ts \
  server/drivers/claude.test.ts
pnpm exec vitest run \
  server/room-context.test.ts \
  server/room-continuations.test.ts \
  server/room-session-continuity.e2e.test.ts \
  server/room-session-parity.e2e.test.ts
pnpm exec vitest run \
  server/bot-continuity.e2e.test.ts \
  server/memory-room-prompt.e2e.test.ts \
  server/room-coordination.e2e.test.ts \
  server/room-recovery.e2e.test.ts \
  server/independent-threads-api.test.ts \
  server/wire.test.ts \
  server/team-backup.test.ts \
  server/package-export.test.ts
pnpm typecheck
git diff --check
```

The ACP driver tests use `server/testing/fake-acp-cli.ts`. They prove a fresh
prompt contains the complete system block, an unchanged resumed prompt sends
no system-section text, a changed section is sent as an update, a rejected
load gets one full recovery prompt, and a prompt failure after acceptance is
not replayed.

`server/drivers/prompt-plan.ts` is the one typed writer for the content-free
native receipt. ACP and Pi measure their own native-boundary facts, including
UTF-8 section bytes, and the writer only validates and appends them. Claude,
Codex, Box, and transcript/API drivers do not emit an approximate receipt.

## Isolated direct ACP fixture

The programmatic launcher adds the repository-owned fake ACP instance without
reading the user's fleet:

```sh
node --experimental-strip-types --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { launchVerificationServer, runControlOmb } from "./scripts/control-omb.ts";

const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["acp"]);
const call = (args) => runControlOmb([...args, "--url", fixture.info.url], { env: {} });
try {
  const catalog = await call(["models"]);
  const acp = catalog.instances.find((instance) => instance.instanceId === "acp");
  const model = acp.models.options[0].id;
  const { bot } = await call(["new-bot", "--name", "ACP receipt fixture"]);
  await call(["set-model", "--bot", bot.id, "--instance", "acp", "--model", model]);
  await call(["send", "--bot", bot.id, "--text", "A1"]);
  await call(["wait", "--bot", bot.id]);
  await call(["send", "--bot", bot.id, "--text", "A2"]);
  await call(["wait", "--bot", bot.id]);

  const prompts = readFileSync(fixture.fakeAcpReceiptPath, "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.method === "session/prompt");
  if (prompts.length < 2 || prompts[1].promptBytes !== Buffer.byteLength("A2", "utf8")) {
    throw new Error(`expected the resumed ACP prompt to contain only A2: ${JSON.stringify(prompts)}`);
  }
  console.log(JSON.stringify({ prompts, dataDir: fixture.info.dataDir, logPath: fixture.info.logPath }, null, 2));
} finally {
  await fixture.close();
}
NODE
```

Receipt lines contain only `method`, a generated `sessionId` alias, UTF-8
`promptBytes`, and optional content-free boolean/count checks evaluated in
memory against synthetic test sentinels. They never contain prompt text,
sentinels, cursors, hashes, paths, MCP configuration, or credentials. The
fixture data directory is temporary and is removed by `fixture.close()`. Keep
the printed server log path with the verification evidence.

## Isolated room continuity fixture

The fixture launcher enables `OMB_ROOM_SESSION_CONTINUITY=1` by default;
normal servers default to the flag off. The shortest A/B/A check is:

```sh
pnpm exec vitest run server/room-session-continuity.e2e.test.ts
```

The test creates two ACP bots and one room whose default responder is A, then
sends A1, A2, `@B B1`, and A3. It retains only the private
`DATA_DIR/room-continuations.json` owner records. The native `prompt.plan` log
proves A's first room turn sends system bytes, A's second sends zero unchanged
system-section bytes, and A3 contains B1 plus A3 but not A1 or A2. The same test
then checks a memory-only update, model invalidation, a same-`DATA_DIR` restart,
one dead-session recovery, authority invalidation, and task deletion (including
ACP instruction-receipt cleanup). The unit suite covers an absent anchor (fresh
rebuild), an in-flight restart (rotate without auto-replay), a 31-message
window (rotate to the last 30), cross-scope monotonic epoch races, restrictive
`0600` persistence, and thread/bot deletion cleanup. A separate fixture
restart proves a mutation while continuity is disabled cannot revive a cursor,
while a mutation-free disable/re-enable can resume it.

For ACP turns, `prompt.plan` is written by the shared composer immediately
before `session/prompt`, so its UTF-8 system bytes and section `sent` flags are
the composed dispatch values. Pi writes its equivalent at the native `prompt`
boundary because Pi sends the complete system block on every turn. Both
records stay content-free and do not contain prompt text, cursors, or hashes.
The fake ACP/Pi receipt byte counts and semantic checks remain authoritative for
recovery and replay assertions, especially when a provider rejects
`session/load` before the replacement prompt.

`prompt.plan` is exact only for ACP and Pi in this patch. Claude, Codex, and
transcript/API drivers do not emit a generic server-estimated record; extending
the receipt contract requires instrumentation at each provider's native prompt
boundary and provider-specific tests. The checks below therefore make no
universal token or prompt-size claim.

For a manual fixture run, launch with `node --experimental-strip-types
scripts/control-omb.ts launch`, use `new-bot`, `set-model`, `new-channel`, and
`send-channel` from the printed URL, then inspect only the printed temporary
`dataDir/native/<room-thread>.ndjson` and `room-continuations.json`. Keep those
files as local evidence and remove the fixture with Ctrl-C.

## Acceptance checks

- The first direct ACP turn sends the complete system prompt.
- The second unchanged direct ACP turn sends zero system-section bytes.
- A memory or other section edit sends only the update wrapper and changed
  section.
- A `session/load` null/error sends the complete recovery text once.
- A missing or uncertain `session/prompt` result leaves the old receipt in
  place and never resends the turn.
- Receipt files live below `DATA_DIR/acp-instructions` with private `0600`
  files and contain ordered section id/hash pairs only.
- Room A/B/A state is private and owner-scoped; another member's native cursor
  is never loaded for A.
- A resumed room turn sends only unseen lines, excludes the reader's ordinary
  native replies, keeps same-bot `peerPost` lines, and sends zero unchanged
  system-section bytes.
- A dead cursor, missing anchor, restart with `inFlight`, or 30-message window
  overflow rebuilds once from the bounded full room context; an accepted turn
  is never replayed automatically.
- Room continuation state is absent from wire projections and workspace/team
  backup archives; deletion removes the owner record and its ACP receipts.
- A provider/account mutation fences every affected shared-CLI instance before
  its first asynchronous step. Failed mutations leave the cursor and receipt
  intact; successful mutations clear them.
- Every owner, bot, group, thread, and provider invalidation receives one value
  from the process-wide monotonic epoch. Unrelated owners remain dispatchable.

## Recorded verification

The recorded results below are from this working tree, using Node `v26.7.0`
and pnpm `10.33.0`; no commit or push was created.

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- The prompt/receipt matrix — passed: 10 files, 417 tests, 1 skipped.
- The room continuity/parity matrix — passed: 4 files, 32 tests; this includes
  fresh/resumed ACP permission cards, exact-operation approvals, runtime
  capability revocation, working-state timeouts, and an OpenCode variant
  reapplied on resume.
- The regression group — passed: 8 files, 68 tests, 1 skipped; direct
  coordination passed: 21/21.
- The isolated ACP fixture command above — passed; its temporary data directory
  was removed by `fixture.close()`.
- `pnpm broker:test` — passed: 9 tests.
- `pnpm test:packaged-server` — passed, including the packaged MCP stdio smoke.
- `git diff --check HEAD` — passed.

The final `pnpm test` gate passed in this working tree: Vitest passed 577 files
and skipped 2 (7,239 tests passed, 27 skipped, 1 todo); the broker stage passed
9/9; Electron passed 345 with 5 skipped; and the packaged-server build and
MCP stdio smoke passed. The Vitest stage took about 47 minutes because file
parallelism is disabled in `vite.config.ts`. The index fixture probes its
listener pair before spawning, and the renderer key-save assertions allow the
provider-fleet restart to finish on a loaded host; those checks prevent stale
local servers and five-second polling from becoming false product failures.

## Cleanup and rollback

The isolated launcher owns and removes its temporary data directory. Do not
point this recipe at a live OpenMausBot URL or home directory. Rolling back
room dispatch is `OMB_ROOM_SESSION_CONTINUITY=0` (the default), which restores
full-room delivery. Turning the flag off alone does not delete private state,
but bot, group, thread, model, authority, provider, and deletion mutations
still invalidate matching state so a later re-enable cannot revive it. A
mutation-free rollback may resume the retained cursor. Receipt files are
private optimization state and remain outside wire and backup exports.
