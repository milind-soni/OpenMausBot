// Boot wiring for the bot box: decide and open the gates before the first turn, then prove the box once in the
// background (self-check.ts), so the Admin's report can say `bwrap, checks 23/23` rather than "on".
import { homedir } from "node:os";
import { join } from "node:path";

import { CONTROL_PLANE_ENV, WORKSPACE_CREDENTIAL_ENV } from "../config.ts";
import { BOX_BRIDGE_SCRIPT, botBox, type BotBox } from "./box.ts";
import { serverPath } from "./program-trust.ts";
import { BOX_MUTATIONS, type BoxMutation } from "./plan.ts";
import { runBoxSelfCheck } from "./self-check.ts";

export { botBox };

/** Names the box refuses in a spawn's environment whatever its prefix allows. */
export const BOX_DENY_ENV: ReadonlySet<string> = new Set([...WORKSPACE_CREDENTIAL_ENV, ...CONTROL_PLANE_ENV]);

/** For the image's CI only (.github/workflows/docker.yml): weakens the boot self-check's own fixture boxes, never a bot's,
 * so a required box shows it refuses turns when a must-pass check fails. It can only make the self-check fail. */
export const SELF_CHECK_MUTATE_ENV = "OMB_BOX_SELF_CHECK_MUTATE";

export function selfCheckMutations(env: Record<string, string | undefined> = process.env): Set<BoxMutation> | undefined {
  const named = (env[SELF_CHECK_MUTATE_ENV] ?? "").split(",").map((item) => item.trim()).filter((item): item is BoxMutation => (BOX_MUTATIONS as readonly string[]).includes(item));
  return named.length ? new Set(named) : undefined;
}

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
  // What the server starts with no PATH of its own (a plain spawn) finds nothing in HOME either.
  if (box === botBox && box.enabled()) process.env.PATH = serverPath(process.env.PATH);
  if (detection.box !== "bwrap" || !detection.tools || options.selfCheck === false) return;
  const tools = detection.tools;
  const timer = setTimeout(() => {
    runBoxSelfCheck({
      bwrap: tools.bwrap, bridge: { socat: tools.socat, bridgeScript: BOX_BRIDGE_SCRIPT, node: process.execPath },
      root: join(options.dataDir, "box"), denyEnv: BOX_DENY_ENV, seccompFile: box.seccomp(), mutate: selfCheckMutations(),
    }).then((result) => {
      if (result.error) log(`bot box: self-check could not run (${result.error})`);
      else log(`bot box: self-check ${result.passed}/${result.total}${result.failed.length ? ` (failed: ${result.failed.join(", ")})` : ""}${result.skipped.length ? ` (skipped: ${result.skipped.join(", ")})` : ""} in ${result.durationMs} ms`);
      box.noteChecks({ passed: result.passed, total: result.total, failed: result.failed, at: result.at, ...(result.error ? { error: result.error } : {}) }, log);
    }, (error) => {
      const why = error instanceof Error ? error.message : String(error);
      log(`bot box: self-check failed to run: ${why}`);
      box.noteChecks({ passed: 0, total: 0, failed: [], at: Date.now(), error: why }, log);
    });
  }, options.delayMs ?? BOX_SELF_CHECK_DELAY_MS);
  timer.unref();
}
