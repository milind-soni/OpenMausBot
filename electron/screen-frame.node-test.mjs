import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const localOrigin = createRequire(import.meta.url)("./local-origin.cjs");
const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const registration = source.match(/ipcMain\.handle\("screen:frame",[\s\S]*?\n\}\)\);/)?.[0];
assert.ok(registration, "production screen:frame registration exists");
const origin = "http://127.0.0.1:48993";
const from = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });

for (const platform of ["win32", "darwin", "linux"]) {
  test(`screen preview capture stays local on ${platform}`, async () => {
    let handler;
    const captures = [];
    let sources = [{ thumbnail: { toDataURL: () => "data:image/png;base64,fixture" } }];
    vm.runInNewContext(registration, {
      process: { platform },
      ipcMain: { handle: (_channel, value) => { handler = value; } },
      localOnly: localOrigin.localOnly,
      desktopCapturer: { getSources: async (options) => { captures.push(options); return sources; } },
    });
    localOrigin.setLocalOrigin(origin);
    assert.throws(() => handler(from("https://remote.example.test")), /only available while using the local server/);
    assert.equal(captures.length, 0);
    assert.equal(await handler(from(origin)), platform === "linux" ? null : "data:image/png;base64,fixture");
    assert.equal(captures.length, platform === "linux" ? 0 : 1);
    if (captures.length) assert.deepEqual(JSON.parse(JSON.stringify(captures[0])), {
      types: ["screen"], thumbnailSize: { width: 1280, height: 800 },
    });
    sources = [];
    assert.equal(await handler(from(origin)), null);
  });
}
