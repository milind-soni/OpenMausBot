import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  createDesktopWorkspaceManager,
  desktopWorkspaceUrl,
  normalizeDesktopWorkspaceBounds,
} = require("./desktop-workspace.cjs");

test("workspace URLs stay loopback and force the requested noVNC input mode", () => {
  const watch = desktopWorkspaceUrl(
    "http://127.0.0.1:6080/vnc.html#autoconnect=true&resize=scale&password=secret123",
  );
  assert.equal(watch.hostname, "127.0.0.1");
  assert.equal(watch.hash.includes("autoconnect=true"), true);
  assert.equal(watch.hash.includes("resize=scale"), true);
  assert.equal(watch.hash.includes("password=secret123"), true);
  assert.equal(watch.hash.includes("view_only=true"), true);

  const interactive = desktopWorkspaceUrl(watch.toString(), true);
  assert.equal(interactive.hash.includes("view_only=false"), true);
  assert.equal(interactive.hash.includes("view_only=true"), false);
  assert.doesNotThrow(() => desktopWorkspaceUrl("https://localhost:6080/vnc.html"));
  assert.doesNotThrow(() => desktopWorkspaceUrl("http://[::1]:6080/vnc.html"));
  assert.throws(() => desktopWorkspaceUrl("https://desktop.example/vnc.html"), /loopback/);
});

test("workspace URL errors never echo a secret-bearing input", () => {
  const secret = "never-print-this";
  assert.throws(
    () => desktopWorkspaceUrl(`https://desktop.example/vnc.html#password=${secret}`),
    (error) => error instanceof Error && !error.message.includes(secret),
  );
});

test("workspace bounds reject malformed values and clamp to owner content", () => {
  assert.deepEqual(
    normalizeDesktopWorkspaceBounds({ x: 901, y: -5, width: 500, height: 900 }, [1000, 800]),
    { x: 901, y: 0, width: 99, height: 800 },
  );
  assert.throws(
    () => normalizeDesktopWorkspaceBounds({ x: 0, y: 0, width: "20", height: 20 }, [1000, 800]),
    /invalid/,
  );
  assert.throws(
    () => normalizeDesktopWorkspaceBounds({ x: 0, y: 0, width: 0, height: 20 }, [1000, 800]),
    /empty/,
  );
});

function managerFixture() {
  const notifications = [];
  const views = [];
  const children = [];
  class FakeWebContents {
    constructor() {
      this.url = "";
      this.closed = false;
      this.handlers = new Map();
      this.session = {
        setPermissionCheckHandler: (handler) => { this.permissionCheck = handler; },
        setPermissionRequestHandler: (handler) => { this.permissionRequest = handler; },
      };
    }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    on(name, handler) { this.handlers.set(name, handler); }
    async loadURL(url) {
      if (this.loadHook) await this.loadHook(url);
      this.url = url;
    }
    getURL() { return this.url; }
    isDestroyed() { return this.closed; }
    close() { this.closed = true; }
  }
  class FakeView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents();
      this.visible = false;
      this.bounds = null;
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
  const owner = {
    contentView: {
      addChildView(view) { children.push(view); },
      removeChildView(view) {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      },
    },
    getContentSize: () => [1200, 800],
    isDestroyed: () => false,
  };
  const manager = createDesktopWorkspaceManager({
    owner,
    createView: (options) => new FakeView(options),
    notify: (state) => notifications.push(state),
    partitionPrefix: "openmausbot-test",
  });
  const open = (contextId, port, bounds = { x: 10, y: 20, width: 500, height: 400 }) =>
    manager.open({
      contextId,
      url: `http://127.0.0.1:${port}/vnc.html#autoconnect=true&password=secret-${port}`,
      title: contextId,
      bounds,
    });
  return { children, manager, notifications, open, views };
}

test("manager keeps two isolated watch-only views and rejects duplicates or a third", async () => {
  const { children, manager, open, views } = managerFixture();
  await open("left", 6080);
  await open("right", 6081);
  assert.equal(manager.size(), 2);
  assert.equal(children.length, 2);
  assert.notEqual(
    views[0].options.webPreferences.partition,
    views[1].options.webPreferences.partition,
  );
  assert.equal(views.every((view) => view.webContents.url.includes("view_only=true")), true);
  assert.equal(views.every((view) => view.options.webPreferences.sandbox === true), true);
  assert.equal(views.every((view) => view.options.webPreferences.contextIsolation === true), true);
  assert.equal(views.every((view) => view.options.webPreferences.nodeIntegration === false), true);
  assert.equal(views.every((view) => view.options.webPreferences.webSecurity === true), true);
  assert.equal(
    views.every((view) => view.options.webPreferences.allowRunningInsecureContent === false),
    true,
  );
  assert.equal(views.every((view) => view.webContents.permissionCheck() === false), true);
  assert.equal(views.every((view) => view.webContents.windowOpenHandler().action === "deny"), true);
  assert.equal(
    views.every((view) => !view.options.webPreferences.partition.startsWith("persist:")),
    true,
  );
  let denied = null;
  views[0].webContents.permissionRequest(null, "camera", (allowed) => { denied = allowed; });
  assert.equal(denied, false);
  let prevented = false;
  views[0].webContents.handlers.get("will-navigate")(
    { preventDefault() { prevented = true; } },
    "https://example.com/steal",
  );
  assert.equal(prevented, true);
  prevented = false;
  views[0].webContents.handlers.get("will-navigate")(
    { preventDefault() { prevented = true; } },
    "http://127.0.0.1:6080/another-local-path",
  );
  assert.equal(prevented, false);
  await assert.rejects(() => open("left", 6082), /already open/);
  await assert.rejects(() => open("third", 6082), /Only two/);

  manager.close("right");
  await assert.rejects(() => open("third", 6080), /already open/);
});

