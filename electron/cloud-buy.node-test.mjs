import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { inflateSync } from "node:zlib";
import { CLOUD_COLORS, CLOUD_COLOR_HEX, cleanCloudColor, cleanCloudName, cloudLinkOpensSheet, colorDotIcons, createCloudLook, createCloudReadyNotice,
  installCloudBuy, lookFile } from "./cloud-buy.mjs";
import { colorDotPng } from "./color-dot.mjs";
import environments from "./environments.cjs";

const origin = "https://omb-u-1a2b3c4d5e6f.fly.dev";

test("a Cloud's name is up to 28 characters of plain text, and its colour one of six names", () => {
  assert.equal(cleanCloudName("  Studio   cloud "), "Studio cloud");
  assert.equal(cleanCloudName("é".repeat(28)), "é".repeat(28));
  for (const bad of ["", "   ", "x".repeat(29), "nul\u0000here", "bell\u0007", 42, null]) assert.equal(cleanCloudName(bad), null, JSON.stringify(bad));
  assert.equal(cleanCloudName("tab\there\nnext"), "tab here next", "white space is one space");
  assert.deepEqual([...CLOUD_COLORS], ["blue", "teal", "purple", "orange", "red", "yellow"]);
  assert.deepEqual(CLOUD_COLORS, environments.ENTRY_COLORS, "one list for the saved entry and the sheet");
  for (const bad of ["#ff0000", "Blue", "green", "", null, "url(x)"]) assert.equal(cleanCloudColor(bad), null, String(bad));
  assert.equal(cleanCloudColor("teal"), "teal");
});

/** The PNG's own reading: its chunks' checksums, its size and its straight RGBA pixels. */
function readPng(url) {
  const png = Buffer.from(url.replace(/^data:image\/png;base64,/, ""), "base64");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8, header = null; const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8), body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9] };
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(data)), stride = header.width * 4 + 1;
  return { header, pixel: (x, y) => [...rows.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)] };
}

