// `node dist-server/bot-box/box-check.js [--mutate=bind-data,share-pid] [--public=host:port|none] [--root=DIR]`
// Runs the box self-check (self-check.ts) on this machine and prints its JSON: what the Admin's `checks: n/n` counts,
// runnable by hand on a Cloud home or a test machine, with mutations to prove each check has teeth.
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defaultCodeRoots, writeSeccompFile } from "./box.ts";
import { detectBox } from "./detect.ts";
import { BOX_MUTATIONS, type BoxMutation } from "./plan.ts";
import { runBoxSelfCheck } from "./self-check.ts";

export const CHECK_DENY_ENV: ReadonlySet<string> = new Set(["COMPOSIO_API_KEY", "OMB_COMPOSIO_BROKER_TOKEN", "OMB_HIGHLEVEL_TOKEN"]);

export async function boxCheckMain(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const mutate = new Set<BoxMutation>();
  let publicTarget: string | null | undefined;
  let root = env.OMB_DATA_DIR ? join(env.OMB_DATA_DIR, "box") : join(tmpdir(), "omb-box-check");
  for (const arg of argv) {
    const [name, value = ""] = arg.split("=", 2) as [string, string?];
    if (name === "--mutate") for (const item of value.split(",").filter(Boolean)) {
      if (!BOX_MUTATIONS.includes(item as BoxMutation)) throw new Error(`unknown mutation ${item}; one of ${BOX_MUTATIONS.join(", ")}`);
      mutate.add(item as BoxMutation);
    } else if (name === "--public") publicTarget = value === "none" ? null : value;
    else if (name === "--root") root = value;
    else throw new Error(`unknown argument ${arg}`);
  }
  const detection = detectBox({ env: { ...env, OMB_BOT_BOX: env.OMB_BOT_BOX ?? "1" } });
  if (detection.box !== "bwrap" || !detection.tools) {
    process.stdout.write(`${JSON.stringify({ box: detection.box, reason: detection.reason })}\n`);
    return 2;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // This entry is bundled into its own file beside the bridge and the probe, so they are found next to it, not through
  // the server root the inlined proxy-paths would compute from here.
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = (name: string) => existsSync(join(here, `${name}.ts`)) ? join(here, `${name}.ts`) : join(here, `${name}.js`);
  const result = await runBoxSelfCheck({
    bwrap: detection.tools.bwrap, bridge: { socat: detection.tools.socat, bridgeScript: sibling("box-bridge"), node: process.execPath },
    probeScript: sibling("box-probe"), codeRoots: [dirname(dirname(here)), ...defaultCodeRoots()],
    root, denyEnv: CHECK_DENY_ENV, mutate, publicTarget, seccompFile: writeSeccompFile(root),
  });
  process.stdout.write(`${JSON.stringify({ box: detection.box, bridge: detection.tools.socat ? "socat" : "node", mutate: [...mutate], ...result })}\n`);
  return result.error || result.failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  boxCheckMain(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
