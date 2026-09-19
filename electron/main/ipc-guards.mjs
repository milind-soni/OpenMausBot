// Extracted from electron/main.mjs: the local-origin IPC guard that wraps
// privileged handlers (electron/local-origin.cjs remains the implementation).
// The company-backup subsystem module registers its channels at
// module-evaluation time and cannot import the guard from main.mjs itself —
// that edge would be circular and temporal-dead-zone broken — so the shared
// binding lives here, one hop from both. main.mjs imports localOnly from
// this module and keeps every call site unchanged.
import localOriginModule from "../local-origin.cjs";

const { localOnly } = localOriginModule;
export { localOnly };
