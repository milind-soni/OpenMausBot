import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { serverLocalePlugin } from './server-locale-plugin.mjs';

export async function buildNativeBrowserSmoke(output) {
  if (!output) throw Error('Choose an output path in a disposable smoke directory.');
  await build({
  entryPoints: [fileURLToPath(new URL('../electron/testing/native-browser-worker.mjs', import.meta.url))],
  outfile: resolve(output), bundle: true, platform: 'node', target: 'node24', format: 'esm',
  banner: { js: 'import { createRequire as __smokeRequire } from "node:module"; const require = __smokeRequire(import.meta.url);' },
  plugins: [serverLocalePlugin], logLevel: 'warning',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNativeBrowserSmoke(process.argv[2]);
