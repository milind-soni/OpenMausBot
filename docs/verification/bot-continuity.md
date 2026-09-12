# Bot setup, model scope, and file continuity

```sh
pnpm exec vitest run server/setup-mode.test.ts server/bot-setup.e2e.test.ts server/bot-continuity.e2e.test.ts server/independent-threads-api.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/control-omb-ui.e2e.test.ts
```

The server recipe launches the real app in a temporary home with only the
offline CLI. It sends actual messages through `control-omb`, waits for settled
turns, and checks the prompt and model delivered to the provider boundary:

- A named bot with no description or SOUL can receive a normal work request
  without the setup interview or its "Wait for a yes" instruction.
- `/setup Help me track garden watering` explicitly enables coaching; the next
  ordinary request disables it, even if no profile card was confirmed.
- A pinned thread's model change with `updateBotDefault: true` updates that
  thread and the bot default used by groups and future threads. It does not
  change a selected sibling, other saved model choices, or approval levels.
- Without that flag, only the selected thread changes. Group dispatch still
  uses the bot default. Busy group changes and invalid requests are rejected.
- Direct and room prompts carry the same saved identity and standing rules,
  plus explicit current/shared/sibling file locations. Old files are retained;
  working-directory pins and concurrent-thread isolation do not change.

The test prints a retained `.bot-continuity.json` evidence path with commands,
wait results, bounded transcripts, and provider-input receipts. Launch
environments and MCP tokens are not retained. The renderer recipe checks both
scope buttons in the real model picker, saves a screenshot, changes models,
checks server persistence, and sends a message through the composer.

## Live Claude smoke — 2026-09-12

Separately, the exact system prompts captured from the disposable app were
replayed to the signed-in Claude CLI (Sonnet 5). These were synthetic requests,
not live user conversations. `--safe-mode`, `--restricted`,
`--strict-mcp-config` and `--no-session-persistence` disabled customizations and
saved sessions. Tools were disabled except for the final test, which allowed
only Read inside the disposable working directories.

| Request | Observed response |
| --- | --- |
| `What is 17 + 25? Answer with the number.` | `42` |
| Explicit setup for tracking garden watering | Asked about the job, timing, apps and folder |
| Find `garden-plan.txt` from earlier work, outside the current directory | Read the shared-bot file and returned its hidden verification code, `MOSS-42` |

An arithmetic control using the old automatic-setup block also answered `42`.
This does **not** reproduce every reported refusal, establish malicious intent,
or prove every provider behaves identically. The verified regression is the
unrequested coaching sent by OMB; live results confirm ordinary work, explicit
setup and cross-folder reading on the tested Claude model. Group model routing
and UI persistence use the offline provider. No real bots or files were moved.
