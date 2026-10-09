const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createTrustedApprovalModeCoordinator } = require("../../electron/approval-trusted-mode.cjs");

module.exports = async ({ child, api, until, url, home, root }) => {
  const { createDesktopKey, createRemoteApprovalAuthority, signedRequest } = await import("../../electron/remote-approval-authority.mjs");
  const { createRemoteApprovalClient } = await import("../../electron/remote-approval-client.mjs");
  const keepAlive = () => {};
  require("electron").app.on("window-all-closed", keepAlive);
  const remoteOrigin = "http://mini.fixture.ts.net";
  const remoteHeaders = { host: "mini.fixture.ts.net", origin: remoteOrigin };
  // Node's fetch may replace Host. This synthetic transport deliberately
  // preserves the saved origin while connecting only to the disposable host.
  const fixtureFetch = (target, init = {}) => new Promise((resolve, reject) => {
    const req = require("node:http").request(target.replace(remoteOrigin, url), {
      method: init.method ?? "GET", headers: init.headers, signal: init.signal,
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on("error", reject); req.end(init.body);
  });
  async function pair(scopes = ["admin"]) {
    const opened = await api("/api/auth/pairing", "POST", { scopes });
    assert.equal(opened.status, 200);
    const response = await fixtureFetch(`${url}/api/auth/pair`, { method: "POST", headers: { ...remoteHeaders, "content-type": "application/json" },
      body: JSON.stringify({ code: opened.body.code, cookie: true, label: "Synthetic laptop" }) });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  let cookie = await pair();
  const ownerCookie = cookie;
  async function remote(path, method = "GET", body, overrides = {}) {
    const response = await fixtureFetch(`${url}${path}`, { method,
      headers: { ...remoteHeaders, cookie, "content-type": "application/json", ...overrides },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const identityResponse = await remote("/api/desktop-approval");
  assert.equal(identityResponse.status, 200, JSON.stringify(identityResponse.body));
  const identity = identityResponse.body;
  assert.ok(identity.epoch && identity.device && identity.workspace);
  const context = { ...identity, origin: remoteOrigin };
  let secure = {};
  let laptop = {};
  const coordinators = new Map();
  const validations = new Map();
  const phases = [];
  const authority = createRemoteApprovalAuthority({
    read: () => secure, update: async derive => { secure = derive(secure); },
    validate: context => new Promise(resolve => {
      const id = randomUUID(); validations.set(id, resolve);
      child.postMessage({ type: "remote-approval-validate", id, context });
    }),
    execute: async (ctx, claim, mode) => {
      const ids = [];
      const coordinator = createTrustedApprovalModeCoordinator({ randomId: () => {
        const id = randomUUID(); ids.push(id); coordinators.set(id, { coordinator, wrapper }); return id;
      } });
      const wrapper = { postMessage(message) {
        phases.push(message.type);
        child.postMessage({ ...message, ...(message.mode === "full" ? { remoteRequestId: ctx.requestId } : { remoteRecoveryGrantId: claim.grantId }) });
      } };
      try { return await coordinator.request(wrapper, claim.botId, mode, { threadId: claim.threadId, threadOnly: true }); }
      finally { for (const id of ids) coordinators.delete(id); }
    },
  });
  const listener = message => {
    if (message.type === "remote-approval-validated") {
      assert.equal(message.ok, true); validations.get(message.id)?.(); return;
    }
    const pending = coordinators.get(message.requestId);
    if (pending) return pending.coordinator.receive(pending.wrapper, message);
    if (message.type !== "remote-approval-request") return;
    void authority.handle(message.packet, message.context).then(
      result => child.postMessage({ type: "remote-approval-result", id: message.id, ok: true, result }),
      () => child.postMessage({ type: "remote-approval-result", id: message.id, ok: false }),
    );
  };
  child.on("message", listener);
  let confirm = true;
  let loseReply = false;
  const nativeDialogs = [];
  const client = createRemoteApprovalClient({
    read: () => laptop, update: async derive => { laptop = derive(laptop); },
    current: () => ({ origin: remoteOrigin, name: "Mac Mini — Tailscale" }),
    dialog: async options => { nativeDialogs.push(options); return { response: confirm ? 1 : 0 }; },
    fetch: async (target, init) => {
      const response = await fixtureFetch(target.replace(remoteOrigin, url), { ...init, headers: { ...init.headers, ...remoteHeaders, cookie } });
      if (loseReply && init.body && JSON.parse(init.body).claim.action === "full") {
        await response.text(); throw new Error("fixture lost commit reply");
      }
      return response;
    },
  });
  try {
    const bot = (await api("/api/bots", "POST", { name: "Remote scope", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
    const selected = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Laptop target" })).body.task;
    const sibling = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Sibling" })).body.task;
    const snapshot = async () => (await api("/api/bots?messages=0")).body.bots.find(row => row.id === bot.id);
    const mode = async () => (await snapshot()).tasks.find(row => row.threadId === selected.threadId).approvalMode;
    const defaultMode = bot.approvalMode;
    const siblingMode = sibling.approvalMode;
    for (const level of ["full", "custom"]) {
      assert.equal((await api(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "PATCH", { approvalMode: level })).status, 403);
      assert.equal((await remote(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "PATCH", { approvalMode: level })).status, 403);
    }
    assert.equal((await client.status()).available, false);
    await client.enroll();
    assert.equal((await client.status()).available, false, "enrollment request is inert");
    await authority.authorize(authority.pending()[0].id);
    assert.equal((await client.status()).available, true);
    confirm = false;
    await assert.rejects(client.setFull(bot.id, selected.threadId), /cancelled/);
    assert.equal(phases.length, 0);
    confirm = true;
    const committed = await client.setFull(bot.id, selected.threadId);
    assert.equal(committed.tasks.find(row => row.threadId === selected.threadId).approvalMode, "full");
    assert.deepEqual(phases.slice(0, 5), ["set", "confirm", "activate", "finalize", "commit"].map(phase => `approval-trusted-mode-${phase}`));
    assert.equal(committed.approvalMode, defaultMode);
    assert.equal(committed.tasks.find(row => row.threadId === sibling.threadId).approvalMode, siblingMode);
    const persisted = JSON.parse(readFileSync(join(home, "bots.json"), "utf8")).find(row => row.id === bot.id);
    assert.equal(persisted.tasks.find(row => row.threadId === selected.threadId).approvalMode, "full");
    await client.stop();
    await until(async () => await mode() === "ask");
    await authority.revoke(authority.bindings()[0].id);
    const { BrowserWindow, ipcMain } = require("electron");
    const { mountPreview } = await import("./preview-fixture.ts");
    const uiBot = (await api("/api/bots", "POST", { name: "Remote UI", modelSelection: { instanceId: "codex", model: "gpt-6-astra" } })).body.bot;
    const preview = await mountPreview({ info: { url } }, { entry: "/src/testing/thread-approvals.tsx", route: "/__remote-approvals.html", title: "Remote approval fixture", logLevel: "silent" });
    const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
      preload: join(root, "scripts/testing/remote-approval-preview-preload.cjs"), contextIsolation: true, sandbox: true,
    } });
    ipcMain.handle("fixture:remote-approval-status", () => client.status());
    ipcMain.handle("fixture:remote-approval-full", (event, id, thread) => {
      assert.equal(event.sender, window.webContents); assert.equal(id, uiBot.id);
      assert.equal(thread, uiBot.threadId); return client.setFull(id, thread);
    });
    try {
      await window.loadURL(`${preview.previewUrl}?bot=${uiBot.id}&model-switch`);
      const evaluate = js => window.webContents.executeJavaScript(js);
      await until(() => evaluate("Boolean(document.querySelector('[data-tour=composer] button[aria-haspopup=menu][aria-label*=\" for \"]'))"));
      await evaluate("document.querySelector('[data-tour=composer] button[aria-haspopup=menu][aria-label*=\" for \"]').click()");
      await until(() => evaluate("document.body.innerText.includes('Remote Full access needs one-time host authorization')"));
      const screenshot = async name => {
        if (!process.env.OMB_REMOTE_APPROVAL_SCREENSHOTS) return;
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        mkdirSync(process.env.OMB_REMOTE_APPROVAL_SCREENSHOTS, { recursive: true });
        writeFileSync(join(process.env.OMB_REMOTE_APPROVAL_SCREENSHOTS, name), (await window.webContents.capturePage()).toPNG());
      };
      assert.equal(await evaluate("[...document.querySelectorAll('[role=menuitemradio]')].some(b => b.textContent.trim().startsWith('Full access'))"), false);
      await screenshot("remote-approval-before.png");
      await client.enroll();
      await authority.authorize(authority.pending()[0].id);
      await until(() => evaluate("[...document.querySelectorAll('[role=menuitemradio]')].some(b => b.textContent.trim().startsWith('Full access'))"));
      await screenshot("remote-approval-after.png");
      assert.equal(await evaluate("Boolean(window.ogb.approvals)"), false);
      assert.equal(await evaluate("[...document.querySelectorAll('[role=menuitemradio]')].some(b => b.textContent.includes('Custom'))"), false);
      await evaluate("[...document.querySelectorAll('[role=menuitemradio]')].find(b => b.textContent.trim().startsWith('Full access')).click()");
      await until(async () => (await api("/api/bots?messages=0")).body.bots.find(row => row.id === uiBot.id).tasks.find(row => row.threadId === uiBot.threadId).approvalMode === "full");
      assert.equal(nativeDialogs.at(-1).message, "Enable Full access for this conversation?");
      console.log(JSON.stringify({ remoteComposer: true, nativeWarning: true, localBridgeAbsent: true, customHidden: true }));
    } finally {
      window.destroy(); ipcMain.removeHandler("fixture:remote-approval-status"); ipcMain.removeHandler("fixture:remote-approval-full");
      await preview.close(); await client.stop();
    }
    loseReply = true;
    await assert.rejects(client.setFull(bot.id, selected.threadId), /lost commit reply/);
    await until(async () => await mode() === "ask");
    loseReply = false;

    const wrongKey = createDesktopKey();
    const proof = signedRequest(wrongKey, { ...context, action: "status" });
    assert.equal((await remote("/api/desktop-approval", "POST", proof)).status, 403, "unenrolled device key");
    assert.equal((await remote("/api/desktop-approval", "POST", proof, { origin: "https://wrong.example" })).status, 403);
    assert.ok([401, 403].includes((await remote("/api/desktop-approval", "GET", undefined, { cookie: "", authorization: "Bearer bot-token" })).status));
    assert.ok([401, 403].includes((await remote("/api/desktop-approval", "GET", undefined, { cookie: "" })).status));
    cookie = await pair(["client"]);
    assert.equal((await remote("/api/desktop-approval")).status, 403, "chat-only cannot request enrollment");
    cookie = ownerCookie;
    await client.setFull(bot.id, selected.threadId);
    assert.equal((await api(`/api/auth/sessions/${identity.device}`, "DELETE")).status, 200);
    await until(async () => await mode() === "ask");
    assert.equal((await client.status()).available, false);
    console.log(JSON.stringify({ remoteDesktopApproval: true, savedEnvironment: "Mac Mini — Tailscale", ownerEnrollment: true,
      privateFiveSteps: true, persistedThread: true, defaultUnchanged: true, siblingUnchanged: true,
      httpFullAndCustomRejected: true, chatOnlyRejected: true, unpairedRejected: true, botTokenRejected: true,
      unenrolledKeyRejected: true, wrongOriginRejected: true, nativeCancel: true, lostReplyRecovered: true, revokedPairingRecovered: true,
      nativeDialogCallbacks: nativeDialogs.length }));
  } finally {
    await client.stop(); await authority.stop().catch(() => {}); child.off("message", listener);
    require("electron").app.off("window-all-closed", keepAlive);
  }
};
