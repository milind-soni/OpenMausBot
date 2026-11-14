# Cline engine

Install the standalone Cline CLI (`npm install -g cline`) and run `cline auth`
in a terminal to choose its provider, model and account. OpenMausBot's **Cline**
model provider uses **Cline default (configured)**; provider/model selection
stays in Cline. A missing CLI or unconfigured account remains unavailable.
Use **Set CLI** for a wrapper with `--config` or `--data-dir` when needed.

The driver reads only the selected entry of Cline's version-1
`data/settings/providers.json`. It does not rewrite it. ACP currently needs
the selected API key in `CLINE_API_KEY` for saved API providers; OAuth login
and refresh remain Cline's responsibility. A saved custom model is pinned
over ACP before the prompt so it cannot silently become a catalog fallback.

Permissions always go through OpenMausBot's ACP approval broker, including
Full Access. Cline's terminal auto-approval default is explicitly disabled.
MCP tools use the existing scoped integration gate. Native tool selection is
not advertised: removing native tools from a bot's allowlist is refused.
MCP credential changes restart a cached native process before resuming.
The published CLI records ACP's MCP list without connecting it; the driver
uses `CLINE_MCP_SETTINGS_PATH` to connect that same gated list through a private
per-thread file. An empty list disables ambient Cline MCP servers. These files
are removed when the engine is disposed; the user's MCP settings are untouched.

## Automated checks

```sh
pnpm exec vitest run server/drivers/acp/cline.test.ts server/drivers/acp/acp.test.ts server/config.test.ts
```

These contract tests use a fake CLI and disposable homes. They cover engine
discovery, scoped team MCP configuration, credential isolation, configured
model selection and refusal, malformed configuration, denied permissions,
Full-to-Ask transitions, cancellation and a missing executable.

To qualify the actual installed CLI without a paid provider or real account:

```sh
OMB_CLINE_NATIVE_PATH=/path/to/cline pnpm exec vitest run scripts/testing/cline-native.e2e.test.ts
```

This creates a disposable Cline home, configures a loopback API provider,
sends a native turn and checks the received model, discovery and execution of
a disposable notes MCP tool, streamed canonical reply, successful settlement
and unchanged provider settings. A second recipe requests harmless shell marker
writes in Ask, Full and Ask again: only the explicitly approved Full turn may
write its marker, and all three must emit canonical approval requests.
Unexpected execution requests are denied. Metadata-only evidence is written
under `.omb-scratch/verify-evidence/`; temporary homes are removed.

The product workflow is also covered by `server/cline-engine.e2e.test.ts`: a
Chief discovers Cline through `list_team_setup`, a Cline specialist is created,
and its turn settles through the normal harness. That workflow uses fake
provider CLIs; only the optional native recipe above executes Cline itself.

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/cline-ui.e2e.test.ts
```

This recipe mounts the real chat renderer against a disposable server and fake
provider CLIs. It selects the configured Cline model in Simple and Advanced
mode, verifies the saved selection through the API, and sends a specialist
message through the composer. It checks the stored reply and browser console,
then closes its owned browser profile, preview and server.

## UI and account checks

`node --experimental-strip-types scripts/verify-engines-ui.ts` renders the
real provider settings screen with a synthetic Cline card; installation and
authentication requests are blocked. Capture desktop and narrow layouts.

For a dedicated test account, check `cline auth` with the chosen API provider
or OAuth account, select Cline for a new bot, and send a turn. As a Chief, use
`list_team_setup` and confirm the Cline engine/model entry; configure a Cline
specialist and verify scoped team communication. Reject an execution in Ask,
cancel a running turn, then test Full followed by Ask. Repeat on Linux before
claiming native Linux or real OAuth qualification. The loopback recipe does
not prove a paid provider, OAuth refresh or native Linux execution.

## Initial qualification

On 2026-10-11, both native recipes passed with Cline 3.0.70 on a physical Mac
running macOS 26.6.2. The model provider was an owned loopback fixture, not a paid
model or real account. Native Linux and real OAuth were not tested.

The settings captures use the real renderer with synthetic engine status.
The model-picker and composer recipe also passed in both interface modes using
fake provider CLIs; it does not claim another native Cline execution.

| Before: Cline absent from the engine catalog | After: Cline setup and configured default |
| --- | --- |
| ![Original engine settings](assets/cline/before.png) | ![Cline in engine settings](assets/cline/after.png) |

![Cline settings in a narrow viewport](assets/cline/after-mobile.png)

![Configured Cline model in the real chat picker with fake provider CLIs](assets/cline/after-picker.png)
