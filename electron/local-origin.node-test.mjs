import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lo = require("./local-origin.cjs");

const from = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });

test("nothing is local until the origin is known, then only that origin is", () => {
  lo.setLocalOrigin(null);
  assert.equal(lo.isLocalSender(from("http://127.0.0.1:8799/")), false);
  lo.setLocalOrigin("http://127.0.0.1:8799");
  assert.equal(lo.isLocalSender(from("http://127.0.0.1:8799/chat?x=1")), true);
  assert.equal(lo.isLocalSender(from("https://mini.example/")), false);
  assert.equal(lo.isLocalSender(from("http://127.0.0.1:8800/")), false);
  assert.equal(lo.isLocalSender(from("about:blank")), false);
  assert.equal(lo.isLocalSender({ sender: { getURL: () => "http://127.0.0.1:8799/" } }), true);
  assert.equal(lo.isLocalSender({}), false);
});

test("a local native main frame remains local while its frame URL is briefly empty", () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const mainFrame = { url: "" };
  const event = {
    senderFrame: mainFrame,
    sender: {
      mainFrame,
      getURL: () => "http://127.0.0.1:8799/?desktop-settings=organization",
    },
  };
  assert.equal(lo.senderOrigin(event), "http://127.0.0.1:8799");
  assert.equal(lo.isLocalSender(event), true);
});

test("an empty child frame never inherits the native main frame's local origin", () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const event = {
    senderFrame: { url: "" },
    sender: {
      mainFrame: { url: "http://127.0.0.1:8799/" },
      getURL: () => "http://127.0.0.1:8799/",
    },
  };
  assert.equal(lo.senderOrigin(event), null);
  assert.equal(lo.isLocalSender(event), false);
});

test("localOnly answers the local page and refuses a remote one by name", async () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const handler = lo.localOnly("screen:frame", async (_event, x) => `frame:${x}`);
  assert.equal(await handler(from("http://127.0.0.1:8799/"), 1), "frame:1");
  assert.throws(() => handler(from("https://mini.example/"), 1), /screen:frame is only available while using the local server/);
  const sync = lo.localOnlySync("screen:preview-intent", (event) => { event.returnValue = "ok"; });
  const remote = from("https://mini.example/");
  sync(remote);
  assert.equal(remote.returnValue, false);
  const local = from("http://127.0.0.1:8799/");
  sync(local);
  assert.equal(local.returnValue, "ok");

  const openExternal = lo.localOnly("desktop:open-external", async (_event, url) => `opened:${url}`);
  assert.equal(await openExternal(local, "https://example.com"), "opened:https://example.com");
  assert.throws(
    () => openExternal(remote, "https://example.com"),
    /desktop:open-external is only available while using the local server/,
  );
});
