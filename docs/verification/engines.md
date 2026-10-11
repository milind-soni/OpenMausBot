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
pnpm exec vitest run server/drivers/groq.test.ts server/provider-key-check.test.ts server/config.test.ts server/openai-tools.e2e.test.ts src/components/ApiKeys.test.ts src/state/store.test.ts
```

These fixtures use disposable data and local HTTP providers. They check the
preset endpoint, write-only key status, model discovery, selection, streaming
usage, tool approval/denial/cancellation, and clearing the key. They never call
Groq or verify a real account's quota, model access, or inference.

For a renderer check, use an isolated server with a synthetic Groq endpoint.
Open **Settings → API keys**, paste its fixture key, and check that **Test**
reports catalog reachability without claiming chat authentication. Select a
Groq model in the bot's picker, send a fixture turn, then clear the key and
confirm the engine is unavailable. Never use the live app or a real key for
this recipe.
