// Mark a built output directory as an ES module scope. Packaged trees sit
// outside app.asar, so Node would take their format from the nearest
// package.json above the install folder, which a stray `npm init -y` (npm 11
// writes "type": "commonjs") turns into a SyntaxError at startup.
//
//   node scripts/mark-module-scope.mjs dist-companion
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: node scripts/mark-module-scope.mjs <dir>...");
  process.exit(1);
}
for (const dir of dirs) writeFileSync(join(resolve(dir), "package.json"), '{"type":"module"}\n');
