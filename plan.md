# Plan: steering for the Qwen Code engine

Status: implemented on `feat/qwen-steer`. See `docs/verification/qwen-steering.md` for the isolated fixture results.

## 1. What we know (measured, not assumed)

Probed on this machine with the real Qwen build and the real model, in throwaway directories, using
`C:\Users\KrishnaDobhal\.qwen\bin\qwen\qwen.exe --acp` (`agentInfo.version` = `1.0.0-preview.2`).
The probe scripts are in the session scratchpad (`qprobe.mjs`, `qplan.mjs`), not in the repo.

| Question | Result |
|---|---|
| Does `initialize` advertise steering? | No. `agentCapabilities` has `loadSession`, `sessionCapabilities`, `promptCapabilities`, `mcpCapabilities` and no `_meta`. There is no flag to detect it. |
| Does a second `session/prompt` during a running turn join that turn? | Yes. It is not rejected and does not cancel the first prompt. The model saw the new text right after the running tool call and acted on it. |
| Does it steer a turn that has not started a tool yet? | Yes (second message at 5.6 s, before any file existed: 1 of 8 files created, then stop). |
| Does it steer between tool calls? | Yes (second message at 17.0 s while on file 3: 3 of 8 files created, then stop). |
| How does the first prompt end? | `stopReason: "end_turn"` with the steered content in the same turn. |
| What does the second prompt return? | **Nothing.** In two runs it was still unanswered 100 s later, long after the first prompt ended. |
| Is `available_commands_update` sent? | Yes, after `session/new`, but it has no steer command, so the Hermes path does not apply. |

Not measured yet (step 0 measures them): what happens to the next turn in the same session after a second prompt that
never answered; whether that prompt ever answers; a single long tool call that cannot be interrupted; versions older
than `1.0.0-preview.2`; image attachments sent as a steer.

Earlier web research said Qwen 0.28 rejected a mid-turn prompt with `turn_in_progress`. That was a snippet about a
bridge on an older build, and it contradicts the measurement above, so the gate (step 2) keeps older builds on the
current "queue until the turn ends" behaviour.

### Tests already run (2026-11-20)

