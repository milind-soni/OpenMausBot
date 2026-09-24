# Codex browser routing

Codex bot processes use OpenMausBot's selected browser/desktop bridge. Process-local overrides disable the bundled desktop-only browser/computer plugins; they do not uninstall plugins, change the user's Codex configuration, or disable native web search.

## Regression checks

```sh
pnpm exec vitest run server/browser-runtime.test.ts server/browser-proxy.test.ts server/surface.test.ts server/drivers/codex.test.ts scripts/testing/native-search-evidence.test.ts
pnpm exec tsc --noEmit -p tsconfig.server.json
```

Check navigation errors stay errors, failed navigation is not replayed, and successful navigation returns a compact snapshot from the same authorized session. A snapshot failure must be reported as such, without claiming navigation failed. Human takeover and scope checks still apply.

## Optional real-model acceptance

These checks spend real model quota. Each script launches a temporary server and bot; never point it at a live workspace. Provide absolute paths through these environment variables:

- `OMB_VERIFY_CODEX_CLI`: installed Codex executable.
- `OMB_VERIFY_CODEX_AUTH`: existing Codex sign-in file. Copied into the temporary fixture only, removed on cleanup, never included in the report.
- `OMB_VERIFY_OUTPUT`: local evidence directory; do not commit raw transcripts or screenshots containing private data.
- `OMB_VERIFY_MODELS`: optional comma-separated models (default `gpt-5.6-luna`).

For browser acceptance, also set `OMB_VERIFY_BROWSER_BINARY` to the installed pinned agent-browser executable and `OMB_VERIFY_BROWSER_CHROME` to Chrome. Run:

```sh
node --experimental-strip-types scripts/verify-codex-browser-acceptance.ts
node --experimental-strip-types scripts/verify-codex-search-acceptance.ts
```

The browser check gives goal-only prompts to open Google Calendar and read the public project page. It independently observes the active browser URL and saves screenshots. Calendar's public landing page or sign-in page proves navigation only, not authenticated calendar access. It approves only the fixture's navigation/observation tools; shell, login and unrelated requests remain blocked. The search check requires successful native search and openPage records, and the answer must cite the same official URL returned by that page fetch. Missing actions, other actions, failed fetches, and unrelated citations do not pass. Report-writing failures still run fixture cleanup.

Inspect `acceptance.json` including failures and final responses. Website redirects, network errors and model variability remain possible; do not replace a failed run's evidence with a later success.
