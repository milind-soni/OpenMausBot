// The single shared status memo for screenshot polling, in its own module
// because lifecycle actions invalidate it (./lifecycle.ts) while the frame
// path reads and refreshes it (./frame.ts). One module-level instance keeps
// the original single-file semantics.

import type { ContainerComputerStatus } from "./status.ts";

export const SCREENSHOT_STATUS_TTL_MS = 10_000;

export const screenshotStatusCache = new Map<
  string,
  { status: ContainerComputerStatus; expiresAt: number }
>();