test("the native menu's dot is a filled circle drawn as a PNG (straight RGBA), once per colour, at 1x and 2x", () => {
  const { header, pixel } = readPng(colorDotPng("#377FE6", 28));
  assert.deepEqual(header, { width: 28, height: 28, depth: 8, colour: 6 });
  assert.deepEqual(pixel(14, 14), [0x37, 0x7f, 0xe6, 255], "red, green, blue, alpha");
  assert.equal(pixel(0, 0)[3], 0);
  const edge = pixel(14, 3)[3];
  assert.ok(edge > 0 && edge < 255, "a soft edge");
  const made = [];
  const iconFor = colorDotIcons({ createEmpty: () => ({ reps: [], addRepresentation(options) { this.reps.push(options); made.push(options); }, isEmpty() { return this.reps.length === 0; } }) });
  assert.equal(iconFor("teal"), iconFor("teal"));
  assert.deepEqual(made.map(rep => [rep.scaleFactor, readPng(rep.dataURL).header.width]), [[1, 14], [2, 28]]);
  assert.deepEqual(readPng(made[1].dataURL).pixel(14, 14), [0x01, 0xa4, 0x92, 255], "teal");
  assert.equal(iconFor("#ff0000"), null);
  assert.equal(colorDotIcons({ createEmpty: () => { throw new Error("no"); } })("red"), null, "a dot that cannot be drawn is no dot");
  assert.equal(colorDotIcons({ createEmpty: () => ({ addRepresentation() {}, isEmpty: () => true }) })("red"), null);
  for (const color of CLOUD_COLORS) assert.match(CLOUD_COLOR_HEX[color], /^#[0-9A-F]{6}$/i);
  const state = { environments: [{ id: "c", kind: "remote", name: "Studio", origin, color: "teal" }, { id: "o", kind: "remote", name: "Office", origin: "https://office.example" }], activeId: "local" };
  const items = environments.workspaceMenuTemplate(state, { onSwitch() {}, onConnect() {}, onForget() {}, iconFor });
  assert.equal(items.find(item => item.id === "workspace-c").icon, iconFor("teal"));
  assert.equal("icon" in items.find(item => item.id === "workspace-o"), false);
  assert.equal("icon" in environments.workspaceMenuTemplate(state, { onSwitch() {}, onConnect() {}, onForget() {} }).find(item => item.id === "workspace-c"), false);
});

test("the name and colour chosen while setting up are kept for that account until the Cloud is listed, then its entry is the one answer", () => {
  const files = new Map(), fs = { readFileSync: path => { if (!files.has(path)) throw new Error("ENOENT"); return files.get(path); }, writeFileSync: (path, data, options) => { assert.equal(options.mode, 0o600); files.set(path, data); } };
  let account = "acct-1", entry = null;
  const saved = [];
  const look = createCloudLook({ store: lookFile(() => "/user/cloud-home-look.json", fs), accountId: () => account, homeEntry: () => entry, saveEntry: (at, value) => saved.push([at, value]) });
  assert.deepEqual(look.current(), { name: "My Cloud", color: "blue" }); assert.equal(look.pending(), null);
  assert.deepEqual(look.save("  Studio ", "teal"), { name: "Studio", color: "teal" });
  assert.deepEqual(JSON.parse(files.get("/user/cloud-home-look.json")), { accountId: "acct-1", name: "Studio", color: "teal" });
  assert.deepEqual(look.pending(), { name: "Studio", color: "teal" });
  for (const [name, color] of [["", "teal"], ["x".repeat(29), "teal"], ["Studio", "#00ff00"]]) assert.throws(() => look.save(name, color), /up to 28 characters/);
  const again = createCloudLook({ store: lookFile(() => "/user/cloud-home-look.json", fs), accountId: () => account, homeEntry: () => entry, saveEntry: () => {} });
  assert.deepEqual(again.pending(), { name: "Studio", color: "teal" }, "read back after a restart");
  account = "acct-2"; assert.equal(look.pending(), null, "another account's choice is not this one's");
  account = "acct-1"; entry = { origin, name: "Studio", color: "teal" };
  assert.deepEqual(look.save("Studio two", "red"), { name: "Studio", color: "teal" });
  assert.deepEqual(saved, [[origin, { name: "Studio two", color: "red" }]], "a listed Cloud's entry is changed in place");
  entry = { origin, name: "Old name" };
  assert.deepEqual(look.current(), { name: "Old name", color: "blue" });
  files.set("/user/broken.json", "{not json");
  assert.equal(lookFile(() => "/user/broken.json", fs).read(), null);
  files.set("/user/forged.json", JSON.stringify({ accountId: "acct-1", name: "<img>", color: "javascript:" }));
  assert.equal(lookFile(() => "/user/forged.json", fs).read(), null);
});

test("{name} is ready once per checkout from here: not while the sheet is open in the focused window, which opens it itself", () => {
  const shown = [], opened = [];
  let focused = true, sheet = true;
  class Note { constructor(options) { this.options = options; } on(_event, listener) { this.click = listener; } show() { shown.push(this); } static isSupported() { return true; } }
  const ended = [];
  const announce = createCloudReadyNotice({ Notification: Note, focused: () => focused, sheetOpen: () => sheet, name: () => "Studio", open: () => opened.push(1), shown: () => ended.push(1) });
  const ready = startedAt => ({ status: "connected", checkout: { plan: "pro", startedAt }, machine: { status: "ready", origin } });
  assert.equal(announce({ status: "connected", machine: { status: "ready", origin } }), false, "a Cloud bought elsewhere: nothing");
  assert.equal(announce({ ...ready(1), machine: { status: "provisioning" } }), false);
  assert.equal(announce(ready(1)), false, "the sheet is open and in front: it counts down and opens it");
  assert.equal(announce(ready(1)), false, "once per checkout");
  focused = false;
  assert.equal(announce(ready(2)), true);
  assert.equal(shown[0].options.title, "Studio is ready");
  shown[0].click(); assert.deepEqual(opened, [1], "a click opens the Cloud");
  assert.deepEqual(ended, [1], "announced: main marks the purchase done");
  focused = true; sheet = false;
  assert.equal(announce(ready(3)), true, "focused but the sheet is closed: told");
  Note.isSupported = () => false;
  assert.equal(announce(ready(4)), false);
  Note.isSupported = () => true; focused = false;
  const paid = (machine) => ({ status: "connected", entitlement: { plan: "pro", status: "active" }, ...(machine ? { machine } : {}) });
  const watched = createCloudReadyNotice({ Notification: Note, focused: () => false, sheetOpen: () => false, name: () => "Lab", open: () => {} });
  assert.equal(watched(paid({ status: "ready", origin })), false, "a ready Cloud this app never saw being set up: nothing");
  assert.equal(watched(paid(null)), false); assert.equal(watched(paid({ status: "provisioning" })), false);
  assert.equal(watched(paid({ status: "ready", origin })), true, "set up while this app watched (bought elsewhere, or restarted): told");
  assert.equal(shown.at(-1).options.title, "Lab is ready");
  assert.equal(watched(paid({ status: "ready", origin })), false, "once");
});

test("openmausbot://cloud shows the sheet while a purchase from here is under way, whether or not its checkout is still watched", () => {
  assert.equal(cloudLinkOpensSheet({ status: "connected", checkout: { plan: "pro", startedAt: 1 } }), true);
  assert.equal(cloudLinkOpensSheet({ status: "connected", purchase: { state: "confirming" } }), true);
  assert.equal(cloudLinkOpensSheet({ status: "connected", machine: { status: "provisioning" } }), true);
  assert.equal(cloudLinkOpensSheet({ status: "connecting", checkout: { plan: "pro", startedAt: 1, signIn: true } }), true);
  assert.equal(cloudLinkOpensSheet({ status: "connected", checkout: { plan: "pro", startedAt: 1, done: true }, machine: { status: "ready", origin } }), false,
    "a purchase that is over: Settings, which opens the Cloud");
  for (const state of [null, undefined, { status: "signed-out" }, { status: "connected", machine: { status: "ready", origin } }]) assert.equal(cloudLinkOpensSheet(state), false, JSON.stringify(state));
});

function installed({ link = null, offered = true } = {}) {
  const handlers = new Map(), calls = [], clipboard = [], guarded = [];
  const client = {
    emailStart: async (...args) => { calls.push(["emailStart", ...args]); return { outcome: "sent" }; },
    emailVerify: async (...args) => { calls.push(["emailVerify", ...args]); return { outcome: "wrong-code", triesLeft: 4 }; },
    emailCancel: () => calls.push(["emailCancel"]),
    checkoutDone: () => calls.push(["checkoutDone"]),
    reopenCheckout: async (...args) => { calls.push(["reopenCheckout", ...args]); return { outcome: "opened", state: { status: "connected" } }; },
    checkoutLink: () => link,
    offer: async () => { calls.push(["offer"]); return { plans: [{ tier: "pro", amount: 4900 }], recommended: "pro" }; },
    interest: async (...args) => { calls.push(["interest", ...args]); },
  };
  const look = { current: () => ({ name: "My Cloud", color: "blue" }), save: (...args) => { calls.push(["save", ...args]); return { name: args[0], color: args[1] }; } };
  const buy = installCloudBuy({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    guard: (channel, handler) => (...args) => { guarded.push(channel); return handler(...args); }, client: () => client, offersReady: async () => offered,
    clipboard: { writeText: text => clipboard.push(text) }, look });
  return { handlers, calls, clipboard, guarded, buy };
}

test("each sheet channel is behind main's guard, takes only text, and never answers with the checkout page or a token", async () => {
  const h = installed({ link: "https://checkout.dodopayments.com/session/cks_1" });
  const call = (method, ...args) => h.handlers.get(`cloud-account:${method}`)({}, ...args);
  assert.deepEqual([...h.handlers.keys()].sort(), ["copyCheckoutLink", "interest", "look", "readySeen", "reopenCheckout", "setLook", "sheet", "signInCancel", "signInStart", "signInVerify"].map(method => `cloud-account:${method}`).sort());
  await call("readySeen", "anything"); assert.deepEqual(h.calls.splice(-1), [["checkoutDone"]], "the sheet showed ready: the purchase is over");
  await call("signInStart", { email: "x" }); await call("signInStart", "person@example.test");
  await call("signInVerify", 48201937); await call("signInVerify", "48201937");
  await call("signInCancel", "anything");
  assert.equal(await call("copyCheckoutLink", "https://evil.example.test"), true, "copied, and only yes or no comes back");
  assert.deepEqual(h.clipboard, ["https://checkout.dodopayments.com/session/cks_1"]);
  assert.deepEqual(await call("reopenCheckout", "team", "elsewhere"), { outcome: "opened", state: { status: "connected" } });
  await call("interest", "another_cloud", "extra"); await call("setLook", { name: "x" }, "teal"); await call("setLook", "Studio", "teal");
  assert.equal(h.buy.sheetOpen(), false); await call("sheet", "yes"); assert.equal(h.buy.sheetOpen(), false); await call("sheet", true); assert.equal(h.buy.sheetOpen(), true);
  const listeners = new Map(), page = { on: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]) };
  const sheet = open => h.handlers.get("cloud-account:sheet")({ sender: page }, open);
  await sheet(true); await sheet(false); await sheet(true);
  assert.deepEqual([...listeners.keys()], ["did-navigate", "destroyed"]); assert.equal(listeners.get("did-navigate").length, 1, "watched once per page");
  listeners.get("did-navigate")[0](); assert.equal(h.buy.sheetOpen(), false, "the page went elsewhere: the sheet is closed");
  await sheet(true); listeners.get("destroyed")[0](); assert.equal(h.buy.sheetOpen(), false);
  assert.deepEqual(h.calls, [["emailStart", ""], ["emailStart", "person@example.test"], ["emailVerify", ""], ["emailVerify", "48201937"], ["emailCancel"],
    ["reopenCheckout"], ["interest", "another_cloud"], ["save", "", "teal"], ["save", "Studio", "teal"]], "a kept page is reopened as it is: the page's plan is never asked about");
  assert.equal(h.guarded.length, 17, "every call went through the guard");
  const none = installed();
  const reopen = (...args) => none.handlers.get("cloud-account:reopenCheckout")({}, ...args);
  for (const [plan, source] of [["team", "app_menu"], ["pro", "site"], [{ tier: "pro" }, "app_menu"]]) await assert.rejects(reopen(plan, source), /Choose a plan/);
  await reopen("pro", "app_card");
  assert.deepEqual(none.calls.filter(row => row[0] === "reopenCheckout"), [["reopenCheckout", "pro", "app_card"]]);
  assert.equal(await none.handlers.get("cloud-account:copyCheckoutLink")({}), false); assert.deepEqual(none.clipboard, []);
  await assert.rejects(installed({ offered: false }).handlers.get("cloud-account:reopenCheckout")({}, "pro", "app_card"), /isn't offered/);
});

