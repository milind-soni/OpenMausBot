# Hetzner self-hosting verification — 2026-09-07

## Scope

Disposable Hetzner CX43, x86-64, Ubuntu 24.04, Node 24.20.0, npm 11.19.0.
The machine started blank; no laptop application data or engine credentials
were copied to it. The user completed the email login and Codex device login.
Application ports remained loopback-only; a firewall allowed SSH only from the
operator's current IP. The public UI used the managed HTTPS tunnel (Path A).

Baseline: published `openmausbot@0.1.60`, main `3ec6dbcd`. Runtime fixes were
built into local candidate packages and installed on the same disposable host.
Passing candidate results below do **not** mean those fixes are in the published
0.1.60 package. This was not a Docker, Tailscale, ARM64, or desktop-installer run.

## Observed results

| Check | Result |
| --- | --- |
| Blank-host npm install, email login, managed tunnel | Passed; cloudflared 2026.8.2 was fetched with its pinned digest checked. |
| Unpaired remote access | Protected config returned 403; the pairing screen was reachable. |
| Pairing and bot creation through the web UI | Passed; two bots persisted through candidate updates. |
| Real subscription-backed chat | Codex 0.153.4, `gpt-6-astra`, returned the requested `Hetzner chat works.` |
| Automatic routine | Two actual scheduled five-minute runs completed with `Scheduled Hetzner run works.`; the routine was then paused. |
| Fresh browser opt-in and UI installation | Passed after the opt-in fix; agent-browser 0.36.0 and Chrome 152.0.7977.82 installed as the service user. |
| Real bot browser tools | Initial run failed with Ubuntu's `No usable sandbox`. After the documented exact-path AppArmor setup and MCP environment fix, open, get-title, and screenshot succeeded. The captured PNG was visually inspected and showed Example Domain. |
| Full VPS reboot | Different kernel boot ID; enabled service and tunnel recovered automatically, without manual start or pairing. Existing bots and chat remained visible. |
| Post-reboot provider and sandbox | A new real turn returned `Reboot recovery works.`; Codex stayed signed in. Headless Chrome launched with the global user-namespace restriction still set to 1. |
| Paused schedule after reboot | One routine remained disabled, with its two previous runs intact. |
| Offline app-data backup and restore | Passed exact file hashes/modes, JSON records, and SQLite integrity; see scope below. |

Concrete service output after reboot:

```text
systemctl is-enabled openmausbot.service: enabled
systemctl is-active openmausbot.service: active
NRestarts=0
codex login status: Logged in using ChatGPT
kernel.apparmor_restrict_unprivileged_userns = 1
control-omb doctor: ok=true, packaged=true, availableEngines=[codex]
```

The browser received approval for only the requested public-page navigation and
screenshot. No website sign-in, permanent tool approval, `--no-sandbox`, or
global AppArmor relaxation was used. Chrome was copied to a versioned,
root-owned directory before that exact executable was allowlisted.

## Corrections identified by the run

- Missing engine installation must not prevent the user from opting into the
  browser and reaching its one-click installer. Execution still requires the
  installed engine; unsupported hosts remain disabled.
- Forward `AGENT_BROWSER_EXECUTABLE_PATH` explicitly to the browser MCP process.
  Some engine clients filter the inherited environment. Forward only the
  required variables, not arbitrary parent secrets or browser flags.
- Return 400 for malformed request URLs before routing, without crashing the
  server. Verified on an isolated Linux fixture directly and through a raw
  loopback reverse proxy; health remained 200 after each request.
- Apply the same non-admin config projection to REST, live SSE, and replayed
  SSE. Synthetic private fields stayed filtered for clients and visible to the
  administrator; event IDs and the owner's stored config remained intact.
- Document service-user installation and separate engine/browser credential
  locations, deterministic systemd installs/updates, stopped SQLite backups,
  and Ubuntu 24.04 sandbox setup. A root browser install does not populate the
  unprivileged service user's browser cache.

## Backup scope

The original service was paused for 9.4 seconds, its app-data directory archived
privately, and the original immediately restarted. A separate restored copy
matched all 45 entries and file modes. SQLite integrity passed, preserving two
bots, four tasks, fifteen messages across four threads, one paired session,
one paused routine, and two routine runs at snapshot time.

The restored copy was **not booted** and its credentials were not used. This
proves offline application-data restoration, not a whole-machine migration,
external workspaces, browser-login restoration, or provider reauthentication
on another machine. No private backup was transferred off the VPS. The exact
temporary archive and restored copy were removed after comparison.

## Local regression checks

87 targeted tests passed across ten files: browser opt-in, Computer panel,
browser MCP environment, CLI, request auth/remote sessions, resumable server
events, and SSE/thread/live-event helpers. The remaining 190 tests in the
filtered server suite were not run. TypeScript and diff checks passed. The
three changed public documentation pages compiled as MDX and their shell
examples passed syntax checks; this was not a full documentation-site build.

## Limits and follow-up

Not verified in this run: Docker/Caddy, Tailscale, Linux ARM64, Windows/macOS
installers, other provider accounts, signed-in browser-session persistence,
bot-deletion browser-state cleanup, VM computer control, load/capacity limits,
or a running restored installation. No multi-tenant security certification is
implied by the targeted auth checks.

A bot-settings close observation remained inconclusive: automation still saw
the dialog after a close action although a disposable diagnostic fixture's
reducer/render saw `settingsOpen: false`. Foreground/committed-render confirmation
was unavailable. No speculative production close-state change was made.

Desktop bundling was outside this VPS run. The subsequent
[desktop browser packaging change](../browser-packaging.md) includes Chromium
Headless Shell and separate native package checks; do not read this VPS report
as verification of those installers. This run used the self-hosted browser
installation flow, not the new desktop bundle.

## Cleanup

Codex was signed out on the VPS, and OpenMausBot logout confirmed the managed
address was released. The exact disposable server, its primary IPv4, firewall,
and uploaded SSH key were deleted. Fresh lists of all four resource types were
empty. The private Hetzner API-token file was retained locally as requested;
it was not added to the repository. No user application data was changed.
