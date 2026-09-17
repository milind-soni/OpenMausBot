# One-click engine installation (MOCA-139)

Supported npm-based engines remain installable when the machine running
OpenMausBot has no Node.js, npm, or npx. The app downloads pinned Node.js
24.14.1 archives from nodejs.org, verifies a checked-in SHA-256 digest before
extraction, and keeps Node/npm, installed engines, and npm's cache in the
workspace's `tools` directory. No shell profile, global npm prefix, or system
installation is changed. Account sign-in remains a separate user action.

The private fallback targets macOS, Windows, and glibc Linux on x64/arm64.
Alpine/musl and other unsupported targets retain manual setup. Extraction uses
the operating system's tar utility (including Windows System32/tar.exe).
Custom CLI overrides remain authoritative; installing another copy does not
silently replace the configured override. A detected but unhealthy binary is
shown as needing setup, not as missing.

## Network smoke, isolated from the user's app

```sh
node --experimental-strip-types scripts/verify-engine-install.ts --download
```

This opt-in check downloads official Node and the npm `@openai/codex` package,
forces an empty prerequisite PATH, installs to a temporary directory, restores
the startup PATH registration, repeats the install as an update, and executes
`codex --version`. It removes that
exact temporary installation afterward. It does not sign in, create an agent
conversation, or call a model. Run it natively on each release target; a macOS
pass is not evidence of Windows/Linux acceptance. Updating runtime pins requires
checking the official release digests and rerunning this check.

## Renderer fixture

```sh
node --experimental-strip-types scripts/verify-engines-ui.ts
```

Open the printed `previewUrl`. All changes stay in synthetic fixture data.

1. Click **Clean machine preview**. Onboarding opens with **Not installed** and
   **Install Codex on this server** immediately visible, even without npm.
2. Click Install. Verify **Preparing required tools**, then **Installing**,
   with the install button disabled. The fixture's first attempt deliberately
   fails; verify its error and a usable Install button.
3. Retry. Success must transition directly to **Sign-in required** and
   **Connect ChatGPT**. No real sign-in request is permitted by this fixture.
4. Click **Model picker preview**, then the model trigger. Start installing
   Codex and switch to Qwen before it finishes. After Codex completes, Qwen
   must still offer **Install Qwen on this server**, not inherit Codex's
   completed state. Click Qwen's Install and verify it starts its own operation.
5. Inspect the narrow 390px layout and normal desktop layout. Names and statuses
   are visible in the rail, the pane scrolls, and the page does not overflow.

Interrupt the launcher to stop its owned server and delete fixture data. Reset
any temporary browser viewport override. This fixture proves renderer state
transitions, not real package installation or provider authentication.

## Regression checks

```sh
pnpm exec vitest run server/node-runtime.test.ts server/engine-install.test.ts server/harness/registry.test.ts src/components/EngineSetup.test.ts src/components/ModelPicker.test.ts src/components/onboarding/beats/EnginesBeat.test.ts scripts/verify-engines-ui.test.mjs
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
pnpm test:packaged-server
```

The private-runtime archive fixture currently runs on POSIX. Windows npm entry
resolution and successive managed npm execution have platform-neutral regression
tests; native Windows download/extraction still needs its own acceptance run.

## Verification record — 2026-09-14

- macOS arm64 network install/update smoke passed with an empty prerequisite PATH;
  downloaded Codex reported `codex-cli 0.154.0` and the temporary install was removed.
- Isolated real renderer: visible clean-machine install, preparation/install
  stages, failure/retry, and transition to Connect ChatGPT passed.
- Switching from an installing Codex to missing Qwen preserved Qwen's own
  Install action after Codex completed. Qwen then started its own installation.
- The model picker fit a 390px viewport: page width 390px, dialog width 358px,
  dialog scroll width 356px. Temporary browser viewport was reset.
- Targeted tests: 138 passed, 8 platform-specific skips. Typecheck, lint,
  locale validation, production build, and packaged-server smoke passed.
- No real provider account was used. Windows and Linux native acceptance is
  not claimed by this record.
