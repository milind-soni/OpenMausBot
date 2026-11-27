// Measures the size and SHA-256 of Chrome for Testing downloads for server/browser/chrome/install.ts. It downloads each
// archive in full (about 200 MB per platform) through the installer's own downloader.
// Usage: node --experimental-strip-types scripts/pin-chrome-for-testing.ts [--version V] [--keep DIR] mac-arm64 [win64 …]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CHROME_FOR_TESTING_VERSION, chromeForTestingUrl, downloadArchive } from "../server/browser/chrome/install.ts";

const NODE_TARGETS: Record<string, string> = { "mac-arm64": "darwin-arm64", "mac-x64": "darwin-x64", win64: "win32-x64", linux64: "linux-x64", "linux-arm64": "linux-arm64" };
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { version: { type: "string", default: CHROME_FOR_TESTING_VERSION }, keep: { type: "string" } },
});
if (!positionals.length || positionals.some((platform) => !NODE_TARGETS[platform])) throw new Error(`name one or more Chrome for Testing platforms: ${Object.keys(NODE_TARGETS).join(", ")}`);
const folder = values.keep ? resolve(values.keep) : mkdtempSync(join(tmpdir(), "omb-cft-pin-"));
mkdirSync(folder, { recursive: true });
try {
  for (const platform of positionals) {
    const url = chromeForTestingUrl({ version: values.version!, platform });
    const head = await fetch(url, { method: "HEAD" });
    const bytes = Number(head.headers.get("content-length"));
    if (!head.ok || !Number.isSafeInteger(bytes)) throw new Error(`${url}: HTTP ${head.status}`);
    let shown = 0;
    const sha256 = await downloadArchive(url, join(folder, `chrome-${platform}.zip`), bytes, {
      onProgress: ({ received }) => {
        if (received - shown < 20 * 1024 * 1024 && received !== bytes) return;
        shown = received;
        process.stderr.write(`${platform}: ${Math.round(received / 1048576)} of ${Math.round(bytes / 1048576)} MB\n`);
      },
    });
    console.log(`  "${NODE_TARGETS[platform]}": { platform: "${platform}", bytes: ${bytes}, sha256: "${sha256}" },`);
  }
} finally {
  if (!values.keep) rmSync(folder, { recursive: true, force: true });
}
