# Engines and Doctor

## Sub-features

- Confirm the endpoint identifies itself as OpenMausBot.
- List configured provider instances without exposing executable paths.
- Distinguish available and unavailable engines.

## User path

Open a bot's model picker or Settings → Engines.

## Driving it

```sh
pnpm control:omb doctor --url http://127.0.0.1:PORT
pnpm control:omb models --url http://127.0.0.1:PORT
```

`doctor.ok` is true only when the endpoint is OpenMausBot and at least one
engine is available. The isolated fixture should expose `claude`.

## Gotchas

- Doctor proves server/engine readiness, not authentication against a real
  provider.
- The preview `openmausRuntime` instance appears in `models` only when
  `features.ownedRuntime` is true in the fixture's config; by default it is
  absent, not unavailable. Its `capabilities.contextOwnership` is `omb-loop`,
  where every installed CLI reports `vendor-session` and the OpenAI-compatible
  engines report `omb-replay`.
- With no key, the preview engine is available only for a loopback or
  private-network URL. Point it at a public host without a key and `models`
  shows it unavailable with a reason naming the rule — that is the policy
  working, not a broken fixture.
- Model-picker rendering is Electron UI and remains outside this first map.
