// Boot wiring for the bot box: decide and open the gates before the first turn, then prove the box once in the
// background (self-check.ts), so the Admin's report can say `bwrap, checks 23/23` rather than "on".
import { homedir } from "node:os";
import { join } from "node:path";

import { CONTROL_PLANE_ENV, WORKSPACE_CREDENTIAL_ENV } from "../config.ts";
import { BOX_BRIDGE_SCRIPT, botBox, type BotBox } from "./box.ts";
import { runBoxSelfCheck } from "./self-check.ts";

export { botBox };

/** Names the box refuses in a spawn's environment whatever its prefix allows. */
export const BOX_DENY_ENV: ReadonlySet<string> = new Set([...WORKSPACE_CREDENTIAL_ENV, ...CONTROL_PLANE_ENV]);

/** The boot self-check waits this long, so it never competes with the first requests. */
export const BOX_SELF_CHECK_DELAY_MS = 5_000;

export async function startBotBoxAtBoot(options: {
  dataDir: string;
  port: number;
  home?: string;
  log?: (line: string) => void;
  box?: BotBox;
  /** Off in tests that only want the gates. */
  selfCheck?: boolean;
  delayMs?: number;
}): Promise<void> {
  const box = options.box ?? botBox;
  const log = options.log ?? ((line: string) => console.log(line));
  const detection = await box.start({ dataDir: options.dataDir, home: options.home ?? homedir(), port: options.port, denyEnv: BOX_DENY_ENV, log });
  if (detection.box !== "bwrap" || !detection.tools || options.selfCheck === false) return;
  const tools = detection.tools;
  const timer = setTimeout(() => {
    runBoxSelfCheck({
      bwrap: tools.bwrap, bridge: { socat: tools.socat, bridgeScript: BOX_BRIDGE_SCRIPT, node: process.execPath },
      root: join(options.dataDir, "box"), denyEnv: BOX_DENY_ENV, seccompFile: box.seccomp(),
    }).then((result) => {
      box.noteChecks({ passed: result.passed, total: result.total, failed: result.failed, at: result.at });
      if (result.error) log(`bot box: self-check could not run (${result.error})`);
      else log(`bot box: self-check ${result.passed}/${result.total}${result.failed.length ? ` (failed: ${result.failed.join(", ")})` : ""}${result.skipped.length ? ` (skipped: ${result.skipped.join(", ")})` : ""} in ${result.durationMs} ms`);
    }, (error) => log(`bot box: self-check failed to run: ${error instanceof Error ? error.message : String(error)}`));
  }, options.delayMs ?? BOX_SELF_CHECK_DELAY_MS);
  timer.unref();
}
