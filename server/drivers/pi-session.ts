import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";

/** Persist turn sessions under the OpenMausBot data dir, not the operator's ~/.pi/agent/sessions. */
export function piSessionDir(): string {
  return join(DATA_DIR, "pi-sessions");
}

export function piTurnArgs(): string[] {
  const dir = piSessionDir();
  mkdirSync(dir, { recursive: true });
  return ["--mode", "rpc", "--session-dir", dir];
}
