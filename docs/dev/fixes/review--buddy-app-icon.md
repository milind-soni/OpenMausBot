---
status: review
created: 2026-11-18
updated: 2026-11-18
scope: App icon replaced with the mint Gerer Buddy
owner: Yv
related: [review--buddy-avatars-and-terminology.md]
---

# Replace the app icon with the mint Gerer Buddy

Swap the silver cursor icon for the Buddy from `Assets/Buddy Avater/`, and regenerate every icon file the app and its installers use.

- [?] **Design the icon** — `build/icon.svg:1`. Mint Buddy (body turned 9°, upright eyes on the placement guide) on a dark tile using the macOS grid (824 tile, 100 inset). Legible at 16 px on light and dark backgrounds.
- [?] **Set it everywhere** — `public/app-icon.svg:1` (favicon), `build/icon.iconset/` + `build/icon.icns` (macOS package, 10 sizes), `build/icon.ico` (Windows package, 16–256), `electron/resources/app-icon.png:1` (Dock, window and tray at runtime via `electron/main.mjs:34`).

## Verification

- Rendered with Electron at 1024 px and checked at 16, 32, 64 and 128 px on light and dark backgrounds.
- Unpacked `build/icon.icns` with `iconutil`: 10 sizes, all showing the new artwork.
- Not yet seen in the Dock: the running dev app loads the icon at launch, so it needs a restart. The packaged `.app` and installers pick it up on the next `pnpm build`/package run.
