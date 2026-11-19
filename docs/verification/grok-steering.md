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

Use an isolated home with a copy of the sign-in, never `~/.grok`:

```sh
GROK_HOME=<temp dir holding a copy of auth.json> node --experimental-strip-types scripts/control-omb.ts launch
```

The launcher's fixture has only the fake engine, so for the real CLI start the
server by hand with an instance `{ driver: "grokAgent", config: { cli: <grok> },
environment: { GROK_HOME } }` in the fixture's `config.json`, and give Grok's
shell tool a working shell. File tools need none.

1. Ask the bot for 8 files, `step1.txt` to `step8.txt`, one write per file.
2. After a few exist, send "do not create any more files, reply MANGO".
3. The UI tags it "sent mid-turn", the reply is MANGO, and fewer than 8 files
   exist (6 on the recorded run). The files that were already in flight still land.

Automated: `server/drivers/acp/grok-steer.test.ts` against the scripted peer
(`FAKE_ACP_MODE=grok-steer`), including `ensureGrokSteer` on a config with no
`[ui]`, one with `[ui]`, none at all, a `"queue"` choice and a signed-out home.

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

Recorded on the real CLI (2026-11-19): a subagent launched in the background
finished after the turn and Grok then ran a turn that confirmed its file; with
`session/close` right after the turn the subagent was ended, no file was written
and no turn woke. A session closed and loaded again remembered an earlier word.
Automated: `server/drivers/acp/grok-background.test.ts` (a woken turn between
ours, and Stop) against the scripted peer with `FAKE_ACP_CLOSE_ENDS_JOBS=1`.

