# GitHub Copilot engine

```sh
pnpm exec vitest run server/drivers/acp/copilot.test.ts server/drivers/acp/custom-model-catalog.test.ts
pnpm exec vitest run server/copilot-engine.e2e.test.ts src/components/CopilotModelPicker.test.ts
```

The driver tests run `copilotAgent` against the repository's `fake-acp-cli.ts`.
They cover registration in fresh and existing fleets, catalog discovery
through `session/new` and `session/set_config_option` with per-model effort
levels and Auto as the default even when the session opens on another model,
the premium-request multiplier in model labels, and sign-in detection. Only an
`auth_required` whose text names the login counts as a missing login (a
"max tokens" or "author" message does not, nor does a missing or refused
credential of an MCP server), a token in the environment is
probed like a stored login and probed again when it changes, the answer is
kept per Copilot home (`COPILOT_HOME`, else `HOME`/`USERPROFILE`), and
concurrent or repeated checks share one probe (a refresh counts as one), with
a missing login checked again after a minute. A caller waits at most three
seconds on a probe: past that it gets the last answer (or "signed in" before
any), so a `copilot` on PATH that never answers ACP cannot hold the engine
list, and the probe still finishes in the background. Removing a discovery session
touches only the folder whose workspace names that discovery's own cwd and
client; the cwd matches when quoted, resolved, or (on Windows) in another
case, and the test's workspace.yaml uses Copilot CLI 1.0.105's own fields. Only Copilot's discovery closes stdin and waits up to two seconds for
the agent to exit before killing it; a custom ACP agent is killed at once, and
an agent that ignores EOF is still stopped once the wait is over. The tests also cover the model applied over ACP and never on argv,
a model switch between turns, a `session/request_permission` shown as an
approval card and answered with the person's choice, the fallback to Auto with a notice when the plan
no longer offers a saved model, and a missing login reported as a sign-in step.
They also check that `COPILOT_ALLOW_ALL` and a server-wide `GITHUB_TOKEN` never
reach the child, while a token set on the engine itself does.

The end-to-end test launches an isolated server with `launchVerificationServer`,
which uses a disposable home, data directory and port pair, and fake engines
only. It refreshes the Copilot and custom ACP catalogs, then moves one bot from
Claude to Copilot through the picker's bot route and the strict model route,
moves one conversation to a custom ACP agent through the conversation route,
and moves both back to Claude. Each turn's effective model is read from the fake
agents' prompt receipts, so a saved setting alone cannot pass.

The renderer test passes the production Copilot catalog resolver's output
(against the same fake) into the full ModelPicker. It requires the advertised
models in the picker and the effort levels of the picked model, and requires a
pick to save that selection. It also checks that a Claude → Copilot → custom
ACP → Claude round trip needs no approval reset at Ask, Auto or Full.

On Windows, catalog discovery used to fail on every refresh: the discovery
child was given 500 ms to stop, but taskkill takes longer, so the cleanup
threw and the catalog was dropped. `server/drivers/acp/custom-model-catalog.test.ts` fails without
the longer Windows stop timeout.

These checks do not establish acceptance by GitHub. A manual check against an
installed, signed-in Copilot CLI 1.0.103 on Windows 11, through the driver with
a throwaway `OMB_DATA_DIR`, reported `authenticated: true`. It listed 14 models,
each with its multiplier and effort levels. It then ran one prompt on
`claude-haiku-4.5`, which completed with the reasoning streamed apart from the
reply. Copilot CLI 1.0.103 keeps every ACP session under
`~/.copilot/session-state`, including an empty one closed with `session/close`.
A refresh followed by a sign-in check against the real CLI left no discovery
session there; two discoveries against Copilot CLI 1.0.105 did not either.
The login refusal texts are not pinned to the real CLI: 1.0.105's session/new
lists models even with an invalid `COPILOT_GITHUB_TOKEN`, so the probe could
not provoke one without a prompt. GitHub documents ACP support in Copilot CLI as public preview. Its ACP
server reference does not document model selection; the driver relies on the
`model` config option the CLI advertises.
