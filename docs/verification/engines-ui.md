# Engine library: onboarding and Settings

Use the actual renderer with sample engine statuses and a disposable server:

```sh
node --experimental-strip-types scripts/verify-engines-ui.ts
```

Open its printed `previewUrl`. The bottom toolbar switches between the real
Settings modal and onboarding, applies the app's Midnight/Atelier skins, and
toggles a synthetic Antigravity connection. Click **Maybe later** on the first
onboarding step to reach engines. Provider install, sign-in, path-save, and
account-management requests are rejected by fixture-only middleware; no real
provider login or user configuration is involved. A rejected setup request is
useful for checking error presentation, not evidence that provider auth works.
Vite's generated source cache stays in the checkout's ignored
`.omb-scratch/engine-preview-vite` directory; fixture accounts, home, and app data
remain disposable. Keeping these separate prevents late cache writes from
recreating a removed fixture directory.

## Checks

1. At 1280px, both screens group cards into Ready / Needs setup, with two
   columns, existing provider marks, and the selected skin's colors. At 390px,
   cards become one column; no horizontal page overflow; onboarding Continue
   and Settings Close remain reachable while the engine list scrolls.
2. Expand Antigravity in Settings, expand **CLI path and updates**, choose
   **Set CLI…**, and enter `/preview/keep-this-draft`. Click **Toggle sample
   connection**. Its card moves into Ready while staying expanded and retaining
   that unsaved path. Collapse/reopen the card; the draft must remain.
3. In onboarding, toggle the sample connection. Group counts and Antigravity's
   status change immediately without reopening onboarding or changing focus.
   `Claude · Local` remains Ready despite having no cloud login.
4. With Antigravity needing setup, click **Sign in with Google**. The synthetic
   error appears and the button becomes enabled again. Settings must remain
   closable. Real Google browser, callback and account flows are deliberately
   not exercised by this fixture.
5. Expand Codex/Claude and check that account identity and protected sign-out
   controls are retained. Expand the advanced CLI disclosure to reach path,
   reset and update controls. Tab to a card and press Enter/Space; its native
   disclosure must work with a visible focus indicator.
6. Expand Kimi to find **Install Kimi on this server**, and OpenCode to find
   **Update OpenCode on this server**. Click each and confirm the fixture error
   appears with its button usable again. Terminal commands remain under
   **Prefer a terminal?**. These clicks never perform a real installation.

Automated coverage:

```sh
pnpm exec vitest run scripts/verify-engines-ui.test.mjs
pnpm exec vitest run src/components/EngineLibrary.test.ts src/components/EnginesSettings.test.ts src/components/EngineSetup.test.ts src/components/ClaudeAccountSettings.test.ts src/components/CodexAccountSettings.test.ts src/components/ClaudeSignIn.test.ts src/components/CodexDeviceSignIn.test.ts src/components/EngineUpdateNotice.test.ts src/components/SettingsModal.appearance.test.ts src/components/ModelPicker.test.ts
pnpm typecheck
pnpm i18n:check
pnpm build
```

Interrupt the foreground launcher to stop only its owned child and remove its
temporary data. Keep the printed server log as evidence. Restore any temporary
browser viewport override after responsive checks. This recipe does not prove
real provider installations or sign-ins; use the separate
[offline server sign-in recipe](server-settings.md) for the real auth boundary.

Stopping during unfinished Vite dependency transforms can still report exit 13
from `ui.close()`. The app server and its disposable data are cleaned first;
verify those outcomes rather than treating that development-tool exit code as
an installed-app failure. Ready preview shutdown exits 0; startup cancellation
reports the launch-cancelled error.
