# Codex custom providers

The Codex driver accepts an instance-scoped `config.provider` containing a
Responses endpoint, model catalog, and optional API-key environment variable.
See [configuration](../custom-engines.md). MCP computer tools continue through
the same Codex connection; the model service and computer backend are separate.

## Checks

```sh
pnpm exec vitest run server/drivers/codex.test.ts server/drivers/codex-catalog.test.ts
pnpm exec vitest run server/codex-providers.e2e.test.ts
pnpm typecheck
node --experimental-strip-types scripts/verify-codex-providers.mjs
```

The driver tests use the offline app-server fixture. They cover config
validation, explicit routing on start and resume, instance-only credentials,
keyless local endpoints, model selection, account isolation, and computer MCP
mounting without putting either credential in process arguments.

The server test uses `launchVerificationServer` and `runControlOmb` to create a
bot, select two custom Codex instances in sequence, send, wait, and read the
transcript. It checks provider routing and keeps command/result evidence next
to the fixture's persistent server log. Its fake CLI never contacts the URLs.

The optional native verifier requires an installed Codex binary; `PROBE_CODEX`
can specify its path. It launches real app-server processes with temporary
homes, synthetic credentials, two loopback Responses routes, and an inert MCP
computer tool. It checks that the selected model receives the tool definition,
calls it, receives the synthetic result, and completes; each provider also
resumes its native thread. It removes its temporary home and prints a separate
retained evidence JSON path. It never reads or controls a real desktop.

## Verification status

2026-09-16: after updating upstream to v0.1.82, all 207 tests across the Codex
driver, catalog, local-provider injection, isolated server workflow, and gateway
configuration passed. Full
typechecking and lint on changed code passed after restoring dependencies from
the unchanged lockfile.

The installed Codex 0.154.0 passed the native verifier: two loopback providers
received their own model requests and synthetic credentials, each completed an
MCP computer-tool round trip, and each resumed its native thread. This release
advertises the tool inside a `mcp__computer` namespace; the fixture handles both
namespaced and flat function definitions. Its generated schema also confirms
`model` and `modelProvider` on thread start and resume. Earlier sandbox port
restrictions were resolved before these runs. No authenticated external provider,
actual screenshot, desktop action, or third-party browser action was tested.

Alumnium 0.21.0's installed `mcp` command separately passed a stdio initialize
and tools/list probe in a temporary home with no model credentials. It advertised
`start`, `do`, `get`, `check`, `fetch_accessibility_tree`, `wait`, and `stop`.
No tool was called and no browser was launched. Driver fixture assertions also
cover mounting an Alumnium-shaped custom MCP entry beside the computer tool.
