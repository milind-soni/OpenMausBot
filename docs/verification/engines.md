# Engines and Doctor

## Sub-features

- Confirm the endpoint identifies itself as OpenMausBot.
- List configured provider instances without exposing executable paths.
- Distinguish available and unavailable engines.
- Add named Claude accounts and select them independently for bots.

## User path

Open a bot's model picker or Settings → Engines.

## Driving it

```sh
pnpm control:omb doctor --url http://127.0.0.1:PORT
pnpm control:omb models --url http://127.0.0.1:PORT
```

`doctor.ok` is true only when the endpoint is OpenMausBot and at least one
engine is available. The isolated fixture should expose `claude`.

## Named Claude accounts

Run the offline API fixture and driver regressions:

```sh
pnpm exec vitest run server/claude-account-api.test.ts server/claude-accounts.test.ts server/drivers/claude-accounts.test.ts
```

The API fixture launches its own disposable server and synthetic CLI. It checks
account creation, isolated directories, safe auth-status metadata, persistence,
directory/history guards, removal, malformed-account repair, and admin-only
mutations. Updating an idle sibling must preserve the busy bot's process and
subsequent events. No real provider login is required.

For a renderer check, open the isolated launcher's app in a browser, dismiss
onboarding, and go to **Settings → Engines**. Add Work and Personal, inspect
their distinct sign-in commands, and select one account per bot from the model
picker's single Claude entry and nested Account dropdown. Choose a model to
save the selection. Reload and revisit both bots. Confirm the account labels persist,
including at narrow window widths. Use synthetic accounts only; this does not
prove real OAuth login or native Windows execution.

## Gotchas

- Doctor proves server/engine readiness, not authentication against a real
  provider.
- Model-picker rendering is Electron UI and remains outside this first map.

## Groq API setup

```sh
pnpm exec vitest run server/drivers/groq.test.ts server/provider-key-check.test.ts server/config.test.ts server/openai-tools.e2e.test.ts src/components/keys/key-catalog.test.ts src/components/keys/KeyRow.test.ts src/state/store.test.ts
```

These fixtures use disposable data and local HTTP providers. They check the
preset endpoint, write-only key status, model discovery, selection, streaming
usage, tool approval/denial/cancellation, and clearing the key. They never call
Groq or verify a real account's quota, model access, or inference.

For a renderer check, use an isolated server with a synthetic Groq endpoint.
Open **Settings → API keys**, paste its fixture key and save it, and check that
the row reports catalog reachability without claiming chat authentication. Select a
Groq model in the bot's picker, send a fixture turn, then clear the key and
confirm the engine is unavailable. Never use the live app or a real key for
this recipe.

## Greenference API setup

```sh
pnpm exec vitest run server/drivers/greenference.test.ts server/provider-key-check.test.ts server/credential-request.test.ts src/components/keys/key-catalog.test.ts
```

These use a local stand-in for `https://llm.eu.greenference.com/v1`. They check
the preset endpoint, that the server's key never goes to another host, the
model list (ready models that call tools, short names, image input from
`input_modalities`), streaming with reasoning and usage, and that a refused key
never shows in events. Greenference's model list is public, but a wrong key
gets 401 there, so Settings' Test proves the key. They never call Greenference.

Checked against the live public list on 2026-10-30: 10 models, of which 5 call
tools (GLM 5.3 Flash, Qwen3.6 27B, Gemma 4 31B, GLM 4.7 Flash, Qwen3 14B), and
chat without a key answers 401. A real chat turn needs a real key.

## Meta Muse: Model API and Muse Code

```sh
pnpm exec vitest run server/drivers/meta.test.ts server/drivers/muse-code.test.ts server/provider-key-check.test.ts server/config.test.ts server/openai-tools.e2e.test.ts src/components/keys/key-catalog.test.ts src/components/keys/KeyRow.test.ts src/state/store.test.ts
```

The Meta Model API fixtures use a local HTTP provider: preset endpoint,
write-only key, the account's own model list (Muse Wonder becomes the default
once listed), streaming usage and tool approval. They never call Meta.

Muse Code has a live check against the real CLI, signed in on this machine
with `muse login`. It spends that account's Muse usage, so it runs only when
asked:

```sh
OMB_LIVE_MUSE=1 pnpm exec vitest run server/drivers/muse-code.live.test.ts
```

It lists the account's models (Muse Wonder 1.0), answers on Muse Wonder, runs
a shell command as a tool step, and resumes the session on a fresh instance
after the first one is gone, the way an app restart does.
