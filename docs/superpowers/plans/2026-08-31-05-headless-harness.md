# Headless Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `openmausbot serve` — a daemon that runs the harness, the companion sidecar, the webhook receiver, and the managed tunnel with no Electron and no desktop session, so routines and webhooks keep running when the laptop is closed, and the desktop and phone become clients that can list more than one machine.

**Architecture:** Almost nothing new. `server/index.ts` is already a standalone process (`pnpm dev:server`) and the companion is already a separate process. The always-on stack under `electron/` is already dependency-injected — `secure-credentials.mjs`, `control-plane-client.mjs`, `managed-companion-tunnel.mjs`, and `companion-origin-gateway.mjs` take their I/O as parameters and do not import `electron`. Only `electron/companion.mjs` does. So this plan extracts a shared supervisor those two shells both drive, adds a file-backed credential store for the headless case, and teaches the clients that a machine is a thing you pick.

**Tech Stack:** TypeScript, Node 24, Vitest, systemd/launchd unit files.

**Spec:** none — this plan is its own spec.

## Global Constraints

See [the roadmap](2026-08-31-00-control-plane-roadmap.md#global-constraints). Load-bearing here:

- **Superseded (Sep 2026):** the harness now authenticates remote clients itself (`docs/plans/remote-workspace.md`: pairing codes, sessions, and a "through a proxy" rule for forwarded requests), and `openmausbot serve --tunnel` (`server/tunnel.ts`) opens a second, IPC listener for the tunnel gateway on which every request is remote by construction. The loopback bind and its owner trust are unchanged; the sidecar is no longer the only door.
- **The loopback bind is not negotiable.** The harness listens on `127.0.0.1` and rejects any request whose `Host` is not loopback, defeating DNS rebinding. Headless must not add a second bind to the harness. Network exposure stays entirely in the companion sidecar, which is the design `companion/README.md` argues for at length — do not relitigate it.
- **Fail closed on absent capability.** A headless host has no desktop session, no `safeStorage`, and on Linux may have no seat at all. Every capability that is unavailable must report unavailable, never "off" and never "on".
- **The capability rule** applies to platform capabilities too: the client must not offer local computer control for a machine that cannot do it.

**Depends on:** nothing. Fully independent — a second worker can run this in parallel with P1–P4.

---

## Background

Today the always-on path is: Electron starts, `electron/companion.mjs` spawns the
sidecar on `:8810`, `electron/companion-origin-gateway.mjs` opens the managed origin on
`:8812`, `electron/managed-companion-tunnel.mjs` runs `cloudflared` against it, and
`cloudflare/control-plane` maps one opaque hostname to that installation. Close the app
and all four stop, taking routines (`server/routines.ts`) and the webhook receiver
(`server/webhook-ingress.ts`, `:8800`) with them. The README says this plainly in its
Status section, and it is the single biggest gap between OpenMausBot and an "AI employee".

The good news, verified: of the five always-on modules, four already take their
dependencies as injected parameters — `readSecureCredentials` in
`electron/secure-credentials.mjs` is the pattern, receiving `exists`, `isAvailable`, and
`readFile` rather than reaching for the keychain itself. Only `electron/companion.mjs`
imports `electron`.

---

## File map

- Create `server/supervisor.ts`: start/stop the harness, sidecar, webhook receiver, and tunnel as one lifecycle. Runtime-agnostic; takes a host adapter.
- Create `server/supervisor.test.ts`.
- Create `server/host-adapter.ts`: the `HostAdapter` interface plus the headless implementation (file-backed credentials, no desktop capabilities).
- Create `server/host-adapter.test.ts`.
- Create `server/serve.ts`: the `openmausbot serve` entry point — flags, logging, signal handling.
- Create `server/serve.test.ts`.
- Modify `electron/companion.mjs`: drive `server/supervisor.ts` through an Electron host adapter instead of owning the lifecycle.
- Modify `server/index.ts`: `GET /api/machine` reporting this installation's identity and capabilities.
- Modify `companion/src/routes.ts`: allowlist `/api/machine`.
- Modify `src/components/Sidebar.tsx` or settings: the machine roster.
- Create `docs/headless.md`, `build/openmausbot.service`, `build/com.openmausbot.serve.plist`.
- Modify `package.json`: a `serve` script and a `bin` entry.

---

### Task 1: The host adapter seam

**Files:**
- Create: `server/host-adapter.ts`, `server/host-adapter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CapabilityState = "supported" | "unavailable";
  export interface HostCapabilities {
    localComputerControl: CapabilityState;
    screenPreview: CapabilityState;
    dictation: CapabilityState;
    desktopViewer: CapabilityState;
  }
  export interface HostAdapter {
    readonly kind: "desktop" | "headless";
    capabilities(): HostCapabilities;
    readCredentials(): Promise<{ state: "ok" | "empty" | "unavailable"; value?: unknown }>;
    writeCredentials(value: unknown): Promise<void>;
  }
  export function headlessHostAdapter(dataDir: string): HostAdapter;
  ```

- [ ] Write a failing test: `headlessHostAdapter` reports every desktop capability as `"unavailable"`. Assert against the full `HostCapabilities` key set so a capability added later cannot silently default to supported.
- [ ] Write a failing test that credentials round-trip through a `0600` file under `dataDir`, and that a directory which is group- or world-readable is **refused** rather than written to — a headless box is usually a shared VPS, and this file is the installation credential.
- [ ] Write a failing test that an unreadable credential file returns `"unavailable"` and never `"empty"`. `electron/secure-credentials.mjs` documents why at length: a caller that cannot tell ignorance from emptiness registers a fresh installation over the top of the real one. The headless store inherits that distinction exactly.
- [ ] Run `pnpm vitest run server/host-adapter.test.ts`; expect FAIL.
- [ ] Implement. Reuse `writeFileAtomic` from `server/atomic.ts`. Do not encrypt: on a headless host there is no OS keystore to encrypt against and a key derived from a file next to the ciphertext is theatre. Document that choice in the module header and in `docs/headless.md`, and state the mitigation — file mode plus directory mode, checked on every read.
- [ ] Run; expect PASS.
- [ ] Commit `feat(headless): host adapter with a file-backed credential store`.

---

### Task 2: The supervisor

**Files:**
- Create: `server/supervisor.ts`, `server/supervisor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SupervisorOptions { host: HostAdapter; dataDir: string; port: number; webhookPort: number; companionPort: number; tunnel: boolean }
  export interface Supervisor { start(): Promise<void>; stop(): Promise<void>; status(): SupervisorStatus }
  export interface SupervisorStatus { harness: "starting" | "up" | "down"; companion: "up" | "down" | "disabled"; tunnel: "up" | "down" | "disabled"; since: number }
  export function createSupervisor(options: SupervisorOptions): Supervisor;
  ```

- [ ] Write a failing test: `start()` brings the harness up and `status()` reports `harness: "up"`; `stop()` brings it down and every child process is reaped. Assert on reaped pids — `server/kill-tree.test.ts` exists because orphaned children are a real failure mode here.
- [ ] Write a failing test that a companion that fails to bind does **not** take the harness down — the harness is the thing that must survive; remote access is an enhancement. `status()` reports `companion: "down"` and `start()` still resolves.
- [ ] Write a failing test that `stop()` is idempotent and that a second `start()` after a `stop()` works, so a supervisor can be restarted in-process without leaking a port.
- [ ] Write a failing test that `tunnel: false` skips the tunnel entirely and reports `"disabled"` rather than `"down"` — a thing turned off must not read as a thing that is broken.
- [ ] Run; expect FAIL.
- [ ] Implement, delegating to the existing modules rather than reimplementing them: the harness is `server/index.ts` in-process, the companion is a spawned `companion/src/index.ts`, and the tunnel wraps `electron/managed-companion-tunnel.mjs` through its injected-dependency surface. Do not copy tunnel logic — import it.
- [ ] Run; expect PASS.
- [ ] Commit `feat(headless): one supervisor for harness, companion, and tunnel`.

---

### Task 3: The serve entry point

**Files:**
- Create: `server/serve.ts`, `server/serve.test.ts`
- Modify: `package.json` (`"serve"` script, `"bin": { "openmausbot": "..." }`)

- [ ] Write a failing test for the pure flag parser: `parseServeArgs([])` yields the documented defaults (port 8799, webhook 8800, companion 8810, tunnel off); `--port 9000` overrides; `--no-companion` disables it; `--tunnel` enables it; an unknown flag is a typed error naming the flag, not a silent ignore.
- [ ] Write a failing test that `--tunnel` without a registered installation credential is a startup **error** with an actionable message, not a silent degrade to no tunnel.
- [ ] Run; expect FAIL.
- [ ] Implement: parse flags, build the headless adapter and supervisor, install `SIGINT`/`SIGTERM` handlers that call `stop()` and wait for it, and log one line per lifecycle transition. Log to stdout in a form a journal will keep — no ANSI, no spinners, and never a credential.
- [ ] Add the `serve` script and the `bin` entry. Keep the existing `dev:server` script working unchanged; `serve` is the supervised form, `dev:server` stays the bare one.
- [ ] Run; expect PASS.
- [ ] Commit `feat(headless): openmausbot serve`.

---

### Task 4: Report what this machine is

**Files:**
- Modify: `server/index.ts`
- Modify: `companion/src/routes.ts` (the default-deny allowlist)
- Test: `server/index.test.ts`, `companion/test/routes.test.ts`

**Interfaces:**
- Produces: `GET /api/machine` → `{ name, platform, kind: "desktop" | "headless", capabilities: HostCapabilities, appVersion, since }`.

- [ ] Write a failing API test that `/api/machine` reports the adapter's capabilities verbatim and carries no credential, no tunnel hostname, and no installation secret.
- [ ] Write a failing test in `companion/test/routes.test.ts` that `GET /api/machine` is allowlisted for paired devices and that `POST` to it is refused — the companion is default-deny per method and path, and a new route is closed until someone opens it deliberately.
- [ ] Run; expect FAIL.
- [ ] Implement. `name` defaults to the OS hostname and is overridable by `OMB_MACHINE_NAME`, because three VPS boxes all called `localhost` is not a roster.
- [ ] Run; expect PASS.
- [ ] Commit `feat(headless): expose machine identity and capabilities`.

---

### Task 5: Electron drives the same supervisor

**Files:**
- Modify: `electron/companion.mjs`
- Test: `electron/companion.test.mjs`

- [ ] Write a failing test that the Electron path produces a `desktop` host adapter whose capabilities reflect the real platform checks in `electron/capabilities.cjs`, and that it uses `safeStorage` credentials rather than the file store.
- [ ] Write a failing test that the existing port-reuse behaviour survives: `electron/companion.mjs:57` documents that the sidecar must survive an app relaunch rather than dying with it, and that property must not regress in the refactor. Pin it.
- [ ] Run; expect FAIL.
- [ ] Refactor `electron/companion.mjs` to construct a desktop `HostAdapter` and drive `createSupervisor`, deleting its own lifecycle code. This is the task most likely to break a shipped behaviour — run `pnpm test:desktop-viewer`, `pnpm check:electron`, and the full `pnpm test` before committing, and launch the packaged app once by hand.
- [ ] Run; expect PASS.
- [ ] Commit `refactor(desktop): drive the shared supervisor`.

---

### Task 6: The machine roster

**Files:**
- Modify: `src/state/store.tsx`, `src/components/SettingsPanel.tsx`
- Create: `src/components/MachineRoster.tsx`, `src/components/MachineRoster.test.ts`

- [ ] Write a failing test for the pure presence reducer: a machine whose last `/api/machine` succeeded within 60s is `online`; older than that is `stale`; one that has never answered is `unreachable`. Three states, because "not online" hides the difference between a box that is off and a box you have never reached.
- [ ] Run; expect FAIL.
- [ ] Implement the roster from the account's installations, which `cloudflare/control-plane` already lists at `GET /v1/installations` — this is a client feature over data that exists, not a new backend.
- [ ] Render each machine with its name, platform, kind, presence, and the capabilities it reports. A headless row shows local computer control as unavailable rather than off, so nobody assigns a bot a desktop it does not have.
- [ ] Run the focused test, `pnpm typecheck`, `pnpm check:contrast`.
- [ ] Commit `feat(headless): machine roster with presence`.

---

### Task 7: Ship it as a service

**Files:**
- Create: `docs/headless.md`, `build/openmausbot.service`, `build/com.openmausbot.serve.plist`
- Modify: `README.md` (the Status section's honest note about always-on)

- [ ] Write the systemd unit: `Type=simple`, `Restart=on-failure`, `RestartSec=5`, a dedicated non-root user, `StateDirectory=openmausbot`, and `ProtectSystem=strict` with `~/.openmausbot` as the only writable path.
- [ ] Write the launchd plist for a Mac mini left running, with `KeepAlive` and `RunAtLoad`.
- [ ] Write `docs/headless.md`: install, register the installation, the agent CLIs the box needs installed and logged in, the capability table for a headless host, the credential-at-rest tradeoff from Task 1 stated plainly, and the firewall guidance — the companion port must not be exposed directly; use the managed tunnel or a tailnet.
- [ ] Update the README Status line that currently says webhook triggers use a local receiver rather than an always-on hosted relay. It is about to be less true; say exactly how much less.
- [ ] Verify by hand on a real Ubuntu box: install, `systemctl start`, confirm a routine fires with no session attached, close the laptop, confirm the phone still reaches it.
- [ ] Commit `docs(headless): service units and the headless guide`.

---

## Self-review

**Coverage.** The community's "always-on and distributed" list: routines and webhooks
continue when the laptop is closed (Tasks 1–3, 7); desktop and phone become thin clients
(already true, extended by Task 6); bots on several machines appear in one roster
(Task 6); health and presence visible centrally (Tasks 4, 6).
**Two items are not covered and should not pretend to be**: "each bot can run where its
work makes the most sense" and "jobs can move between local, VPS, VM, and cloud workers".
Bot-to-machine pinning and job migration need a scheduler that can move a task's
provider session between hosts — and provider sessions are host-local by construction
(`resumeCursors` are a specific CLI's session ids on a specific disk). That is a real
plan of its own, and it comes after this one, not inside it.

**Type consistency.** `HostAdapter` and `HostCapabilities` (Task 1) are consumed by
Tasks 2, 4, 5, and 6. `SupervisorStatus` (Task 2) is what Task 3 logs. `/api/machine`'s
payload (Task 4) is what Task 6 reduces.

**The riskiest task is 5,** not 1–3. Tasks 1–4 are additive; Task 5 rewires a shipped
desktop path that a paired phone depends on. It has its own regression test for the
port-reuse property, and it should be the last thing merged and the first thing manually
verified on a packaged build.
