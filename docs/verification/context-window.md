# OpenAI-compatible context capacity

The driver uses positive integer capacity fields from the endpoint's model
catalog: `context_length`, `context_window`, `max_model_len`,
`max_context_length`, or `contextWindow`. A smaller
`top_provider.context_length` caps the model's advertised window. Output-token
limits and training-context metadata do not establish serving capacity.

For llama.cpp catalogs, the selected model's optional sibling `/props` supplies
`default_generation_settings.n_ctx`, the configured slot capacity. The request
preserves the endpoint's path prefix, disallows redirects, has a three-second
timeout, and sets `autoload=false` to avoid loading another model. An absent or
invalid response leaves the catalog limit intact.

Settings → API keys → Other OpenAI-compatible server exposes a model ID and
context window in tokens. A saved override wins over discovery, applies only
to that model at that endpoint, and survives model refreshes. Clearing it
restores discovery or the existing fallback estimate. It guides the context
meter and compaction threshold; it cannot enlarge the server's capacity.
Separate provider accounts and managed model allowlists retain their scope.

A changed compatible limit is used before the next model call, even when the
previous turn reported a different catalog capacity. An isolated conversation
test proves that lowering the limit causes the next turn to compact.

Turn usage retains cumulative input/output for accounting, while context
occupancy reports only the latest model round's input plus output. Tool rounds
must not accumulate toward a single context-window measurement.

Run the driver/configuration tests without model inference:

```sh
pnpm exec vitest run server/openai-context-window.e2e.test.ts server/drivers/openai-context-window.test.ts server/drivers/openai-chat.test.ts server/drivers/openai-compat.test.ts server/config.test.ts server/context-budget.test.ts
```

Run the actual Settings acceptance test in a disposable workspace:

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/openai-context-window-ui.e2e.test.ts
```

An existing Chrome can be selected with `AGENT_BROWSER_EXECUTABLE_PATH`; the
fixture launches its own browser session. Otherwise the verification harness
installs its pinned browser tools. The test starts a local synthetic provider,
drives the production Settings panel, and checks discovery, invalid-input
rejection, durable saves, clearing, a failed save followed by retry, and switching
between endpoints sharing a model ID. It retains a redacted snapshot and
screenshot under `.omb-scratch/verification/context-window-ui.*`, stops its own
children, and removes temporary app data. It never contacts Splash or another
inference service.

This feature does not alter replay-window or summary-compaction behavior.
