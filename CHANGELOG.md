# Changelog

All notable changes to OpenMausBot are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

## [0.1.27]

### Fixed
- **Windows build: extract Android Platform Tools under git-bash.** `scripts/prepare-android-tools.mjs`
  now tries `unzip` and falls back to `tar`, and normalizes absolute Windows paths to
  MSYS form (`C:\x` → `/c/x`) so `pnpm build:android-tools` / `pnpm package:win`
  succeed on a stock git-bash install instead of failing with
  `tar: Cannot connect to C: resolve failed`. ([#317](https://github.com/milind-soni/OpenMausBot/pull/317))

### Added
- **Reproducible Windows code-signing step.** `scripts/sign-win.ps1` signs the NSIS
  installer and the inner `OpenMausBot.exe` with any PFX — a self-signed cert
  (`build/omb-selfsigned.pfx`, gitignored) for pipeline verification, or a real
  CA-issued Authenticode cert supplied via `CSC_LINK`/`CSC_KEY_PASSWORD`.
  `electron-builder.yml` documents the flow and intentionally keeps `publisherName`
  unset so auto-update keeps working on the unsigned build.
  Note: a self-signed cert validates only on machines that trust its root; a
  CA-issued cert is still required for a SmartScreen-clean install.

[Unreleased]: https://github.com/milind-soni/OpenMausBot/compare/v0.1.27...HEAD
[0.1.27]: https://github.com/milind-soni/OpenMausBot/releases/tag/v0.1.27
