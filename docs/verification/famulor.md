# Famulor connection

The first-party Famulor card uses the existing MCP registry and OAuth flow. It
connects to `https://app.famulor.io/mcp`, with browser sign-in and no pasted API
key or Composio dependency. The bundled logo is attributed in
`src/assets/famulor/README.md`.

## Isolated browser verification

Use an installed Playwright module and Chromium executable. Set
`OMB_VERIFY_PLAYWRIGHT` to its absolute module entry and
`OMB_VERIFY_BROWSER_CHROME` to the browser executable if Playwright cannot
resolve its own browser. Then run:

```sh
node --experimental-strip-types scripts/verify-famulor.ts
```

This launches a disposable fake-engine workspace and synthetic OAuth/MCP
provider, then drives the real Apps modal in a fresh browser context. Only
fixture middleware maps the official URL to the loopback fake; production code
has no alternate endpoint or test switch. It checks:

- Failed saves show an error and retry without a duplicate server.
- A pre-existing unrelated server named `famulor` is never overwritten.
- Cancellation and denied consent leave the connection disabled.
- Repeated sign-ins reuse the configured server.
- Famulor connects directly in the same grid as the Composio apps, without a
  Composio key or a detour to the MCP settings. Connected filtering and its
  count include Famulor; disconnect removes it from that filter.
- Successful consent plus tool discovery enables the connection; an OAuth
  token reaches the synthetic provider without appearing in the renderer list.
- Failed post-login tool discovery does not enable the server and is retryable.
- Reload keeps the connection; disconnect disables it and revokes sign-in.
- Narrow layout has no page overflow; no business tools execute during setup.

Screenshots default to `/tmp/omb-famulor-evidence`; override with
`OMB_UI_EVIDENCE_DIR`. All fixture processes and data are cleaned up, with the
server log retained. This proves the integration mechanics, **not a live Famulor
account or a real call**. The live endpoint's published OAuth metadata was
inspected separately and advertises dynamic registration, PKCE S256 and refresh
tokens.

## Regression checks

```sh
pnpm exec vitest run src/lib/famulor-integration.test.ts src/components/PluginsPanel.navigation.test.ts src/components/PluginsPanel.i18n.test.ts src/components/McpServersPanel.test.ts src/components/McpServersPanel.embedded.test.ts src/components/McpServersPanel.famulor.test.ts src/components/McpServersPanel.whop.test.ts src/lib/mcp-sign-in.test.ts server/mcp-oauth.test.ts server/mcp-oauth-discovery.test.ts server/mcp-oauth-store.test.ts server/mcp-probe.test.ts server/mcp-selection.e2e.test.ts server/mcp-remote-proxy.test.ts server/mcp-gate-config.test.ts server/drivers/pi-mcp-extension.test.ts scripts/testing/verification-docs.test.ts scripts/testing/file-size-ratchet.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
```

## Live acceptance (account owner required)

Open Plugins → Famulor → Connect. Complete Famulor's browser consent;
verify its tools appear and ask a permitted bot to list assistants. Do not
place calls or start campaigns as a connection smoke test: those can spend
credits. Under Bot access, open the relevant bot's Access settings and change
its MCP selection; the next task should follow it. Disconnect and verify a new
task cannot use the signed-out connection.

Famulor's hosted service currently requests the scopes it advertises, including
workspace assistants, calls, campaigns, leads and settings. Choosing an
assistant in a prompt is not an account-level restriction. This change adds no
blanket auto-confirm policy and no separate credential store. Normal OMB
approval modes are unchanged. A workspace key (`Authorization: Bearer fam_…`)
remains available only as a custom MCP server, not as a second card.

Upstream: [Famulor](https://www.famulor.io).
