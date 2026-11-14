# Gemini decisions

Run the isolated HTTP fixture and focused tests:

```sh
node node_modules/vitest/vitest.mjs run server/decider/gemini-config.e2e.test.ts server/decider/gemini.test.ts server/decider/decider-config.test.ts src/components/DecisionModelSettings.test.ts electron/workspace-credentials.test.mjs
node scripts/generate-locale.mjs --check
```

The HTTP fixture uses a disposable test home and the real config, Test and
internal helper routes with an injected Google transport. It saves a separate
key, tests it, answers a bot's typed question, and clears the key. It also
checks speech and image references, replacement, removal, a refused source
change and external secret-storage tombstones. Only synthetic keys are used;
no call reaches Google or the person's app or data.

The settings tests check source choices, unavailable selections, server
refusals, empty password fields, desktop/browser saves and Test requests.
They do not establish real Google account access, latency or model quality.
