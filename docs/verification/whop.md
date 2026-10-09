# Whop connection

The first-party Whop card uses the existing MCP registry and OAuth flow. It
connects to `https://mcp.whop.com/mcp`, with browser sign-in and no pasted API
key or Composio dependency. The bundled logo is attributed in
`src/assets/whop/README.md`.

## Isolated browser verification

Use an installed Playwright module and Chromium executable. Set
`OMB_VERIFY_PLAYWRIGHT` to its absolute module entry and
`OMB_VERIFY_BROWSER_CHROME` to the browser executable if Playwright cannot
resolve its own browser. Then run:

```sh
node --experimental-strip-types scripts/verify-whop.ts
```

This launches a disposable fake-engine workspace and synthetic OAuth/MCP
provider, then drives the real Apps modal in a fresh browser context. Only
fixture middleware maps the official URL to the loopback fake; production code
has no alternate endpoint or test switch. It checks:

- Failed saves show an error and retry without a duplicate server.
- A pre-existing unrelated server named `whop` is never overwritten.
- Cancellation and denied consent leave the connection disabled.
- Repeated sign-ins reuse the configured server.
- Whop connects directly in the same grid as the Composio apps, without a
  Composio key or a detour to the MCP settings. Connected filtering and its
  count include Whop; disconnect removes it from that filter.
- Successful consent plus tool discovery enables the connection; an OAuth
  token reaches the synthetic provider without appearing in the renderer list.
- Failed post-login tool discovery does not enable the server and is retryable.
- Reload keeps the connection; disconnect disables it and revokes sign-in.
- Narrow layout has no page overflow; no business tools execute during setup.

Screenshots default to `/tmp/omb-whop-evidence`; override with
`OMB_UI_EVIDENCE_DIR`. All fixture processes and data are cleaned up, with the
server log retained. This proves the integration mechanics, **not a live Whop
account or a real payment operation**. The live endpoint's published OAuth
metadata was inspected separately and advertises dynamic registration, PKCE
S256, refresh tokens and the `admin` scope.

## Regression checks

```sh
pnpm exec vitest run src/lib/whop-integration.test.ts src/components/PluginsPanel.navigation.test.ts src/components/PluginsPanel.i18n.test.ts src/components/McpServersPanel.test.ts src/components/McpServersPanel.embedded.test.ts src/lib/mcp-sign-in.test.ts server/mcp-oauth.test.ts server/mcp-oauth-discovery.test.ts server/mcp-oauth-store.test.ts server/mcp-probe.test.ts server/mcp-selection.e2e.test.ts server/mcp-remote-proxy.test.ts server/mcp-gate-config.test.ts server/drivers/pi-mcp-extension.test.ts scripts/testing/verification-docs.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
```

## Live acceptance (account owner required)

Open Plugins → Whop → Connect. Complete Whop's browser consent;
verify its tools appear and ask a permitted bot to list your products. Do not
create charges, transfers or refunds as a connection smoke test. Under Bot
access, open the relevant bot's Access settings and change its MCP selection;
the next task should follow it. Disconnect and verify a new task cannot use
the signed-out connection.

Whop's hosted service currently requests admin access across the user's managed
businesses. Choosing a business in a prompt is not an account-level restriction.
Consequential operations retain Whop's prepare/confirm protocol and idempotency
requirements. This change adds no blanket auto-confirm policy, new payment
tools, or independent credential store. Normal OMB approval modes are unchanged.

Upstream: [official Whop MCP](https://github.com/whopio/whop-mcp-server).
