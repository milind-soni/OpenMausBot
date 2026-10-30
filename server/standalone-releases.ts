// Every AI build the app can install itself. Only these are put on PATH at start-up: a folder under tools/standalone
// that no release here names is never trusted.
import type { StandaloneRelease } from "./contracts.ts";
import { OPENCODE_STANDALONE } from "./drivers/acp/opencode-release.ts";

export const STANDALONE_RELEASES: readonly StandaloneRelease[] = [OPENCODE_STANDALONE];
