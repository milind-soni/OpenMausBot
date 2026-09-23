# Windows helper consoles and browser recovery

The reported black windows belong to `chrome-headless-shell.exe` and
`cua-driver.exe`, not to a user terminal. Both native launch sites omitted
`CREATE_NO_WINDOW`. Setting `windowsHide` on OMB's Node children does not
configure grandchildren launched by Rust.

## Dependency changes

- `third_party/browser/agent-browser-windows-stdio.patch` adds a headless-only
  creation flag. Headed Chrome remains visible; the existing Windows pipe
  inheritance backport is retained. Build/test the candidate through
  **Windows browser vendor build**, then publish and pin the verified bytes
  before claiming the app ships this correction.
- `third_party/cua/windows-embedded-console.patch` changes only the embedded
  SDK's private daemon launch. Windows packaging builds the SDK DLL from the
  hash-pinned 0.28.2 source with its original Cargo lock and Rust toolchain.
  The official signed driver EXE and generated UniFFI bindings stay unchanged.
  This temporary backport requires Rust/MSVC on the packaging machine (the
  GitHub Windows runner has them), not on users' machines. Remove it when an
  official SDK release includes the launch fix. No binary signature is stripped
  or executable header rewritten.

## Local checks

```sh
pnpm exec vitest run server/browser-live.test.ts src/components/BrowserPanel.test.ts electron/cua-windows-isolation.test.mjs scripts/build-windows-browser-vendor.test.mjs scripts/build-windows-cua-sdk.test.mjs
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/control-omb-ui.e2e.test.ts -t 'keeps an existing conversation'
```

The renderer test injects unavailable provider snapshots into a disposable
fixture, not into real user accounts. Existing chats must stay visible.
The relay test disconnects Chromium without closing its daemon WebSocket:
the SSE stream must terminate with a retryable error, not keep emitting healthy
heartbeats. The panel's existing bounded retries still apply. No action replay.

Run the [native browser recipe](browser-live.md) with `--recovery` for real
idle retention and live-view recovery. This does not prove Windows behavior
when executed on macOS.

## Required Windows package checks

Run **Package Windows** on the final branch. Its gates launch the real packaged
CUA SDK/driver, assert start/stop and no matching visible console, and exercise
the packaged browser through cold start, input, screenshot and close/reopen.
The console assertion samples visible windows after startup and restart; it
does not prove there is never a short-lived flash or replace interactive QA.
Release uses the same gates. Test installing over an existing Windows install
and leave a browser page open while switching chats before release.

## Research

- [Playwright issue 40741](https://github.com/microsoft/playwright/issues/40741)
  documents the same headless-shell console symptom and why hiding all browser
  launches can regress headed Inspector windows.
- [Puppeteer's launcher](https://github.com/puppeteer/puppeteer/blob/main/packages/browsers/src/launch.ts)
  owns process launch and cleanup, rather than treating an open transport as
  proof a browser is alive.
- [OpenClaw browser documentation](https://github.com/openclaw/openclaw/blob/main/docs/tools/browser.md)
  also uses Chromium/CDP with isolated profiles; replacing our browser stack is
  not necessary to fix these launch and connection-state issues.
- [CUA 0.28.2 embedded host](https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.2/libs/cua-driver/rust/crates/cua-driver-sdk/src/embedded.rs)
  owns the daemon PID, startup handshake and parent-liveness pipe. Keep that
  lifecycle intact rather than launching an unrelated daemon through a shell.
