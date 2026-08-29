import { spawn } from "node:child_process";

import { resolveCuaSmokePlan } from "./cua-smoke-plan.mjs";

function runNodeScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} failed (${signal ?? `exit ${code ?? "unknown"}`})`));
    });
  });
}

const plan = resolveCuaSmokePlan(process.platform);
await runNodeScript(plan.prepareScript);
await runNodeScript(plan.smokeScript);
