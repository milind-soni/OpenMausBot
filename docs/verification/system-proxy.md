# Desktop system proxy

The desktop owns an authenticated HTTP proxy bound to an ephemeral IPv4 loopback
port. Its address stays fixed until the desktop exits. Each new connection uses
the resolver session's current route. Configuration reloads every five seconds
and immediately after resume or a desktop renderer's online event. Existing
tunnels are not closed or replayed.

The resolver is an isolated, nonpersistent Electron session. Windows reads the
active user's settings through `WinHttpGetIEProxyConfigForCurrentUser`, detects
WPAD where enabled, and explicitly installs PAC, manual proxy or direct mode.
macOS and graphical Linux retain Chromium's system mode. This does not discover
a proxy application that has not enabled the system proxy. TUN routing remains
OS-owned.

An inherited HTTP/HTTPS/ALL_PROXY variable selects fixed environment mode.
The original environment is captured before the desktop installs its relay
variables; later refreshes cannot recursively select the relay itself.
Loopback traffic stays direct. Original NO_PROXY entries are retained in child
environments. The relay supports HTTP forwarding, CONNECT, HTTPS proxy TLS,
SOCKS4 and unauthenticated SOCKS5. HTTP proxy credentials supplied in an explicit
environment URL are supported; interactive enterprise proxy login is not.

Only the first route returned by the resolver is used. A failed proxy does not
fall back to a subsequent DIRECT entry. Resolution errors, reload errors and
connection errors fail the request. Windows PAC URLs explicitly use Electron's
mandatory `pac_script` mode: download, syntax and execution errors cannot fall
back to the Windows manual proxy or DIRECT. An intentional DIRECT returned by a
valid PAC script remains allowed. Previously discovered WPAD disappearing fails
closed until discovery recovers or automatic detection is disabled. Failure to
read Windows settings also fails closed. Mandatory-PAC enforcement on macOS and
Linux system mode remains unverified.

## Network path inventory

| Path | Integration | Verification |
| --- | --- | --- |
| Desktop renderer, account/cloud requests, updater sessions | Electron sessions authenticate against the local relay before fetch; resolver session is excluded | Windows native fetch and sandboxed renderer smoke passes; updater-specific paths use this session but were not independently driven |
| Server auth, models, SDK default fetch, HTTP/HTTPS, native WebSocket | Node global proxy and undici environment dispatcher, initialized before server startup | Child-process HTTP, fetch and WebSocket fixture |
| Slow OpenAI-compatible model responses | Unlimited-timeout dispatcher becomes proxy-aware in desktop mode | Typecheck and OpenAI-chat regression suite |
| Engine CLI children and MCP | Inherit stable HTTP/HTTPS/ALL_PROXY variables; existing MCP descriptors retain their HTTP special case | MCP config and Codex driver regressions |
| Companion | Inherits desktop environment and Node's startup proxy switch; its existing requests are to local harness/control endpoints | Existing loopback bypass behavior; no external companion request introduced |
| Bot Chrome | Existing SOCKS gateway validates access before connecting through the relay; remote upstream keeps precedence | Pinned-IP integration and gateway regressions |
| Linux sandbox | Existing sandbox bridge stays in place; host egress gate applies policy before relay use | Existing policy tests; Linux-only runtime cases require Linux |
| HTTP wait probes and custom-domain verification | Custom agents tunnel through relay using checked IP, retaining TLS verification and original Host/SNI | Typecheck and existing probe/domain regressions |
| Sandboxed MCP credential broker | Explicit unix-socket dispatcher stays local | Existing broker path unchanged |
| Antigravity authorization callback | Explicit direct loopback request stays local | Existing callback path unchanged |

Browser and sandbox gateways forward checked destination IPs rather than asking
an upstream proxy to resolve the hostname again. The original hostname is still
used for PAC selection. For raw browser CONNECT traffic only the destination
authority is available: port 80 is treated as HTTP and other ports as HTTPS.
Full HTTP paths are unavailable inside encrypted tunnels.

Export diagnostics to see `Network proxy: source=... state=...`. Neither relay
credentials nor proxy credentials are included in that status. There is no new
public control endpoint. CLI/headless servers outside the desktop retain their
existing environment-controlled behavior.

## Isolated verification

```sh
node --test electron/system-proxy.node-test.mjs electron/system-proxy-resolver.node-test.mjs
node scripts/run-system-proxy-smoke.mjs
```

The Node suite launches only synthetic local services and disposable children.
It covers authentication, credential stripping, HTTP forwarding, CONNECT,
SOCKS5, route changes, recovery, failed routes without DIRECT fallback,
continued established streams, browser IP pinning and inherited transports.
The Electron smoke reads the actual Windows configuration and uses injected
configuration snapshots with a synthetic PAC server and proxy in private
Electron sessions. It does not toggle OS proxy settings or access existing app
data. It drives native HTTP/HTTPS fetch and a hidden, sandboxed BrowserWindow, including
proxy failure, PAC download/syntax/runtime failures, recovery, intentional
DIRECT, manual proxy and proxy-off behavior. A pinned loopback destination counts
unexpected direct connections. Success requires the final JSON marker, not
merely exit code zero. Run this Windows fixture from the logged-in user's
desktop context. macOS and Linux require their own native acceptance runs.
OpenSSL is required to generate a temporary HTTPS fixture certificate; only the
exact certificate and fixture hostname are trusted in the private test session.

If the installed development Electron exits before startup, the runner copies
its unchanged runtime into its own disposable directory and grants only that
copy ALL APPLICATION PACKAGES read/execute access. Sandboxing remains enabled.
The runtime, profile and children are bounded and cleaned up by the parent.
It does not reset ACLs on a user profile, change OS security settings or use
`--no-sandbox`.

For server startup and conversation regression use the fixture launch, doctor,
new-bot, send and wait commands from [the verification guide](README.md).
Also run typecheck, lint, relevant tests, build:server and the packaged-server
smoke. A fake-engine conversation proves startup/turn regression only, not a
real provider connection or native OS proxy integration.

### Current verification evidence

On Windows, the 15 proxy-specific Node tests pass, including real fixture TLS
streaming and pinned custom agents. Typechecks, lint, relevant driver/MCP/probe
regressions and the packaged-server smoke pass. The isolated fake-engine chat
settles with its expected reply. MCP bundle tests require a writable temporary
directory, and the process probe requires permission to run `tasklist`.

On Windows 11 25H2 build 26200.9711, Electron 43.7.9 passes all 16 native fixture
checks with sandboxing enabled and `unexpectedDirectConnections: 0`. The source
dependency's directory-access failure is avoided using the disposable runtime.
The fixture also corrects an ESM startup deadlock and preauthenticates the
session: `app`'s login listener alone does not authenticate `session.fetch`.
macOS and Linux native smoke tests have not run. No production provider account
or real model call is part of this synthetic-service acceptance.

Primary references: [Electron 43 mandatory PAC implementation](https://github.com/electron/electron/blob/v43.7.9/shell/browser/api/electron_api_session.cc),
[Windows current-user proxy API](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpgetieproxyconfigforcurrentuser),
and [Electron's Windows install-directory access check](https://github.com/electron/electron/blob/v43.7.9/shell/browser/win/install_dir_access.cc).
