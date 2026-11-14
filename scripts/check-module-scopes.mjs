// Release gate: every tree Node runs from Resources/, outside
// app.asar, must declare its own module format. Without that, a package.json
// above the install folder decides how its .js files are read (npm 11's
// `npm init -y` writes "type": "commonjs"), and every `import` becomes a
// SyntaxError at startup.
//
//   node scripts/check-module-scopes.mjs <Resources dir>
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TREES = ["server", "companion"];
const resources = resolve(process.argv[2] ?? "");
const stage = mkdtempSync(join(tmpdir(), "omb-module-scope-"));
let bad = 0;
try {
  // The hostile parent: what a stray `npm init -y` leaves in a home folder.
  writeFileSync(join(stage, "package.json"), '{"type":"commonjs"}\n');
  for (const tree of TREES) {
    let type;
    try {
      type = JSON.parse(readFileSync(join(resources, tree, "package.json"), "utf8")).type;
    } catch {}
    if (type !== "module") {
      console.error(`::error::${tree}/package.json must say "type": "module" (found ${type ?? "no file"})`);
      bad++;
      continue;
    }
    cpSync(join(resources, tree), join(stage, tree), { recursive: true });
    // Parse, never run, each top-level .js file beneath the CommonJS parent.
    for (const name of readdirSync(join(stage, tree)).filter((n) => n.endsWith(".js"))) {
      try {
        execFileSync(process.execPath, ["--check", join(stage, tree, name)], { stdio: "pipe" });
      } catch (error) {
        console.error(`::error::${tree}/${name} does not parse beneath a CommonJS parent\n${error.stderr}`);
        bad++;
      }
    }
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
if (bad) process.exit(1);
console.log(`ok: ${TREES.join(" and ")} keep their ES module format beneath a CommonJS parent`);
