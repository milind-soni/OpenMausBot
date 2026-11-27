import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const electronDirectory = fileURLToPath(new URL("../electron/", import.meta.url));
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const modules = readdirSync(electronDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:cjs|mjs)$/.test(entry.name))
  .map((entry) => path.join(electronDirectory, entry.name))
  .sort();

if (modules.length === 0) throw new Error("No Electron modules were found to syntax-check");
for (const modulePath of modules) {
  execFileSync(electronExecutable, ["--check", modulePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
}

console.log(`Syntax-checked ${modules.length} Electron modules.`);
