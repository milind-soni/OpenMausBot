# Qwen Code steering

A message sent while a Qwen Code turn runs is steered into it as a second
`session/prompt` on the same session. Qwen Code 1.0.0-preview.2 takes that
prompt into the running turn but never answers it, and it advertises nothing in
`initialize`, so OMB gates steering on `agentInfo.version` (1.0.0-preview.2 or
later). Older builds keep queueing the message as their own next turn. A steer
sent during a running tool call is taken in after that call finishes.

OpenMausBot sets `QWEN_ENABLE_AGENT_SESSIONS=0` by default so Qwen Code runs
subagents inside the active turn. A shell job can still wake a turn after the
prompt ends. When OpenMausBot sees that activity while idle, or when the person
stops a turn, it forks the session, deletes the original to end its jobs, and
loads the fork for the next turn. This requires Qwen to advertise both
`session/fork` and `session/delete`. OpenMausBot saves the fork cursor before
deleting the original, so a server restart can still resume the fork. If a
background wake races with setup of a new turn, OpenMausBot ends the background
turn and asks the person to resend the message. Updates for a session while it
loads can be transcript replay, so the setup guard excludes those updates.

Offline verification (no provider login or paid calls):

```sh
pnpm exec vitest run server/drivers/acp/steer.test.ts server/drivers/acp/qwen-steer.test.ts server/drivers/acp/background.test.ts server/drivers/acp/opencode-go.test.ts server/drivers/acp/devin-steer.test.ts server/drivers/acp/hermes-steer.test.ts
pnpm exec vitest run server/steer-e2e.test.ts -t "Qwen"
```

`FAKE_ACP_MODE=qwen-steer` scripts the fake ACP engine as Qwen does: a prompt
during a running one joins it and is never answered. The driver tests check
the steer reaches the engine, the turn ends with the steer taken in and does
not wait for the unanswered prompt, the next turn runs on the same session, and
a 1.0.0-preview.1 build refuses without sending. The background-work cases
check that idle activity and Stop each delete the original session and that the
next prompt uses the fork even when given the original cursor.

The e2e test runs an isolated server with its own home. It sends `first`, waits
for the fake ACP stream to start, sends `and also this`, then releases the
engine and waits for the chat to become idle. It sends `next` and waits for the
second reply. On 2026-11-20 the focused case ran on Windows from a temporary
test copy with the POSIX guard lifted. The steer returned HTTP 202 with
`steered: true`. The two replies were `working. done; steered: and also this`
and `working. done`. The final chat was idle. Local evidence is in
`.omb-scratch/qwen-steering-evidence/steering.json` and `server.log` in the same
directory. The same flow ran against the standard launcher via
`node --experimental-strip-types .omb-scratch/qwen-steering-evidence/run-offline.mjs`.
Its two `control-omb wait` results, `messages` output, action sequence, and
launcher log path are in `.omb-scratch/qwen-steering-evidence/control-omb.json`.

A real Qwen Code 1.0.0-preview.2 probe outside OMB (throwaway dirs) showed: the
steered prompt is folded into the running turn and never answered, even after
60 s idle; a new prompt on the same session afterwards answers normally; a
steer during a single 29 s shell call does not interrupt it; a prompt after the
turn ended is an ordinary turn.

On 2026-11-20, `QwenAgentDriver` also ran the eight-file scenario with real
Qwen Code 1.0.0-preview.2 in a disposable home and working directory. The
driver sent the steer after `f1.txt` appeared, returned `steered`, and settled
successfully. Only `f1.txt` existed afterward, and Qwen reported stopping before
`f2.txt`. The driver evidence and launcher log path are recorded in
`.omb-scratch/qwen-steering-evidence/real-driver.json`. Background cleanup was
exercised against the fake ACP engine.
