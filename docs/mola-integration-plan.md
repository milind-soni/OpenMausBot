# Mola Integration Plan

## Overview
Add Mola (mola.sh) as a cloud computer provider in OpenMausBot, following the existing Boat integration pattern.

## Mola API Summary
- **Base URL**: Default `http://127.0.0.1:4141/v1` (self-hosted) or cloud.mola.sh
- **Authentication**: Bearer token in Authorization header
- **Default OS**: Ubuntu (configurable via image_ref)

### Key Endpoints
1. `POST /v1/machines` - Create machine (returns 201 with machine object)
2. `GET /v1/machines` - List machines
3. `GET /v1/machines/{id}` - Get machine details
4. `POST /v1/machines/{id}/start` - Start stopped machine
5. `POST /v1/machines/{id}/stop` - Stop machine (with force option)
6. `POST /v1/machines/{id}/actions` - Execute actions (exec, screenshot, etc.)
7. `POST /v1/machines/{id}/desktop` - Get desktop URL (60s single-use ticket)
8. `DELETE /v1/machines/{id}` - Destroy machine

### Machine States
- `booting` - Starting up
- `ready` - Running and guest has reported in
- `stopped` - Shut down
- `starting` - Transitioning to running
- `unknown` - Runtime status unclear

### Actions
- `exec` - Run shell command
- `read_file` / `write_file` - File operations
- `screenshot` - Capture screen
- `click`, `move`, `scroll`, `type`, `key` - Input control

## Implementation Plan

### 1. Configuration (server/config.ts)
- Add `mola?: { token?: string; apiUrl?: string }` to config schema
- Support `MOLA_API_KEY` and `MOLA_API_URL` environment variables
- Follow Boat pattern with optional API URL override

### 2. Provider Integration (server/mola.ts)
Create new file following boat.ts structure:
- `molaConfigured()` - Check if Mola credentials exist
- `molaAccount()` - Get credential (own or included)
- `provisionMola()` - Create and start machine
- `findMola()` - Find existing machine for bot
- `readyMola()` - Ensure machine is ready
- `joinMola()` - Get desktop URL
- `sleepMola()` - Stop machine
- `execOnMola()` - Run commands
- `screenshotMola()` - Capture screen
- `deleteManagedMola()` - Destroy machine

### 3. Inventory Management
- `listManagedMolas()` - List machines with OpenMaus naming
- Idempotency and recovery logic
- Deletion journal similar to boat-delete-journal.ts

### 4. Included Services (server/included-services.ts)
- Add Mola relay support: `OMB_CLOUD_MOLA_URL` + `OMB_CLOUD_MOLA_TOKEN`
- Export `MOLA_API_DEFAULT` constant
- `molaCredential()` function
- `molaProviderApi()` function

### 5. UI Updates
- Add Mola icon/logo (src/components/provider-icons.ts or similar)
- Update Settings → API keys page to include Mola
- Update computer provider selection UI

### 6. Documentation
- Add docs/mola.md with setup instructions
- Update CONTRIBUTING.md if needed
- Add verification fixtures

### 7. Tests
Following existing test patterns:
- `server/mola.test.ts` - Unit tests for core functions
- `server/mola-lifecycle.test.ts` - Lifecycle tests
- `server/mola-provision.test.ts` - Provisioning tests
- `server/mola-inventory.test.ts` - Inventory management tests

## API Gaps Analysis

### Supported by Mola
✅ Create machines with custom resources
✅ Start/stop lifecycle
✅ Shell execution (via actions)
✅ File read/write (via actions)
✅ Desktop streaming (browser-based)
✅ Screenshots
✅ Mouse/keyboard input
✅ Machine listing and status

### Potential Gaps
⚠️ Port forwarding - Has tunnel support via WebSocket (needs investigation)
⚠️ Persistent action sessions - Has `/session` endpoint for low-latency actions
⚠️ Auto-sleep/TTL - No automatic TTL like Boat (must manage manually)
⚠️ Snapshot/resume - No explicit snapshot API in docs
⚠️ Legacy name adoption - Simpler than Boat (no migration needed)

## Files to Create/Modify

### New Files
- `server/mola.ts` - Main provider implementation
- `server/mola-create-idempotency.ts` - Creation tracking
- `server/mola-delete-journal.ts` - Deletion tracking
- `server/mola-lifecycle.test.ts` - Lifecycle tests
- `server/mola-provision.test.ts` - Provisioning tests
- `server/mola-inventory.test.ts` - Inventory tests
- `docs/mola.md` - Documentation

### Modified Files
- `server/config.ts` - Add Mola config schema
- `server/included-services.ts` - Add Mola credential resolver
- `server/credential-env.ts` - Add MOLA_API_KEY
- `src/components/keys/key-catalog.ts` - Add Mola to key catalog
- `src/components/ProviderIcons.tsx` - Add Mola icon (if needed)

## Default Image Selection
Mola supports multiple images via `image_ref`:
- `omarchy-agent:0.1.0` (Arch Linux + Hyprland, default)
- Ubuntu 24.04 XFCE (optional, requires separate image)

For OpenMausBot integration, default to Ubuntu for consistency with typical cloud provider expectations, but allow override via config or environment variable.

## Testing Strategy
1. Unit tests for all core functions
2. Integration tests for lifecycle operations
3. Idempotency tests for create/delete
4. Inventory reconciliation tests
5. Manual verification against real Mola instance