All used `qwen.exe --acp` over stdio JSON-RPC, a fresh throwaway working directory per run, and the first option of
every permission request auto-selected. Scripts: `qprobe.mjs` (tests 1-2) and `qplan.mjs` (tests 3-4), in
`C:\Users\KRISHN~1\AppData\Local\Temp\claude\650f3c859da8bb94\5052999d-bfc6-490a-94a3-eee6b9c48b41\scratchpad\`.
Logs: `steer.log`, `plan.log`, `plan2.log` in the same folder.

**Test 1: what does `initialize` say?** (`qprobe.mjs`, no prompt)
- Sent `initialize` (protocolVersion 1) and `session/new`.
- Result: `agentInfo` `qwen-code` `1.0.0-preview.2`; capabilities `loadSession`, session `additionalDirectories`,
  `close`, `delete`, `fork`, `list`, `resume`, image and embedded-context prompts, http and sse MCP. No `_meta`, no
  steering flag. Five session modes (default, acceptEdits, auto, dontAsk, yolo). Model list: `qfmodel`.
- Result: `available_commands_update` arrived after `session/new` and lists skills and commands (`goal`, `rewind`,
  `rename`, `simplify`, `debug`, `quest`, `batch`, and others); none is a steer command.

**Test 2: second prompt during a slow command** (`qprobe.mjs steer`)
- Prompt A: "Run the shell command `ping -n 25 127.0.0.1` and then say DONE_A."
- Waited 12 s while the tool ran, then sent prompt B: "Also, when finished, say STEERED_OK."
- Result: B was not rejected and did not cancel A. After the tool finished, the model's thinking said the user had
  added a requirement, and it wrote both `DONE_A` and `STEERED_OK` in the same turn. A returned
  `stopReason: "end_turn"` at 32.3 s (31.6 s in the repeat run).
- Result: B never returned a response. In the repeat run it was still outstanding when the probe was stopped, long
  after A ended. That is the finding behind the "does not wait" design in section 4.

**Test 3: change of plan, early** (`qplan.mjs 4000`)
- Prompt A: "Create 8 files named f1.txt to f8.txt in the current directory, one at a time. Use a separate shell
  command for each file, and run `ping -n 2 127.0.0.1 >nul` before each so there is about 1 second between files. Do
  not batch them. Say ALL_DONE when finished."
- Prompt B at 5.6 s (the model was still thinking, no tool had started): "Change of plan: do not create any more
  files. Stop creating files now and just tell me how many exist."
- Result: only `f1.txt` was created. Qwen finished the command it had begun, checked, and reported
  "Only 1 file exists: f1.txt (created before the change of plan)". A ended `end_turn` at 19.5 s.

**Test 4: change of plan, in the middle** (`qplan.mjs 16000`)
- Same prompt A. Prompt B (same wording) at 17.0 s, while Qwen was on `f3.txt`.
- Result: `f1.txt`, `f2.txt`, `f3.txt` exist, nothing else but `.qwen/`. Qwen reported "3 files exist" and stopped. A
  ended `end_turn` at 24.6 s. Neither run reached 8 files.

**Side observations.** Qwen noticed that `>nul` is wrong under Git Bash and used `/dev/null` in test 4. Token usage in
the response is all zeros, so Qwen reports no usage on this path. Test 2's first attempt ran through a pipe that held
back output and hit the tool timeout; it was rerun with output to a file, which is why test 2 has two runs.

**Not covered by these tests** (step 0): next turn after the unanswered prompt, whether B ever answers, a single
uninterruptible long tool call, a steer after the turn ended, older Qwen builds, steering with images.

## 2. How steering works in the app today (origin/main, `684eff585`)

This working branch (`feat/higgsfield-image`) is behind origin/main and does not have the prompt-steer code. The work
must start from `origin/main` on its own branch.

- `server/drivers/acp/steer.ts` defines three mechanisms behind `AcpSteerSupport`:
  - `AcpCommandSteer`: slash command the agent advertises (Hermes, Kiro).
  - `AcpRequestSteer`: extension request reported in `initialize` (OpenCode `_session/steering`).
  - `AcpPromptSteer` plus `acpPromptSteering()`: a second `session/prompt` (Devin).
- `turnSteering(support, io)` picks the mechanism. For the prompt kind it allows steering only when
  `io.initializeResult()?.agentCapabilities?._meta?.[support.capability] === true`.
- `acpPromptSteering` reports `"steered"` as soon as the prompt is sent, collects the replies, and
  `promptAnswered()` returns `Promise.all(pending)`, which the core awaits at `server/drivers/acp/core.ts:1416-1417`
  before the turn can finish. Replies are merged for usage at `core.ts:1438-1440` through `support.steer.run`.
- `DEVIN_STEER` (`server/drivers/acp/devin.ts:84`) is the only prompt-kind user.
- The fake engine `server/testing/fake-acp-cli.ts` has `FAKE_ACP_MODE=devin-steer` and `FAKE_ACP_STEERING=off`.
- `core.ts:1616-1617` exposes `steer` to the server only when `support.steer` is set; images make it refuse.

## 3. Why Devin's path cannot be reused unchanged

Two gaps, both found by the probe:

1. **The gate.** Devin is detected by a `_meta` capability flag. Qwen advertises none. The only signal is
   `agentInfo.version` in the `initialize` result.
2. **The unanswered second prompt.** `acpPromptSteering.promptAnswered()` waits for every steer prompt to settle. For
   Qwen that promise never settles, so the turn would hang forever after the model finishes. This is the dangerous
   one: a naive copy of Devin's setup would make every steered Qwen turn hang.

## 4. Design

Smallest change that closes both gaps, extending the existing prompt kind instead of adding a fourth one.

**`server/drivers/acp/steer.ts`**
- `AcpPromptSteer`: replace `capability: string` with `supported(initializeResult: unknown): boolean`, the same shape
  `AcpRequestSteer` already has. Devin becomes
  `supported: (init) => init?.agentCapabilities?._meta?.["cognition.ai/midTurnPrompts"] === true`. Behaviour unchanged.
- `AcpPromptSteer`: add optional `answers?: false`. It means: this agent never answers the steer prompt on its own.
  `run` becomes optional because there is no reply to read a run id from.
- `acpPromptSteering(running, send, answers = true)`: when `answers` is false, do not track the sent promise in
  `pending`, so `promptAnswered()` returns null at once. Attach a no-op `.catch` so a late rejection (process killed)
  is never an unhandled rejection.
- `turnSteering` passes `support.answers !== false` and uses `support.supported(...)`.

**`server/drivers/acp/qwen.ts`**
- `QWEN_STEER: AcpPromptSteer = { kind: "prompt", answers: false, supported: qwenSteers }`.
- `qwenSteers(init)` reads `init.agentInfo.version` and returns true only for `1.0.0-preview.2` or newer. Do not use
  `parseVersionTriple` alone: it drops the prerelease tag, so `1.0.0-preview.1` would pass. Rule: triple above
  `1.0.0` passes; triple equal to `1.0.0` passes when there is no prerelease tag or it is `preview.N` with N >= 2;
  anything unparseable fails closed.
- Add `steer: QWEN_STEER` to the Qwen `SUPPORT` object.

**Gate semantics.** Unknown or older version means no steer, so the message waits for the turn to end exactly as
today. The floor is the one build I tested. It can be lowered later by testing an older build.

**Not in scope.** No UI change, no new setting, no change to Qwen's model routes or approvals, no steer with
images (stays refused by the existing `images?.length` check).

## 5. Steps

0. **Finish measuring (read-only, throwaway dirs).** With the probe, check: (a) after a second prompt that never
   answered, does a new `session/prompt` on the same session work and answer normally; (b) does the old second prompt
   ever answer, and if so with what; (c) steer during one long single tool call; (d) steer sent after the turn has
   ended. If (a) fails, stop and reassess: the design would then need a new session per steered turn.
1. **Branch from origin/main**, e.g. `feat/qwen-steer`. Leave `feat/higgsfield-image` alone.
2. **Tests first**, in `server/drivers/acp/steer.test.ts`: with `answers: false`, `promptAnswered()` is null and a
   never-settling `send` does not block; `steer()` still returns `"steered"` while open and `"refused"` after the turn
   answered; a rejecting `send` does not throw; Devin's existing cases still pass with `supported`.
3. **Version gate tests**, new `server/drivers/acp/qwen-steer.test.ts`: `1.0.0-preview.2` yes, `1.0.0` yes, `1.2.0`
   yes, `1.0.0-preview.1` no, `0.28.0` no, missing `agentInfo`, garbage string, wrong type all no.
4. **Implement** the `steer.ts` and `qwen.ts` changes from section 4.
5. **Fake engine mode** `FAKE_ACP_MODE=qwen-steer` in `server/testing/fake-acp-cli.ts`: reports
   `agentInfo.version` `1.0.0-preview.2`, a gated turn like `devin-steer`, takes a second prompt into the run, and never
   answers it. `FAKE_ACP_QWEN_VERSION` overrides the version so the gate is testable end to end.
6. **Driver test** using that mode through `createAcpDriver`: steer text reaches the engine as `session/prompt`, the
   turn finishes with the steered text in its reply, the turn does not hang, and an old version refuses the steer.
7. **Verification fixture** per `docs/verification/README.md`: launch the isolated fixture
   (`node --experimental-strip-types scripts/control-omb.ts launch`), drive a Qwen bot through `control-omb` with the
   fake engine, keep the JSON from `wait` and `messages`, the command sequence and the log path. Add
   `docs/verification/qwen-steering.md` and a line in the README index. Never touch the live app or data.
8. **One real-engine run** with the probe's "8 files, then change of plan" scenario against the final code path, and
   record the result in the same doc. This is the only step that spends real model calls.
9. **Checks before claiming done:** `pnpm` typecheck, the ACP driver tests, and the new tests, with the output kept.
   State what was and was not proven.

## 6. Risks

- **Hung request left on the session.** A second prompt that never answers stays outstanding. If a later turn on the
  same session misbehaves, the design fails. Step 0(a) decides this before any code is written.
- **Version floor too high or too low.** Only `1.0.0-preview.2` was tested. Too high just means older builds queue,
  which is today's behaviour. Too low would be a bug, which is why the floor is exactly the tested build.
- **Silent loss.** Because no answer comes back, the app reports "steered" without proof that Qwen took it (for
  example, if the turn ended the instant before the message arrived). The existing `running()` check narrows this to a
  very small window; it cannot be closed with this agent.
- **Shape change to a shared type.** `capability` becoming `supported` touches Devin. Covered by keeping Devin's
  existing tests green.
- **Qwen moves fast.** Preview builds can change this behaviour. The gate and the real-engine run in step 8 should be
  repeated when the floor changes.

## 7. Decisions I need from you

1. Start the branch from `origin/main` instead of the current `feat/higgsfield-image`? (Recommended; the current
   branch lacks the prompt-steer code.)
2. Floor at exactly `1.0.0-preview.2` (tested), accepting that older builds keep queueing?
3. Is step 8 (real model calls) fine to run, or do you want fixture-only verification?
