import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { bwrapArgs, physicalPath, under, type BoxPlan } from "./plan.ts";
import { closeMountFds } from "./pin.ts";

interface LaunchSpec {
  bwrap: string;
  plan: BoxPlan;
  seccomp: string | null;
  dataDir: { path: string; physical: string };
}

const spec: LaunchSpec = JSON.parse(process.argv[2]!);
const profile = process.argv[3];
const plan = spec.plan;
if (profile) {
  const target = resolve(profile), source = physicalPath(target);
  const dataDir = spec.dataDir.physical;
  const approved = under(target, resolve(spec.dataDir.path)) ? join(dataDir, relative(resolve(spec.dataDir.path), target)) : target;
  if (under(dataDir, source) || (under(source, dataDir) && !under(source, approved))) {
    throw new Error("The browser profile aliases protected bot box data.");
  }
  plan.mounts.push({ kind: "bind", source, target });
}
const fds: number[] = [];
try {
  if (spec.seccomp) {
    fds.push(openSync(spec.seccomp, "r"));
    plan.options[plan.options.indexOf("--seccomp") + 1] = "3";
  }
  const child = spawn(spec.bwrap, [...bwrapArgs(plan, fds), "--setenv", "HOME", "/tmp", "--", ...process.argv.slice(5)], {
    stdio: ["inherit", "inherit", "inherit", ...fds],
  });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 70; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
  process.on("SIGTERM", () => { child.kill("SIGTERM"); });
  process.on("SIGINT", () => { child.kill("SIGINT"); });
} finally { closeMountFds(fds); }
