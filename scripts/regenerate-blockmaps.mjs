// Regenerate external electron-updater blockmaps after release artifacts have
// been stapled or rebuilt. electron-builder 26 generates blockmaps in
// app-builder-lib; the former app-builder-bin package is no longer installed.
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const electronBuilderPackage = require.resolve("electron-builder/package.json");
const requireFromElectronBuilder = createRequire(electronBuilderPackage);
const { buildBlockMap } = requireFromElectronBuilder(
  "app-builder-lib/out/targets/blockmap/blockmap.js",
);

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  throw new Error("usage: node scripts/regenerate-blockmaps.mjs <artifact> [...artifact]");
}

for (const input of inputs) {
  const artifact = resolve(input);
  await access(artifact);
  const blockmap = `${artifact}.blockmap`;
  await buildBlockMap(artifact, "gzip", blockmap);
  const { size } = await stat(blockmap);
  console.log(`blockmap: ${blockmap} (${size} bytes)`);
}
