# Grok steering a running turn

A message sent while a Grok turn runs is taken into that turn instead of
waiting for it to end, once Grok's own config has `follow_up_behavior = "steer"`.
OpenMausBot adds the line itself, for a signed-in Grok, when a turn starts. A
`follow_up_behavior` the person already set, `"queue"` included, is left alone.

## What Grok does (grok 1.0.89, 2026-11-19)

- With `"steer"`, a second `session/prompt` is injected at the next tool call or
  model step. Its own reply is `stopReason: "cancelled"` with
  `_meta.completionKind: "removedFromQueue"` and no tokens; the running prompt
  then ends normally. The driver does not count that reply as the turn's result.
- With `"queue"`, the second prompt waits for the turn to end.
- `initialize` does not report the setting, and `GROK_CONFIG` cannot set `ui`,
  so the driver reads `config.toml` in `$GROK_HOME`.
- `_x.ai/queue/interject` cancels the running turn and runs the queued prompt.
  It is send-now, not steering, and is not used.
- One long streamed answer has no step to land on: the message arrives after it.

## Fixture check

`control-omb.ts launch` starts the fake engine only and does not pass `GROK_HOME`, so
the real CLI needs a server started by hand. Use a temporary data directory and a copy
of the sign-in, never `~/.grok`:

1. Make a private data directory, export it so the start script below can read it, and copy
   the sign-in into it:

   ```sh
   export D="$(mktemp -d)"   # mode 0700 on Linux and macOS
   mkdir -p "$D/grokhome" "$D/tmp"
   cp ~/.grok/auth.json "$D/grokhome/auth.json"
   ```

2. Write `$D/config.json` (the server reads `config.json` from `OMB_DATA_DIR`):

   ```json
   {
     "features": { "smartSetupChoices": false },
     "instances": {
       "grok": {
         "driver": "grokAgent",
         "displayName": "Grok (real)",
         "config": { "cli": "<absolute path of the grok executable>", "fullAuto": true },
         "environment": { "GROK_HOME": "<$D>/grokhome" }
       }
     }
   }
   ```

3. Start the server with the same isolated environment the launcher builds, on a port of
   your choice, and serve the built UI (`pnpm build` first). Run from the repository root:

   ```js
   // start-grok-fixture.mts, run with: node --experimental-strip-types start-grok-fixture.mts
   import { spawn } from "node:child_process";
   import { verificationServerArgs, verificationServerEnvironment } from "./scripts/control-omb.ts";

   const dataDir = process.env.D, port = 19975;
   const env = verificationServerEnvironment(process.env, dataDir, port);
   env.OMB_STATIC_DIR = `${process.cwd()}/dist`;
   spawn(process.execPath, verificationServerArgs(env), { env, stdio: "inherit" });
   ```

4. Open `http://127.0.0.1:19975` and create the first bot; it uses the Grok instance.
5. When done, stop the server (Ctrl-C) and delete the directory, which holds the copied
   sign-in: `rm -rf "$D"`.

Grok's shell tool needs a shell the isolated environment can find, so use its file tools
for the check below.

Then:

1. Ask the bot for 8 files, `step1.txt` to `step8.txt`, one write per file.
2. After a few exist, send "do not create any more files, reply MANGO".
3. The UI tags it "sent mid-turn", the reply is MANGO, and fewer than 8 files
   exist (6 on the recorded run). The files that were already in flight still land.

Automated: `server/drivers/acp/grok-steer.test.ts` against the scripted peer
(`FAKE_ACP_MODE=grok-steer`), including `ensureGrokSteer` on a config with no
`[ui]`, one with `[ui]`, none at all, a `"queue"` choice and a signed-out home, plus the
spellings a TOML file allows: a quoted key, a single-quoted value, a `[ui]` header with a
comment or at the end of the file, and `ui` defined by dotted keys or an inline table
(never written to). The reader is `grok-follow-up.ts`; a file it cannot read with
confidence is left untouched, and steering then stays off.

## Background subagents and commands

Grok's `auto_wake` (on by default) wakes a turn nobody prompted when a background
subagent or shell command finishes after the turn. Without a fix the driver drops
that turn's output while it runs, and under Full access it can run tools unseen
(the same hole OpenCode 2.3 had, fixed in #6512).

On grok 1.0.89, `session/close` ends the session's background work at once, and
`session/load` of the same id brings the history back. The driver therefore closes
the session when the person stops a turn, or when a turn update arrives with none
of ours running, and the thread's next turn loads the same session id. There is no
fork and no new session id.

Costs: a background subagent's result is discarded, as with OpenCode; the next
turn pays a `session/load`.

When it cannot end the work:

- **No `sessionCapabilities.close`.** An agent that does not advertise it cannot have its
  work ended that way, so the driver ends the session's process instead (the same step it
  takes for a session that ignores `session/cancel`). For such an agent that happens at every
  Stop and every wake.
- **The close fails or times out.** The driver tries it once more. If that fails too, it ends
  the session's process the same way. The thread's next turn loads its history in a new
  process, and does not start until the old one has ended. If even that fails, the work can
  keep running.

A turn of ours can settle before its last updates arrive (a cancel timeout, a stuck turn, a
failed prompt). An update in the first 2 seconds after one of our turns settles is taken for
that turn's tail, not a wake. A woken turn keeps streaming past that, so it is still caught; a
woken turn shorter than that window would be missed.

Recorded on the real CLI (2026-11-19): a subagent launched in the background
finished after the turn and Grok then ran a turn that confirmed its file; with
`session/close` right after the turn the subagent was ended, no file was written
and no turn woke. A session closed and loaded again remembered an earlier word.
Automated: `server/drivers/acp/grok-background.test.ts` (a woken turn between
ours, and Stop) against the scripted peer with `FAKE_ACP_CLOSE_ENDS_JOBS=1`.

