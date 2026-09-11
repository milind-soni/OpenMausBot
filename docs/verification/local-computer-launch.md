# Local computer helper launch

The host CUA gate must run as a headless Node process even inside a packaged
Electron app. Without `ELECTRON_RUN_AS_NODE=1`, spawning `process.execPath`
can launch another desktop instance; its single-instance handler then shows
and focuses the existing OMB window instead of answering MCP requests.

Run the isolated regression:

```sh
pnpm exec vitest run server/local-computer.test.ts \
  server/local-computer-proxy.test.ts server/mcp-bridge.test.ts \
  server/system-prompt.test.ts server/local-routing.test.ts
```

The proxy test builds the production connection descriptor inside both Node
and the real Electron executable. It then starts that descriptor against an
inert MCP child and a disposable loopback control endpoint, with a temporary
home. It asserts Node mode **before** launching, so a regression cannot open
the developer's app. It checks discovery, tool forwarding, exclusive control,
outage refusal, and draining a large final response at shutdown.

This proves the helper launch/transport, not arbitrary macOS background input
or the user's reported session. No real CUA daemon, provider, user app, or
screen is controlled. Browser and VNC/VM transports are separate and unchanged
by this fix. The prompt prefers background window-targeted actions and asks
before escalating to foreground control; that is guidance, not an OS-level
background-input guarantee.

## Responsive desktop startup

`pnpm exec vitest run electron/cua-launch.test.mjs` checks the desktop CUA
startup boundary without native permissions or controlling a real app. Electron
and the CUA SDK are mocked; every subprocess is redirected to an inert Node
child in a disposable home. The checks cover responsive asynchronous launch,
the actual eight-second TERM-ignoring timeout, Stop cancellation, original
failure details, bounded permission-status output, and cancellation of stalled
or late embedded startup without publishing over or stopping a replacement.
The installed SDK receives the startup AbortSignal directly. Registered IPC
retry checks also prove concurrent requests share one stop/start sequence and
an explicit Stop/quit during cleanup prevents its delayed restart.

The Electron subprocess ratchet permits only the pre-existing cached boot-ID
read and Linux private-group lookup. Those synchronous ownership checks remain
outside this narrow change; the active macOS launch/status calls are asynchronous.

Reference: OpenClaw's [macOS host coordinator](https://github.com/openclaw/openclaw/blob/7e1b9a63cf64fa5e77b92a7f77e8fccba7b61812/apps/macos/Sources/OpenClaw/CuaDriverHostCoordinator.swift)
keeps the daemon owned by the desktop host, and its
[window action adapter](https://github.com/openclaw/openclaw/blob/7e1b9a63cf64fa5e77b92a7f77e8fccba7b61812/extensions/cua-computer/src/window-actions.ts)
distinguishes window delivery from full-desktop input. OMB retains its existing
CUA driver, permission broker, and human-control gate rather than importing
OpenClaw's application-specific gateway or unrestricted authorization policy.

## Separate native focus issue

CUA's [background contract](https://cua.ai/docs/concepts/the-no-foreground-contract)
is background-first, with explicit foreground escalation for unsupported actions;
foreground interruption is not the expected outcome of a background call.
The bundled 0.22.1 already defaults to background delivery. The issue is not
fixed by adding that option or changing VNC.

As checked on 2026-09-11, upstream [issue #3331](https://github.com/trycua/cua/issues/3331)
and draft [PR #3530](https://github.com/trycua/cua/pull/3530) describe an additional
macOS focus problem. Even the 0.26.1 release still has the click activation path
that the draft removes. The draft's native focus-preservation evidence is pending.
Neither the helper regression nor a dependency bump establishes that this native
problem is solved. Do not label this patch a universal no-focus fix.

Qualify a future driver change against disposable target and foreground-sentinel
apps on an unlocked Mac. Check focus throughout the action, not only afterward:
AX click, pixel click, typing, scroll, covered windows, other Spaces, and actual
user takeover. Keep permissions and the host control gate enabled. Repeat through
the packaged embedded daemon, including signing and supported Mac architectures.
Do not use the operator's OMB data or authenticated browser profiles as fixtures.
