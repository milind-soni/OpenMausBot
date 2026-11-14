// The electron-builder step of `pnpm package:win`. Without signing secrets in the
// environment this runs `electron-builder --win --publish never`, exactly the
// command the script ran before signing existed. With them it builds the same
// configuration with scripts/windows-signing.mjs's signing overlay merged over
// electron-builder.yml (electron-builder's own merge, as for `-c.` overrides).
import { spawnSync } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { electronBuilderOverlay, windowsSigningPlan } from "./windows-signing.mjs";

export const UNSIGNED_ARGS = Object.freeze(["--win", "--publish", "never"]);

/** How electron-builder is invoked for a plan: the unchanged CLI, or the API with an overlay. */
export function invocation(plan) {
  const overlay = electronBuilderOverlay(plan);
  return overlay ? { kind: "api", options: { win: [], publish: "never", config: overlay } } : { kind: "cli", args: [...UNSIGNED_ARGS] };
}

async function main() {
  const plan = windowsSigningPlan();
  // The release workflow's later gates key off this output.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `signing=${plan.mode}\n`);
  const run = invocation(plan);
  const require = createRequire(import.meta.url);
  if (run.kind === "cli") {
    const result = spawnSync(process.execPath, [require.resolve("electron-builder/cli.js"), ...run.args], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  console.log(`Signing Windows artifacts as ${plan.publisherName} (${plan.provider}); `
    + `updates ${plan.verifyUpdates ? "verify" : "do not yet verify"} the publisher.`);
  rmSync(new URL("../release/windows-signing-log.jsonl", import.meta.url), { force: true });
  const { build } = require("electron-builder");
  await build(run.options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