test("the page's bridge sends the sheet's words as text only, and exists only on this computer's own page", async () => {
  const local = "http://127.0.0.1:48993";
  const load = ({ remote = false } = {}) => {
    let bridge; const invoked = [];
    vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
      process: { platform: "fixture", argv: [`--omb-local-origin=${local}`, "--omb-company-desktop=1"] },
      location: { origin: remote ? "https://remote.example.test" : local }, TextEncoder, localStorage: { getItem: () => null },
      require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve(null); } } }),
    });
    return { bridge, invoked };
  };
  const f = load(), cloud = f.bridge.cloudAccount;
  await cloud.signInStart({ toString: () => "person@example.test" }); await cloud.signInVerify(48201937); await cloud.signInCancel({ token: "forged" });
  await cloud.reopenCheckout("pro", undefined); await cloud.copyCheckoutLink("https://evil.example.test"); await cloud.interest("x");
  await cloud.look({ origin }); await cloud.setLook("Studio", { color: "teal" }); await cloud.sheet("yes"); await cloud.sheet(true); await cloud.readySeen("x");
  assert.deepEqual(f.invoked, [["cloud-account:signInStart", "person@example.test"], ["cloud-account:signInVerify", "48201937"], ["cloud-account:signInCancel"],
    ["cloud-account:reopenCheckout", "pro", "undefined"], ["cloud-account:copyCheckoutLink"], ["cloud-account:interest"], ["cloud-account:look"],
    ["cloud-account:setLook", "Studio", "[object Object]"], ["cloud-account:sheet", false], ["cloud-account:sheet", true], ["cloud-account:readySeen"]]);
  assert.equal(load({ remote: true }).bridge.cloudAccount, undefined);
});
