# Releasing Gerer Build Studio

Installers are published as GitHub Releases on `myebstudios/GererBuildStudio`. The in-app updater reads the same releases (`electron-builder.yml` → `publish`), so every release must include the update manifests.

## 1. Prepare

1. Start from a clean `main` with `pnpm typecheck` and `pnpm test` passing.
2. Bump `version` in `package.json`, then commit (`Release vX.Y.Z`).
3. Delete the previous output (`rm -rf release`) so stale artifacts can't be uploaded.

## 2. Build

| Platform | Command | Must run on |
|---|---|---|
| macOS (Apple silicon) | `pnpm package` | macOS (builds the Swift speech helper) |
| Windows (x64) | `pnpm package:win` | Windows, or macOS with Wine |

Both commands rebuild the UI (`dist/`) and the compiled server (`dist-server/`). If `dist-server/` changes, commit it; it is tracked.

## 3. Signing status

**macOS.** A distributable build needs a **Developer ID Application** certificate. As of 2026-09-24, the signing keychain holds only an *Apple Development* identity. electron-builder signs with it, but Gatekeeper rejects the app on every other Mac (`spctl -a -vv` → `rejected`), and Squirrel.Mac auto-update will not install over it. Until a Developer ID certificate is available:

- Treat macOS builds as internal/test builds.
- Testers open the app with right-click → Open, or `xattr -dr com.apple.quarantine "/Applications/Gerer Build Studio.app"`.

Once a Developer ID certificate is installed:

1. Create an App Store Connect API key and export `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
2. Set `mac.notarize: true` in `electron-builder.yml`. electron-builder then notarizes and staples during `pnpm package`.
3. Verify with `spctl -a -vv "release/mac-arm64/Gerer Build Studio.app"` → `accepted, source=Notarized Developer ID`.

**Windows.** Builds are unsigned, so SmartScreen shows "Windows protected your PC" and users must choose *More info → Run anyway*. Configure `win.signtoolOptions`/Azure Trusted Signing when a certificate is available.

## 4. Publish

1. Tag the release commit: `git tag vX.Y.Z && git push origin main vX.Y.Z`.
2. Create the release and upload **all** of these from `release/`:
   - macOS: `GererBuildStudio-X.Y.Z.dmg`, `GererBuildStudio-X.Y.Z-arm64.zip`, both `.blockmap` files, `latest-mac.yml`
   - Windows: `GererBuildStudio-X.Y.Z-setup.exe`, its `.blockmap`, the x64 `.zip`, `latest.yml`

   ```sh
   gh release create vX.Y.Z --repo myebstudios/GererBuildStudio --title "vX.Y.Z" --notes-file NOTES.md \
     release/*.dmg release/*.zip release/*.exe release/*.blockmap release/latest*.yml
   ```

3. Installed apps check hourly and offer "Restart to update". The updater needs the `.zip` on macOS and the `.exe` on Windows.

## Analytics

Release builds send no analytics. To enable PostHog, build with `VITE_POSTHOG_TOKEN=phc_…` set to a project we own, and update the Privacy section of `README.md`.
