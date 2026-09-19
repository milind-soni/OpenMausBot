// Box (box.ascii.dev) provider — the bot's cloud computer. Ported from
// agentcal-api src/providers/box.js, reshaped per-bot instead of
// per-customer: every bot gets one persistent box (deterministic name),
// stop pauses billing while the disk survives, and Join always mints a
// FRESH desktop URL (stream tokens rotate on every state change — never
// persist one).
//
// Substrate facts (probed by agentcal 2026-07-24 on a live box):
//   - REST only: POST /boxes/{id}/commands runs shell synchronously.
//   - stop→archived ~5s, resume→idle ~8s; disk persists, tmux does not.
//   - X11 desktop with Chrome + Ghostty; passwordless sudo; node 24.
//   - the dedicated IP rotates across archive/resume — never persist it.

// Public import surface. The implementation lives in focused modules under
// ./box/; every name the original single file exported is re-exported below,
// so existing "../box.ts" / "./box.ts" imports keep working unchanged.
export {
  boxConfigured,
  boxCredentialEnv,
  boxErrorMessage,
  inspectBoxIdentity,
  verifyToken,
} from "./box/api.ts";
export type { BoxIdentityInspection } from "./box/api.ts";
export { verifyBoxDeletionCredential } from "./box/deletion.ts";
export { boxNameFor, boxNameMatchesBot } from "./box/naming.ts";
export { listManagedBoxes } from "./box/inventory.ts";
export type {
  ManagedBoxInventory,
  ManagedBoxInventoryInstance,
  ManagedBoxOwner,
} from "./box/inventory.ts";
export {
  isolatedRemoteCommand,
  MAX_REMOTE_COMMAND_LENGTH,
  runCommand,
} from "./box/commands.ts";
export {
  boxTurnLifecycleAction,
  deleteManagedBox,
  findBox,
  joinBox,
  joinReadyBox,
  provisionBox,
  readyBox,
  sleepBox,
  sleepManagedBox,
} from "./box/lifecycle.ts";
export type { BoxTurnLifecycleAction, ManagedBoxMutationClaim } from "./box/lifecycle.ts";
export {
  boxComputerBackend,
  boxStatus,
  execOnBox,
  panelShotCommand,
  PANEL_FRAME_QUALITY,
  PANEL_FRAME_WIDTH,
  screenshotBox,
} from "./box/computer.ts";
export type { BoxComputerStatus } from "./box/computer.ts";