test("manager lays out panes and demotes the old pane before promoting the new one", async () => {
  const { manager, open, views } = managerFixture();
  await open("left", 6080);
  await open("right", 6081);
  manager.layout([
    { contextId: "left", bounds: { x: 20, y: 60, width: 550, height: 600 }, visible: true },
    { contextId: "right", bounds: { x: 590, y: 60, width: 550, height: 600 }, visible: true },
  ]);
  assert.equal(views[0].visible, true);
  assert.deepEqual(views[1].bounds, { x: 590, y: 60, width: 550, height: 600 });

  await manager.setInteractive("left");
  assert.equal(views[0].webContents.url.includes("view_only=false"), true);
  assert.equal(views[1].webContents.url.includes("view_only=true"), true);
  await manager.setInteractive("right");
  assert.equal(views[0].webContents.url.includes("view_only=true"), true);
  assert.equal(views[1].webContents.url.includes("view_only=false"), true);
  await manager.setInteractive(null);
  assert.equal(views.every((view) => view.webContents.url.includes("view_only=true")), true);
});

test("manager serializes overlapping demotion and promotion calls", async () => {
  const { manager, open, views } = managerFixture();
  await open("left", 6080);
  await open("right", 6081);
  await manager.setInteractive("left");

  let finishDemotion;
  const demotionGate = new Promise((resolve) => { finishDemotion = resolve; });
  let rightPromotionStarted = false;
  views[0].webContents.loadHook = async (url) => {
    if (url.includes("view_only=true")) await demotionGate;
  };
  views[1].webContents.loadHook = async (url) => {
    if (url.includes("view_only=false")) rightPromotionStarted = true;
  };

  const demote = manager.setInteractive(null);
  await new Promise((resolve) => setImmediate(resolve));
  const promote = manager.setInteractive("right");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rightPromotionStarted, false);
  assert.equal(views[0].webContents.url.includes("view_only=false"), true);

  finishDemotion();
  await Promise.all([demote, promote]);
  assert.equal(views[0].webContents.url.includes("view_only=true"), true);
  assert.equal(views[1].webContents.url.includes("view_only=false"), true);
});

test("manager preserves one controller across reverse-order queued switches", async () => {
  const { manager, open, views } = managerFixture();
  await open("left", 6080);
  await open("right", 6081);
  await manager.setInteractive("left");

  let finishDemotion;
  const demotionGate = new Promise((resolve) => { finishDemotion = resolve; });
  views[0].webContents.loadHook = async (url) => {
    if (url.includes("view_only=true")) await demotionGate;
  };

  const switchRight = manager.setInteractive("right");
  await new Promise((resolve) => setImmediate(resolve));
  const switchBackLeft = manager.setInteractive("left");
  finishDemotion();
  await Promise.all([switchRight, switchBackLeft]);

  assert.equal(views[0].webContents.url.includes("view_only=false"), true);
  assert.equal(views[1].webContents.url.includes("view_only=true"), true);
});

test("queued interaction cannot promote a replacement pane with a reused context id", async () => {
  const { manager, open, views } = managerFixture();
  await open("left", 6080);
  await open("right", 6081);
  await manager.setInteractive("left");

  let finishDemotion;
  const demotionGate = new Promise((resolve) => { finishDemotion = resolve; });
  views[0].webContents.loadHook = async (url) => {
    if (url.includes("view_only=true")) await demotionGate;
  };

  const demote = manager.setInteractive(null);
  await new Promise((resolve) => setImmediate(resolve));
  const stalePromotion = manager.setInteractive("right");
  manager.close("right");
  await open("right", 6082);

  finishDemotion();
  await demote;
  await assert.rejects(stalePromotion, /not open/);
  assert.equal(views[2].webContents.url.includes("view_only=true"), true);
});

test("manager fails closed when an interactive reload derives from an invalid URL", async () => {
  const { manager, open, views } = managerFixture();
  await open("left", 6080);
  views[0].webContents.url = "https://desktop.example/vnc.html#password=never-print-this";

  await assert.rejects(
    manager.setInteractive("left"),
    (error) => error instanceof Error && !error.message.includes("never-print-this"),
  );
  assert.equal(manager.size(), 0);
  assert.equal(views[0].webContents.closed, true);
});

test("manager does not report a pane ready after it closes during open", async () => {
  const { manager, notifications, open } = managerFixture();
  const pending = open("left", 6080);
  manager.close("left");

  const state = await pending;
  assert.deepEqual(state, {
    contextId: "left",
    open: false,
    status: "closed",
    interactive: false,
  });
  assert.equal(notifications.at(-1)?.status, "closed");
  assert.equal(manager.size(), 0);
});

test("manager closes panes independently and emits no viewer URL", async () => {
  const { children, manager, notifications, open, views } = managerFixture();
  await open("left", 6080);
  await open("right", 6081);
  manager.close("left");
  assert.equal(children.length, 1);
  assert.equal(views[0].webContents.closed, true);
  assert.equal(views[1].webContents.closed, false);
  manager.closeAll();
  assert.equal(children.length, 0);
  assert.equal(JSON.stringify(notifications).includes("password="), false);
  assert.equal(JSON.stringify(notifications).includes("127.0.0.1"), false);
});
