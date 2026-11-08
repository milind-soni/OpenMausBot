# Contribution Summary: Arch Linux Support & Security Audit

This document outlines the contributions made to **OpenMausBot** for Arch Linux compatibility, native packaging support, and the security vulnerability assessment.

---

## 1. Summary of Changes

### A. Arch Linux Native Packaging Support
- **`electron-builder.yml`**:
  - Added the `pacman` target configuration under Linux distribution targets.
  - Specified Arch Linux system library dependencies (`fuse3`, `gtk3`, `nss`, `alsa-lib`, `libcups`, `mesa`) to ensure reliable installation on fresh Arch/EndeavourOS/CachyOS systems without missing runtime libraries.
- **`package.json`**:
  - Added dedicated packaging scripts:
    - `"package:arch"`: prepares dependencies and builds the native `.pacman` package.
    - `"package:pacman"`: alias targeting the pacman builder target.
- **`docs/linux-desktop.md`**:
  - Documented building from source for Arch Linux via `pnpm package:arch`.
  - Added installation instructions using `sudo pacman -U release/OpenMausBot-*.pacman`.

### B. Desktop Environment Verification on Arch / Wayland
- Built and packaged the desktop bundle on an Arch Linux distribution (CachyOS) running KDE Plasma on Wayland (`kwin_wayland`).
- Verified direct execution of `./release/linux-unpacked/openmausbot` under Wayland (`--ozone-platform=wayland`).
- Verified package artifact creation: `release/OpenMausBot-0.1.149-x64.pacman` (238 MB).

---

## 2. Security Vulnerability Audit Report

A source code security review was performed across the codebase's main trust boundaries. Below is a summary of identified areas for hardening:

### Finding 1: Single-Pass Path Sanitization in Static File Serving
- **File**: `server/static-files.ts` (`serveStatic`)
- **Detail**: Path traversal filtering uses a single-pass `path.replace(/\.\./g, "")` before `join(staticDir, safe)`. While the URL parser normalizes paths in typical queries, single-pass substring stripping is susceptible to nested patterns (e.g., `....//`).
- **Recommendation**: Replace substring stripping with canonical path boundary verification (`realpathSync(target).startsWith(realpathSync(staticDir))`).

### Finding 2: Unauthenticated Loopback Read Access in Desktop Mode
- **File**: `server/request-auth.ts` (`mutatingPublicRoute`, `resolveRequestAuth`)
- **Detail**: The private desktop owner token (`x-openmausbot-desktop-owner`) is only required for mutating requests (`POST`, `PUT`, `DELETE` and specific sensitive `GET` routes). General loopback `GET` requests on `127.0.0.1:8799` do not require authentication from non-browser callers.
- **Recommendation**: On multi-user systems, authenticate read endpoints with the desktop capability or restrict unprivileged loopback peers.

### Finding 3: Unrestricted HTTPS Target Fetching in MCP OAuth Discovery
- **File**: `server/mcp-oauth-discovery.ts` (`isAllowedAuthUrl`)
- **Detail**: `isAllowedAuthUrl` allows all `https://` URLs without validating whether the hostname resolves to internal private network addresses (e.g., RFC 1918 private subnets or internal LAN hosts).
- **Recommendation**: Route MCP discovery requests through the egress IP filtering logic (`server/browser/egress/policy.ts`) or resolve DNS hostnames before fetching.

### Finding 4: Linux Terminal Emulator Detection on Wayland / Non-GNOME Desktop Environments
- **File**: `electron/terminal-launch.mjs` (`openBlankTerminal`)
- **Detail**: The terminal launcher checks only `["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]`. Standalone Wayland tiling environments on Arch (Hyprland, Sway) commonly use modern terminals like `kitty`, `alacritty`, `foot`, or `wezterm`, which would fail terminal hand-offs if none of the 4 defaults are present.
- **Recommendation**: Expand the candidate list to include `kitty`, `alacritty`, `foot`, and `wezterm`.

---

## 3. How to Test & Verify

```bash
# 1. Install dependencies
pnpm install --frozen-lockfile

# 2. Build application and native packages
pnpm package:arch

# 3. Verify generated pacman package
ls -lh release/*.pacman

# 4. Install locally on Arch Linux
sudo pacman -U release/OpenMausBot-*.pacman
```
