# Internal alpha packaging

The product label is **Gérer Build Studio (v0.1 Alpha)**. Use a unique package version for each installer so testers can identify exactly what they installed.

## Prepare and build

1. Use Node 24 and the pnpm version declared in `package.json`.
2. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
3. Build the installer from the candidate commit. macOS requires the Xcode Command Line Tools.

| Target | Build command | Outputs |
| --- | --- | --- |
| macOS Apple silicon | `pnpm package` | DMG and arm64 ZIP |
| Windows x64 | `pnpm package:win` | NSIS installer and x64 ZIP |

Builds land under `release/`. Pick the files for the exact version you built. The installers include compiled code built from source. Keep the generated UI, compiled server, and installer files out of Git.

## Verify the artifact

- On the target OS, install from the generated installer into a disposable profile. Check first launch, workspace setup and retry, the first useful action, Preview navigation and document images, schedules, quit, and relaunch.
- Check Settings for the expected package version and confirm the alpha installer contains no update feed or updater bridge.
- Record signer and notarization status and the SHA-256 checksums. A development-signed macOS installer is only suitable for approved internal testing. Verify with `codesign --verify --deep --strict` and check Gatekeeper assessment with `spctl --assess --type execute --verbose`.
- Share only verified artifacts with the intended internal testers. Preserve their profile data when installing a candidate over an earlier build.

The alpha uses manual installer replacement. Keep release publication separate from the source branch push.
