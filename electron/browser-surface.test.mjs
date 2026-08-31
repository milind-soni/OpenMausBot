import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  GUEST_PROFILE,
  VIEWPORT,
  createBrowserSurfaceManager,
  domSnapshotContainsProtectedValue,
} = require("./browser-surface.cjs");

const AX_NODES = [
  { role: { value: "link" }, name: { value: "Docs" }, backendDOMNodeId: 11 },
  { role: { value: "textbox" }, name: { value: "Search" }, backendDOMNodeId: 12 },
  { role: { value: "combobox" }, name: { value: "Country" }, backendDOMNodeId: 13 },
];

/** A WebContents + WebContentsView double that records what the manager
 * asked of it. CDP calls answer from a small table so the click/fill
 * sequences can be asserted verbatim; protocol events can be injected. */
function fakeView(partition) {
  const calls = [];
  const listeners = new Map();
  const debuggerListeners = new Map();
  let url = "about:blank";
  let title = "";
  let pageText = "Welcome. Docs Search";
  let loading = false;
  let protectedScreenshotValue = false;
  let axNodes = structuredClone(AX_NODES);
  let hitBackendNodeId = null;
  let hitRelated = true;
  let richRefsValid = true;
  let richHit = true;
  let devicePixelRatio = 2;
  let emulationFailures = 0;
  let domScrollAtPoint = false;
  const injectedContexts = new Set();
  let mainWorldSpoofed = false;
  const fieldClassifications = new Map([
    ["obj-12", "ordinary"],
    ["obj-e1", "ordinary"],
    ["active-element", "ordinary"],
  ]);
  const fieldClassificationQueues = new Map();
  const webContents = {
    session: {
      getUserAgent: () => "Mozilla/5.0 Chrome/1 Electron/43 OpenMausBot/1",
      setUserAgent: (ua) => calls.push(["setUserAgent", ua]),
      setPermissionCheckHandler: () => {},
      setPermissionRequestHandler: () => {},
      on: (name) => calls.push(["sessionOn", name]),
      resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] }),
      webRequest: {
        onBeforeRequest: (handler) => {
          view.beforeRequest = handler;
        },
      },
    },
    setWindowOpenHandler: (handler) => {
      webContents.windowOpenHandler = handler;
    },
    on: (name, handler) => {
      listeners.set(name, handler);
    },
    once: (name, handler) => {
      listeners.set(name, handler);
    },
    removeListener: (name, handler) => {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
    isDestroyed: () => false,
    isLoading: () => loading,
    getURL: () => url,
    getTitle: () => title,
    navigationHistory: {
      canGoBack: () => url !== "about:blank",
      canGoForward: () => false,
      goBack: () => calls.push(["goBack"]),
      goForward: () => calls.push(["goForward"]),
    },
    loadURL: async (next) => {
      calls.push(["loadURL", next]);
      url = next;
      title = next === "about:blank" ? "" : "Loaded";
    },
    reload: () => calls.push(["reload"]),
    enableDeviceEmulation: (options) => {
      calls.push(["enableDeviceEmulation", options]);
      if (emulationFailures > 0) {
        emulationFailures -= 1;
        throw new Error("fixture emulation failure");
      }
    },
    disableDeviceEmulation: () => calls.push(["disableDeviceEmulation"]),
    close: () => calls.push(["close"]),
    capturePage: async () => ({
      getSize: () => ({ width: 2048, height: 1200 }),
      resize: ({ width }) => ({ getSize: () => ({ width, height: Math.round((1200 * width) / 2048) }), toJPEG: () => Buffer.from("jpeg") }),
      toJPEG: () => Buffer.from("jpeg"),
    }),
    debugger: {
      attached: false,
      attach: (version) => {
        calls.push(["attach", version]);
        webContents.debugger.attached = true;
      },
      detach: () => calls.push(["detach"]),
      on: (name, handler) => debuggerListeners.set(name, handler),
      sendCommand: async (method, params) => {
        calls.push([method, params]);
        if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
        if (method === "DOM.getBoxModel") {
          if (params.backendNodeId === 99) throw new Error("No node with given id found");
          const base = params.backendNodeId === 13 ? 200 : 10;
          return { model: { border: [base, 20, base + 100, 20, base + 100, 60, base, 60] } };
        }
        if (method === "DOM.resolveNode") return { object: { objectId: `obj-${params.backendNodeId}` } };
        if (method === "DOM.getNodeForLocation") {
          return { backendNodeId: hitBackendNodeId ?? (Number(params.x) >= 200 ? 13 : 11) };
        }
        if (method === "DOMSnapshot.captureSnapshot") {
          const strings = ["#document", "INPUT", "type", "password", "name", "api_key", "fixture-secret"];
          const nodes = {
            nodeName: protectedScreenshotValue ? [0, 1] : [0],
            nodeValue: protectedScreenshotValue ? [-1, -1] : [-1],
            parentIndex: protectedScreenshotValue ? [-1, 0] : [-1],
            attributes: protectedScreenshotValue ? [[], [2, 3, 4, 5]] : [[]],
          };
          if (protectedScreenshotValue) nodes.inputValue = { index: [1], value: [6] };
          return {
            strings,
            documents: [{ nodes }],
          };
        }
        if (method === "Runtime.callFunctionOn") return { result: { value: { chosen: ["India"] } } };
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression);
          if (expression === "window.devicePixelRatio") return { result: { value: devicePixelRatio } };
          if (expression.includes("document.activeElement")) return { result: { objectId: "active-element" } };
          if (expression === "/*injected*/") {
            injectedContexts.add(params.contextId);
            return { result: { value: undefined } };
          }
          if (expression.includes("Boolean(window.__ombBrowser)")) {
            return { result: { value: injectedContexts.has(params.contextId) || (params.contextId === undefined && mainWorldSpoofed) } };
          }
          if (expression.includes("__ombBrowser.snapshot(")) return { result: { value: { yaml: '- heading "Docs" [ref=e1]\n- textbox "Search" [ref=e2]', refs: ["e1", "e2"], truncated: false } } };
          if (expression.includes("validateRef")) return { result: { value: richRefsValid } };
          if (expression.includes("hitTestRef")) return { result: { value: richHit } };
          if (expression.includes("boxForRef")) {
            if (expression.includes('"e9"')) return { result: { value: { found: false } } };
            return { result: { value: { found: true, connected: true, visible: true, x: 77, y: 33 } } };
          }
          if (expression.includes("focusRef")) return { result: { value: true } };
          if (expression.includes("elementForRef")) return { result: { objectId: "obj-e1" } };
          if (expression.includes("__ombScrollAtPoint")) return { result: { value: domScrollAtPoint } };
          if (expression.includes("scrollingElement")) return { result: { value: { top: 0, height: 2400, view: 800 } } };
          return { result: { value: pageText } };
        }
        if (method === "Page.captureScreenshot") return { data: Buffer.from("cdp-jpeg").toString("base64") };
        return {};
      },
    },
  };
  const view = {
    partition,
    webContents,
    bounds: null,
    visible: null,
    setBoundsCalls: [],
    setVisibleCalls: [],
    setBounds: (bounds) => {
      view.bounds = bounds;
      view.setBoundsCalls.push(bounds);
    },
    setVisible: (visible) => {
      view.visible = visible;
      view.setVisibleCalls.push(visible);
    },
    getBounds: () => view.bounds ?? { x: 0, y: 0, width: 800, height: 600 },
    calls,
    listeners,
    debuggerListeners,
    setPageText: (text) => {
      pageText = text;
    },
    setTitle: (value) => {
      title = String(value ?? "");
    },
    setLoading: (value) => {
      loading = value;
    },
    setProtectedScreenshotValue: (value) => {
      protectedScreenshotValue = value === true;
    },
    setAxNodeName: (backendNodeId, name) => {
      axNodes = axNodes.map((node) => Number(node.backendDOMNodeId) === backendNodeId
        ? { ...node, name: { value: name } }
        : node);
    },
    setHitTarget: (backendNodeId, related = false) => {
      hitBackendNodeId = backendNodeId;
      hitRelated = related;
    },
    setRichRefValid: (valid) => {
      richRefsValid = valid === true;
    },
    setRichHit: (hit) => {
      richHit = hit === true;
    },
    setDevicePixelRatio: (value) => {
      devicePixelRatio = Number(value);
    },
    failNextEmulation: () => {
      emulationFailures += 1;
    },
    setDomScrollAtPoint: (value) => {
      domScrollAtPoint = value === true;
    },
    setSensitive: (objectId, value = true) => {
      fieldClassifications.set(objectId, value ? "sensitive" : "ordinary");
    },
    setFieldClassification: (objectId, classification) => {
      fieldClassifications.set(objectId, classification);
    },
    queueFieldClassifications: (objectId, classifications) => {
      fieldClassificationQueues.set(objectId, [...classifications]);
    },
    spoofMainWorldBrowserHelper: () => {
      mainWorldSpoofed = true;
    },
  };
  const rawSendCommand = webContents.debugger.sendCommand;
  webContents.debugger.sendCommand = async (method, params = {}) => {
    if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("__ombSensitiveField")) {
      calls.push([method, params]);
      const queue = fieldClassificationQueues.get(params.objectId);
      const value = queue?.length ? queue.shift() : fieldClassifications.get(params.objectId) ?? "unknown";
      return { result: { value } };
    }
    if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("__ombHitRelated")) {
      calls.push([method, params]);
      return { result: { value: hitRelated } };
    }
    return rawSendCommand(method, params);
  };
  return view;
}

function harness(options = {}) {
  const views = [];
  const sessions = new Map();
  const owner = {
    isDestroyed: () => false,
    getContentSize: () => [1200, 800],
    contentView: {
      children: [],
      addChildView: (view) => {
        owner.contentView.children = owner.contentView.children.filter((candidate) => candidate !== view);
        owner.contentView.children.push(view);
      },
      removeChildView: (view) => {
        owner.contentView.children = owner.contentView.children.filter((candidate) => candidate !== view);
      },
    },
  };
  const states = [];
  let clock = 0;
  const manager = createBrowserSurfaceManager({
    owner,
    createView: (viewOptions) => {
      const view = fakeView(viewOptions.webPreferences.partition);
      const shared = sessions.get(viewOptions.webPreferences.partition);
      if (shared) view.webContents.session = shared;
      else sessions.set(viewOptions.webPreferences.partition, view.webContents.session);
      views.push(view);
      return view;
    },
    notify: (state) => states.push(state),
    platform: "darwin",
    settleMs: 0,
    // real time (waits have real deadlines) but strictly monotonic (LRU order)
    now: () => Date.now() + (clock += 1),
    ...options,
  });
  return { manager, owner, views, states };
}

const cdpCalls = (view) => view.calls.filter(([name]) => /^[A-Z]/.test(name) && name.includes("."));
const BOUNDS = { x: 20, y: 30, width: 400, height: 250 };

describe("browser screenshot privacy snapshot", () => {
  it("finds a populated protected input inside a closed shadow root", () => {
    const strings = [
      "#document", "DIV", "#document-fragment", "LABEL", "#text", "INPUT",
      "closed", "for", "credential", "API key", "id", "name", "value", "sk-shadow-secret",
    ];
    expect(domSnapshotContainsProtectedValue({
      strings,
      documents: [{
        nodes: {
          nodeName: [0, 1, 2, 3, 4, 5],
          nodeValue: [-1, -1, -1, -1, 9, -1],
          parentIndex: [-1, 0, 1, 2, 3, 2],
          attributes: [[], [], [], [7, 8], [], [10, 8, 11, 8]],
          shadowRootType: { index: [2], value: [6] },
          inputValue: { index: [5], value: [13] },
        },
      }],
    })).toBe(true);
    expect(domSnapshotContainsProtectedValue({
      strings,
      documents: [{
        nodes: {
          nodeName: [0, 1, 2, 5],
          nodeValue: [-1, -1, -1, -1],
          parentIndex: [-1, 0, 1, 2],
          attributes: [[], [], [], [11, 12]],
          inputValue: { index: [3], value: [13] },
        },
      }],
    })).toBe(false);
  });
});

describe("browser surface manager", () => {
  it("creates one sandboxed, partitioned view per bot only when something needs it", () => {
    const { manager, owner, views } = harness();
    expect(manager.layout("bot-a", null)).toMatchObject({ botId: "bot-a", open: false });
    expect(views).toHaveLength(0);

    // a view that exists but is not laid out still has a real viewport
    manager.ensure("bot-z", "");
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
    expect(views[0].visible).toBe(false);
    manager.close("bot-z");
    views.length = 0;

    const state = manager.layout("bot-a", { x: 20.4, y: 30.6, width: 5000, height: 300 }, "", "compact");
    expect(views).toHaveLength(1);
    expect(views[0].partition).toBe("persist:openmausbot-browser-bot-a");
    expect(views[0].bounds).toEqual({ x: 20, y: 31, width: 1180, height: 300 });
    expect(views[0].visible).toBe(true);
    expect(owner.contentView.children).toEqual([views[0]]);
    expect(state).toMatchObject({ botId: "bot-a", open: true, visible: true, url: "about:blank", profile: "", mode: "compact" });
    expect(views[0].calls).toContainEqual(["setUserAgent", "Mozilla/5.0 Chrome/1"]);

    manager.layout("bot-a", null);
    expect(views[0].visible).toBe(false);
    expect(() => manager.layout("../bad", BOUNDS)).toThrow(/bot id/);
  });

  it("scales the same fixed desktop viewport to fit compact and expanded boxes", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    const emulation = views[0].calls.find(([name]) => name === "enableDeviceEmulation")[1];
    expect(emulation.viewSize).toEqual(VIEWPORT);
    // 400/1280 = 0.3125 and 250/800 = 0.3125 — fit on both axes
    expect(emulation.scale).toBeCloseTo(0.3125, 4);
    manager.layout("bot-a", { x: 0, y: 0, width: 1100, height: 700 }, "", "expanded");
    const expanded = views[0].calls.filter(([name]) => name === "enableDeviceEmulation").at(-1)[1];
    expect(expanded.viewSize).toEqual(VIEWPORT);
    expect(expanded.screenSize).toEqual(VIEWPORT);
    expect(expanded.scale).toBeCloseTo(0.859375, 6);
    expect(views[0].calls.some(([name]) => name === "disableDeviceEmulation")).toBe(false);
    expect(manager.state("bot-a").mode).toBe("expanded");
  });

  it("does not reapply unchanged bounds, visibility, or compact emulation", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    const view = views[0];
    const initialBoundsCalls = view.setBoundsCalls.length;
    const initialVisibleCalls = view.setVisibleCalls.length;
    const initialEmulationCalls = view.calls.filter(([name]) => name === "enableDeviceEmulation").length;

    manager.layout("bot-a", { ...BOUNDS }, "", "compact");
    manager.layout("bot-a", { ...BOUNDS }, "", "compact");

    expect(view.setBoundsCalls).toHaveLength(initialBoundsCalls);
    expect(view.setVisibleCalls).toHaveLength(initialVisibleCalls);
    expect(view.calls.filter(([name]) => name === "enableDeviceEmulation")).toHaveLength(initialEmulationCalls);
  });

  it("raises a hidden native view when its surface becomes visible again", () => {
    const { manager, owner, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    manager.layout("bot-a", null, "", "compact");
    manager.layout("bot-b", BOUNDS, "", "compact");
    expect(owner.contentView.children).toEqual([views[0], views[1]]);

    manager.layout("bot-a", BOUNDS, "", "compact");
    expect(owner.contentView.children).toEqual([views[1], views[0]]);
    expect(views[0].visible).toBe(true);
  });

  it("moves without resetting emulation and reapplies it only when compact scale changes", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    const view = views[0];

    manager.layout("bot-a", { ...BOUNDS, x: 80, y: 90 }, "", "compact");
    expect(view.setBoundsCalls.at(-1)).toEqual({ ...BOUNDS, x: 80, y: 90 });
    expect(view.calls.filter(([name]) => name === "enableDeviceEmulation")).toHaveLength(1);

    manager.layout("bot-a", { ...BOUNDS, x: 80, y: 90, width: 320 }, "", "compact");
    const emulationCalls = view.calls.filter(([name]) => name === "enableDeviceEmulation");
    expect(emulationCalls).toHaveLength(2);
    expect(emulationCalls.at(-1)[1].viewSize).toEqual(VIEWPORT);
    expect(emulationCalls.at(-1)[1].scale).toBeCloseTo(0.25, 4);
  });

  it("reapplies compact emulation after a main-frame navigation commits", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    const view = views[0];
    expect(view.calls.filter(([name]) => name === "enableDeviceEmulation")).toHaveLength(1);

    view.listeners.get("did-navigate")?.();

    const emulationCalls = view.calls.filter(([name]) => name === "enableDeviceEmulation");
    expect(emulationCalls).toHaveLength(2);
    expect(emulationCalls.at(-1)[1]).toMatchObject({
      viewSize: VIEWPORT,
      screenSize: VIEWPORT,
    });
  });

  it("reapplies expanded fixed-viewport emulation after a main-frame navigation commits", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", { x: 10, y: 20, width: 960, height: 700 }, "", "expanded");
    const view = views[0];
    expect(view.calls.filter(([name]) => name === "enableDeviceEmulation")).toHaveLength(1);

    view.listeners.get("did-navigate")?.();

    const emulationCalls = view.calls.filter(([name]) => name === "enableDeviceEmulation");
    expect(emulationCalls).toHaveLength(2);
    expect(emulationCalls.at(-1)[1]).toMatchObject({
      viewSize: VIEWPORT,
      screenSize: VIEWPORT,
      scale: 0.75,
    });
  });

  it("retries a commit-time emulation failure when loading finishes", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    const view = views[0];
    view.failNextEmulation();

    view.listeners.get("did-navigate")?.();
    expect(view.calls.filter(([name]) => name === "enableDeviceEmulation")).toHaveLength(2);
    view.listeners.get("did-stop-loading")?.();

    const emulationCalls = view.calls.filter(([name]) => name === "enableDeviceEmulation");
    expect(emulationCalls).toHaveLength(3);
    expect(emulationCalls.at(-1)[1]).toMatchObject({ viewSize: VIEWPORT, scale: 0.3125 });
  });

  it("navigates only to web pages and answers with the page's elements plus a scroll hint", async () => {
    const { manager, views } = harness();
    await expect(manager.navigate("bot-a", "file:///etc/passwd")).rejects.toThrow(/http and https/);
    const page = await manager.navigate("bot-a", "example.com");
    expect(views[0].calls).toContainEqual(["loadURL", "https://example.com/"]);
    expect(page.url).toBe("https://example.com/");
    expect(page.elements.map((element) => element.ref)).toEqual(["b11", "b12", "b13"]);
    expect(page.text).toContain('b11 link "link"');
    expect(page.text).toContain("1600px below");
    expect(views[0].calls).toContainEqual(["attach", "1.3"]);
    // attaching also enables Page events, intercepts native file pickers, and
    // makes the page believe it is focused so synthetic clicks are not dropped
    expect(cdpCalls(views[0]).slice(0, 3).map(([name]) => name)).toEqual(["Page.enable", "Page.setInterceptFileChooserDialog", "Emulation.setFocusEmulationEnabled"]);
    const protocolReadyAt = views[0].calls.findIndex(([name]) => name === "Page.setInterceptFileChooserDialog");
    const untrustedLoadAt = views[0].calls.findIndex(([name, url]) => name === "loadURL" && url === "https://example.com/");
    expect(protocolReadyAt).toBeGreaterThanOrEqual(0);
    expect(untrustedLoadAt).toBeGreaterThan(protocolReadyAt);
  });

  it("reloads the active page without manufacturing a new history entry", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");

    await manager.reload("bot-a", "", { source: "user" });

    expect(views[0].calls.filter(([name]) => name === "reload")).toHaveLength(1);
    expect(views[0].calls.filter(([name]) => name === "loadURL")).toHaveLength(2);
  });

  it("blocks DNS-private redirects without replaying public redirects or form navigations as GETs", async () => {
    const { manager, views } = harness({
      resolveHost: async (_entry, hostname) => ({
        endpoints: [{ address: hostname === "private.example" ? "192.168.1.20" : "93.184.216.34" }],
      }),
    });
    await expect(manager.navigate("bot-a", "https://private.example")).rejects.toThrow(/private-network/);
    await manager.navigate("bot-a", "https://public.example");

    const event = { preventDefault: vi.fn() };
    views[0].listeners.get("will-redirect")?.(event, "https://private.example/admin");
    // Hostname redirects/form POSTs keep their original Chromium request;
    // the asynchronous session policy rejects the resolved private address.
    expect(event.preventDefault).not.toHaveBeenCalled();
    await expect(new Promise((resolve) => views[0].beforeRequest({
      url: "https://private.example/admin",
      method: "POST",
      uploadData: [{ bytes: Buffer.from("secret=form-body") }],
    }, resolve))).resolves.toEqual({ cancel: true });
    expect(views[0].calls).not.toContainEqual(["loadURL", "https://private.example/admin"]);
    const publicForm = { preventDefault: vi.fn() };
    views[0].listeners.get("will-navigate")?.(publicForm, "https://public.example/login");
    expect(publicForm.preventDefault).not.toHaveBeenCalled();
    const literalPrivate = { preventDefault: vi.fn() };
    views[0].listeners.get("will-redirect")?.(literalPrivate, "http://127.0.0.1:8799/api/config");
    expect(literalPrivate.preventDefault).toHaveBeenCalledOnce();
    const page = await manager.snapshot("bot-a");
    expect(page.notes).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Blocked page request: .*private-network/),
      expect.stringMatching(/^Blocked navigation: .*private-network/),
    ]));
  });

  it("keeps native history traversal instead of canceling and appending a fresh load", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com/second");
    const loadsBefore = views[0].calls.filter(([name]) => name === "loadURL").length;
    await manager.back("bot-a", "");
    expect(views[0].calls).toContainEqual(["goBack"]);
    expect(views[0].calls.filter(([name]) => name === "loadURL")).toHaveLength(loadsBefore);
  });

  it("refuses POST popups instead of replaying their bodyless URL as a GET", async () => {
    const { manager, views } = harness();
    manager.ensure("bot-a", "");
    expect(views[0].webContents.windowOpenHandler({
      url: "https://example.com/checkout",
      postBody: { data: [{ bytes: Buffer.from("card=redacted") }] },
    })).toEqual({ action: "deny" });
    expect(views[0].calls).not.toContainEqual(["loadURL", "https://example.com/checkout"]);
    expect((await manager.snapshot("bot-a")).notes).toContain(
      "Blocked a popup that tried to submit form data; open it in the current page instead",
    );
  });

  it("blocks private HTTP and WebSocket subresources before the page can reach them", async () => {
    const { manager, views } = harness();
    manager.ensure("bot-a", "");
    const request = (url) => new Promise((resolve) => views[0].beforeRequest({ url }, resolve));
    await expect(request("http://127.0.0.1:8799/api/config")).resolves.toEqual({ cancel: true });
    await expect(request("ws://192.168.1.4:3000/socket")).resolves.toEqual({ cancel: true });
    await expect(request("wss://[fec0::1]/socket")).resolves.toEqual({ cancel: true });
    await expect(request("https://example.com/app.js")).resolves.toEqual({ cancel: false });
    await expect(request("data:text/plain,hello")).resolves.toEqual({ cancel: false });
    const page = await manager.snapshot("bot-a");
    expect(page.notes.filter((note) => note.startsWith("Blocked page request:"))).toHaveLength(3);
  });

  it("cancels HTTP-auth and client-certificate prompts instead of showing native UI", async () => {
    const { manager, views } = harness();
    manager.ensure("bot-a", "");
    const authEvent = { preventDefault: vi.fn() };
    const authCallback = vi.fn();
    views[0].listeners.get("login")?.(authEvent, {}, {}, authCallback);
    expect(authEvent.preventDefault).toHaveBeenCalledOnce();
    expect(authCallback).toHaveBeenCalledWith();

    const certEvent = { preventDefault: vi.fn() };
    const certCallback = vi.fn();
    views[0].listeners.get("select-client-certificate")?.(certEvent, "https://example.com", [{}], certCallback);
    expect(certEvent.preventDefault).toHaveBeenCalledOnce();
    expect(certCallback).toHaveBeenCalledWith();
    const page = await manager.snapshot("bot-a");
    expect(page.notes).toEqual(expect.arrayContaining([
      expect.stringMatching(/HTTP authentication prompt/),
      expect.stringMatching(/client-certificate prompt/),
    ]));
  });

  it("keeps one live view per profile and switches by showing another, never rebuilding", async () => {
    const { manager, owner, views, states } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    await manager.navigate("bot-a", "https://own.example");
    // switch to a named profile: a second view in the shared partition takes the same rectangle
    manager.layout("bot-a", BOUNDS, "work", "compact");
    expect(views).toHaveLength(2);
    expect(views[1].partition).toBe("persist:openmausbot-browser-profile-work");
    expect(views[0].visible).toBe(false);
    expect(views[1].visible).toBe(true);
    expect(views[1].bounds).toEqual(BOUNDS);
    expect(manager.state("bot-a")).toMatchObject({ profile: "work", url: "about:blank" });
    await manager.navigate("bot-a", "https://work.example");
    expect(manager.state("bot-a", "")).toMatchObject({ profile: "", url: "https://own.example/" });
    expect(manager.state("bot-a", "work")).toMatchObject({ profile: "work", url: "https://work.example/" });
    // back to the bot's own session: the first view is still there with its page
    manager.layout("bot-a", BOUNDS, "", "compact");
    expect(views).toHaveLength(2);
    expect(manager.state("bot-a")).toMatchObject({ profile: "", url: "https://own.example/" });
    expect(views[0].visible).toBe(true);
    expect(views[1].visible).toBe(false);
    expect(owner.contentView.children.at(-1)).toBe(views[0]);
    // a caller that does not know the profile acts on whatever is active
    const page = await manager.snapshot("bot-a");
    expect(page.url).toBe("https://own.example/");
    // another bot on the same named profile shares the session, not the view
    manager.layout("bot-b", BOUNDS, "work", "compact");
    expect(views[2].partition).toBe("persist:openmausbot-browser-profile-work");
    expect(views[1].calls.filter(([name, event]) => name === "sessionOn" && event === "will-download")).toHaveLength(1);
    expect(manager.list().filter((entry) => entry.active).map((entry) => entry.botId).sort()).toEqual(["bot-a", "bot-b"]);
    expect(states.some((state) => state.botId === "bot-a" && state.profile === "work")).toBe(true);
    expect(views[1].calls.some(([name]) => name === "close")).toBe(false);
  });

  it("applies compact bounds when switching profiles after the old surface was hidden", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    manager.layout("bot-a", null, "", "compact");

    manager.layout("bot-a", BOUNDS, "work", "compact");

    expect(views).toHaveLength(2);
    expect(views[1].bounds).toEqual(BOUNDS);
    expect(views[1].visible).toBe(true);
    expect(views[1].calls.find(([name]) => name === "enableDeviceEmulation")?.[1]).toMatchObject({
      viewSize: VIEWPORT,
      screenSize: VIEWPORT,
    });
  });

  it("ignores a stale profile-scoped hide after another profile is active", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    manager.layout("bot-a", BOUNDS, "work", "compact");

    const state = manager.layout("bot-a", null, "", "compact");

    expect(state).toMatchObject({ profile: "work", visible: true });
    expect(views[1].visible).toBe(true);
    manager.layout("bot-a", null, "work", "compact");
    expect(views[1].visible).toBe(false);
  });

  it("ignores cleanup from an older layout owner on the same profile", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact", "compact-owner");
    manager.layout("bot-a", { ...BOUNDS, width: 800, height: 500 }, "", "expanded", "expanded-owner");

    const state = manager.layout("bot-a", null, "", "compact", "compact-owner");

    expect(state).toMatchObject({ profile: "", visible: true, mode: "expanded" });
    expect(views[0].visible).toBe(true);
    manager.layout("bot-a", null, "", "expanded", "expanded-owner");
    expect(views[0].visible).toBe(false);
  });

  it("reuses a cold own-profile view after the active shared profile is removed", async () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    await manager.navigate("bot-a", "https://own.example");
    manager.layout("bot-a", BOUNDS, "work", "compact");
    expect(manager.forgetProfile("work")).toBe(1);
    expect(manager.state("bot-a").open).toBe(false);
    expect((await manager.snapshot("bot-a")).url).toBe("https://own.example/");
    expect(views).toHaveLength(2);
  });

  it("forgets a Guest session the moment the bot switches off it", async () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, GUEST_PROFILE, "compact");
    expect(views[0].partition).toMatch(/^openmausbot-browser-guest-bot-a-\d+$/);
    expect(views[0].partition.startsWith("persist:")).toBe(false);
    await manager.navigate("bot-a", "https://secret.example");
    manager.layout("bot-a", BOUNDS, "", "compact");
    expect(views[0].calls.some(([name]) => name === "close")).toBe(true);
    expect(manager.size()).toBe(1);
    // a fresh Guest is a fresh partition
    manager.layout("bot-a", BOUNDS, GUEST_PROFILE, "compact");
    expect(views[2].partition).not.toBe(views[0].partition);
  });

  it("evicts the coldest view nobody is showing when the cap is reached", async () => {
    const { manager, views } = harness({ maxViews: 3 });
    manager.layout("bot-a", BOUNDS, "", "compact");
    manager.layout("bot-a", BOUNDS, "p1", "compact");
    manager.layout("bot-a", BOUNDS, "p2", "compact");
    expect(manager.size()).toBe(3);
    // the fourth view evicts the least recently used inactive one (own session)
    manager.layout("bot-a", BOUNDS, "p3", "compact");
    expect(manager.size()).toBe(3);
    expect(views[0].calls.some(([name]) => name === "close")).toBe(true);
    expect(manager.list().map((entry) => entry.profile).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("evicts hidden idle views selected by other bots instead of locking out the next bot", () => {
    const { manager, views } = harness({ maxViews: 3 });
    manager.ensure("bot-a", "");
    manager.ensure("bot-b", "");
    manager.ensure("bot-c", "");
    expect(manager.size()).toBe(3);
    manager.ensure("bot-d", "");
    expect(manager.size()).toBe(3);
    expect(views[0].calls.some(([name]) => name === "close")).toBe(true);
    expect(manager.list().map(({ botId }) => botId).sort()).toEqual(["bot-b", "bot-c", "bot-d"]);
  });

  it("does not evict a hidden view while a live turn capability pins it", () => {
    const { manager, views } = harness({ maxViews: 2 });
    manager.ensure("bot-a", "");
    manager.setCapabilityActive("bot-a", "", true);
    manager.ensure("bot-b", "");
    manager.ensure("bot-c", "");
    expect(views[0].calls.some(([name]) => name === "close")).toBe(false);
    expect(views[1].calls.some(([name]) => name === "close")).toBe(true);
    expect(manager.list().map(({ botId }) => botId).sort()).toEqual(["bot-a", "bot-c"]);
  });

  it("never evicts a hidden view while an operation is still using it", async () => {
    const { manager, views } = harness({ maxViews: 1 });
    manager.ensure("bot-a", "");
    const original = views[0].webContents.debugger.sendCommand;
    let resume;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    views[0].webContents.debugger.sendCommand = async (method, params) => {
      if (method === "Page.captureScreenshot") {
        markStarted();
        await new Promise((resolve) => { resume = resolve; });
      }
      return original(method, params);
    };
    const pending = manager.screenshot("bot-a", "");
    await started;
    expect(() => manager.ensure("bot-b", "")).toThrow(/Only 1 bot browser/);
    resume();
    await pending;
    expect(() => manager.ensure("bot-b", "")).not.toThrow();
    expect(manager.list().map(({ botId }) => botId)).toEqual(["bot-b"]);
  });

  it("serializes concurrent agent operations on the same browser entry", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    const original = views[0].webContents.debugger.sendCommand;
    let resume;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let paused = false;
    views[0].webContents.debugger.sendCommand = async (method, params) => {
      if (!paused && method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
        paused = true;
        markStarted();
        await new Promise((resolve) => { resume = resolve; });
      }
      return original(method, params);
    };

    const first = manager.click("bot-a", "b11");
    await started;
    const second = manager.click("bot-a", "b11");
    await Promise.resolve();
    // The first movement is paused before the fake records it. If the second
    // operation interleaved, its movement would already be visible here.
    expect(cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent")).toHaveLength(0);
    resume();
    await Promise.all([first, second]);
    expect(cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent").map(([, params]) => params.type)).toEqual([
      "mouseMoved", "mousePressed", "mouseReleased",
      "mouseMoved", "mousePressed", "mouseReleased",
    ]);
  });

  it("clicks at the centre of a known ref and refuses stale or unknown ones", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await expect(manager.click("bot-a", "b99")).rejects.toThrow(/stale or unknown/);
    await expect(manager.click("bot-a", "nope")).rejects.toThrow(/stale or unknown/);
    await manager.click("bot-a", "b11");
    const mouse = cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent").map(([, params]) => params);
    expect(mouse).toEqual([
      { type: "mouseMoved", x: 60, y: 40 },
      { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 },
    ]);
    // a navigation invalidates every ref until the next snapshot
    views[0].listeners.get("did-navigate")?.();
    await expect(manager.click("bot-a", "b11")).rejects.toThrow(/changed since/);
  });

  it("maps fixed-viewport CSS coordinates into compact and expanded native surfaces", async () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    await manager.navigate("bot-a", "https://example.com");
    await manager.click("bot-a", "b11");

    let pointer = cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent").map(([, params]) => params);
    expect(pointer.slice(-3)).toEqual([
      { type: "mouseMoved", x: 18.75, y: 12.5 },
      { type: "mousePressed", x: 18.75, y: 12.5, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 18.75, y: 12.5, button: "left", clickCount: 1 },
    ]);
    const compactHitTest = cdpCalls(views[0]).filter(([name]) => name === "DOM.getNodeForLocation").at(-1)[1];
    expect(compactHitTest).toMatchObject({ x: 60, y: 40 });

    manager.layout("bot-a", { x: 0, y: 0, width: 800, height: 600 }, "", "expanded");
    await manager.click("bot-a", "b11");
    pointer = cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent").map(([, params]) => params);
    expect(pointer.slice(-3)).toEqual([
      { type: "mouseMoved", x: 37.5, y: 25 },
      { type: "mousePressed", x: 37.5, y: 25, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 37.5, y: 25, button: "left", clickCount: 1 },
    ]);

    await manager.scroll("bot-a", "down", 600);
    expect(cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent").slice(-2).map(([, params]) => params)).toEqual([
      { type: "mouseMoved", x: 400, y: 250 },
      { type: "mouseWheel", x: 400, y: 250, deltaX: 0, deltaY: 600 },
    ]);
  });

  it("scrolls a standard DOM container deterministically before using the compositor fallback", async () => {
    const { manager, views } = harness({ platform: "linux" });
    await manager.navigate("bot-a", "https://example.com");
    views[0].setDomScrollAtPoint(true);

    await manager.scroll("bot-a", "down", 600);

    const scrollEvaluation = cdpCalls(views[0]).findLast(([name, params]) =>
      name === "Runtime.evaluate" && String(params.expression).includes("__ombScrollAtPoint"));
    expect(scrollEvaluation?.[1].expression).toContain('{"x":640,"y":400,"deltaX":0,"deltaY":600}');
    expect(cdpCalls(views[0]).filter(([name, params]) =>
      name === "Input.dispatchMouseEvent" && params.type === "mouseWheel")).toHaveLength(0);
  });

  it("emits a real double-click sequence instead of only a detail-2 pair", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await manager.click("bot-a", "b11", { clickCount: 2 });
    const pointer = cdpCalls(views[0])
      .filter(([name, params]) => name === "Input.dispatchMouseEvent" && params.type !== "mouseMoved")
      .map(([, params]) => ({ type: params.type, clickCount: params.clickCount }));
    expect(pointer).toEqual([
      { type: "mousePressed", clickCount: 1 },
      { type: "mouseReleased", clickCount: 1 },
      { type: "mousePressed", clickCount: 2 },
      { type: "mouseReleased", clickCount: 2 },
    ]);
  });

  it("invalidates relabelled refs and refuses a late overlay before mouse-down", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    views[0].setAxNodeName(11, "Delete account");
    await expect(manager.click("bot-a", "b11")).rejects.toThrow(/stale because the page changed/);
    expect(cdpCalls(views[0]).some(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mousePressed")).toBe(false);

    await manager.snapshot("bot-a");
    views[0].setHitTarget(999, false);
    await expect(manager.click("bot-a", "b11")).rejects.toThrow(/covers that ref/);
    expect(cdpCalls(views[0]).some(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mousePressed")).toBe(false);
  });

  it("hands native input to the user immediately and gates agent actions until hand-back", async () => {
    const interactions = [];
    const { manager, views } = harness({ onUserInteraction: (event) => interactions.push(event) });
    await manager.navigate("bot-a", "https://example.com");
    views[0].listeners.get("focus")?.();
    expect(interactions).toEqual([{ botId: "bot-a", profile: "" }]);
    await expect(manager.click("bot-a", "b11")).rejects.toThrow(/held by the user/);
    // Renderer-driven address-bar navigation stays available while the user
    // has control; an agent call remains blocked.
    await manager.navigate("bot-a", "https://example.org", "", { source: "user" });
    expect(manager.setHumanControl("bot-a", false, "")).toBe(true);
    await expect(manager.click("bot-a", "b11")).resolves.toBeTruthy();
  });

  it.each(["mouseDown", "contextMenu", "mouseWheel"])("keeps compact human %s input watch-only while expanding", async (type) => {
    const interactions = [];
    const { manager, views } = harness({ onUserInteraction: (event) => interactions.push(event) });
    manager.layout("bot-a", BOUNDS, "", "compact");
    await manager.navigate("bot-a", "https://example.com");
    const event = { preventDefault: vi.fn() };
    views[0].listeners.get("before-mouse-event")?.(event, {
      type,
      button: type === "contextMenu" ? "right" : "left",
      x: 300,
      y: 180,
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(interactions).toEqual([{ botId: "bot-a", profile: "" }]);
    if (type === "mouseDown") {
      // Model the renderer responding immediately to the takeover before the
      // native release for the same gesture arrives.
      manager.layout("bot-a", { x: 0, y: 0, width: 900, height: 650 }, "", "expanded");
      const release = { preventDefault: vi.fn() };
      views[0].listeners.get("before-mouse-event")?.(release, { type: "mouseUp", button: "left", x: 300, y: 180 });
      expect(release.preventDefault).toHaveBeenCalledOnce();
    }
    manager.setHumanControl("bot-a", false, "");
    await expect(manager.read("bot-a")).resolves.toMatchObject({ title: "Loaded" });
  });

  it("reopens an already-controlled compact browser without activating its page", async () => {
    const interactions = [];
    const { manager, views } = harness({ onUserInteraction: (event) => interactions.push(event) });
    manager.layout("bot-a", BOUNDS, "", "compact");
    manager.setHumanControl("bot-a", true, "");
    const event = { preventDefault: vi.fn() };
    views[0].listeners.get("before-mouse-event")?.(event, { type: "mouseDown", button: "left", x: 200, y: 100 });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(interactions).toEqual([{ botId: "bot-a", profile: "" }]);
  });

  it("shields the inertial tail of a compact wheel gesture after expansion", () => {
    const interactions = [];
    const { manager, views } = harness({ onUserInteraction: (event) => interactions.push(event) });
    manager.layout("bot-a", BOUNDS, "", "compact");

    const first = { preventDefault: vi.fn() };
    views[0].listeners.get("before-mouse-event")?.(first, { type: "mouseWheel", deltaY: 120 });
    manager.layout("bot-a", { x: 0, y: 0, width: 900, height: 650 }, "", "expanded");
    const inertia = { preventDefault: vi.fn() };
    views[0].listeners.get("before-mouse-event")?.(inertia, { type: "mouseWheel", deltaY: 80 });

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(inertia.preventDefault).toHaveBeenCalledOnce();
    expect(interactions).toEqual([{ botId: "bot-a", profile: "" }]);
  });

  it("preserves the originating profile on terminal surface events", () => {
    const { manager, views, states } = harness();
    manager.layout("bot-a", BOUNDS, "work", "compact");
    views[0].listeners.get("render-process-gone")?.();

    expect(states.at(-1)).toMatchObject({
      botId: "bot-a",
      open: false,
      profile: "work",
      partition: "persist:openmausbot-browser-profile-work",
      mode: "compact",
      code: "renderer-gone",
    });
  });

  it("does not shield synthetic agent clicks in the compact surface", async () => {
    const interactions = [];
    const { manager, views } = harness({ onUserInteraction: (event) => interactions.push(event) });
    manager.layout("bot-a", BOUNDS, "", "compact");
    await manager.navigate("bot-a", "https://example.com");
    await manager.click("bot-a", "b11");
    const pressed = cdpCalls(views[0]).findLast(([name, params]) =>
      name === "Input.dispatchMouseEvent" && params.type === "mousePressed")[1];
    const event = { preventDefault: vi.fn() };
    views[0].listeners.get("before-mouse-event")?.(event, {
      type: "mouseDown",
      button: pressed.button,
      x: pressed.x,
      y: pressed.y,
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(interactions).toEqual([]);
    expect(manager.controlLease("bot-a", "")).toMatchObject({ held: false });
  });

  it("does not mistake a just-finished CDP input event for a human click", async () => {
    const interactions = [];
    const { manager, views } = harness({ onUserInteraction: (event) => interactions.push(event) });
    await manager.navigate("bot-a", "https://example.com");
    await manager.click("bot-a", "b11");
    views[0].listeners.get("before-mouse-event")?.({}, { type: "mouseDown" });
    expect(interactions).toEqual([]);
    await expect(manager.read("bot-a")).resolves.toMatchObject({ title: "Loaded" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    views[0].listeners.get("before-mouse-event")?.({}, { type: "mouseDown" });
    expect(interactions).toEqual([{ botId: "bot-a", profile: "" }]);
    manager.setHumanControl("bot-a", false, "");
    await expect(manager.read("bot-a")).rejects.toThrow(/browser_read is unavailable/);
  });

  it("does not swallow a real user click at a different point during the synthetic echo window", async () => {
    const interactions = [];
    const { manager, views } = harness({ onUserInteraction: (event) => interactions.push(event) });
    await manager.navigate("bot-a", "https://example.com");
    await manager.click("bot-a", "b11");
    // Agent click was at 60,40. A real native click elsewhere arriving inside
    // 100ms is not an echo and must take control immediately.
    views[0].listeners.get("before-mouse-event")?.({}, { type: "mouseDown", button: "left", x: 400, y: 300 });
    expect(interactions).toEqual([{ botId: "bot-a", profile: "" }]);
  });

  it.each(["mouseDown", "contextMenu"])("taints an autofill-copy-clear page after a human %s", async (type) => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");

    // Model a hostile pointer handler copying an autofilled password into
    // ordinary page text/title and clearing the protected source immediately.
    // A postflight protected-field scan alone can no longer see the secret.
    views[0].setProtectedScreenshotValue(true);
    manager.setHumanControl("bot-a", true, "");
    views[0].listeners.get("before-mouse-event")?.({}, {
      type,
      button: type === "mouseDown" ? "left" : "right",
      x: 400,
      y: 300,
    });
    views[0].setProtectedScreenshotValue(false);
    views[0].setPageText("copied autofill-secret");
    views[0].setTitle("cleared autofill-secret");
    manager.setHumanControl("bot-a", false, "");

    await expect(manager.read("bot-a")).rejects.toThrow(/browser_read is unavailable/);
    const snapshot = await manager.snapshot("bot-a");
    expect(snapshot).toMatchObject({ title: "Protected content hidden", elements: [] });
    expect(JSON.stringify(snapshot)).not.toContain("autofill-secret");
  });

  it("stops a multi-step agent action after a fast take-control and hand-back", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    const original = views[0].webContents.debugger.sendCommand;
    let resume;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let paused = false;
    views[0].webContents.debugger.sendCommand = async (method, params) => {
      if (!paused && method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
        paused = true;
        markStarted();
        await new Promise((resolve) => { resume = resolve; });
      }
      return original(method, params);
    };
    const pending = manager.click("bot-a", "b11");
    await started;
    manager.setHumanControl("bot-a", true);
    manager.setHumanControl("bot-a", false);
    resume();
    await expect(pending).rejects.toThrow(/control changed/);
    const laterInput = cdpCalls(views[0]).filter(([name, params]) =>
      name === "Input.dispatchMouseEvent" && ["mousePressed", "mouseReleased"].includes(params.type));
    expect(laterInput).toEqual([]);
  });

  it("stops a paused agent action when its turn capability is revoked", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    const original = views[0].webContents.debugger.sendCommand;
    let resume;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let paused = false;
    views[0].webContents.debugger.sendCommand = async (method, params) => {
      if (!paused && method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
        paused = true;
        markStarted();
        await new Promise((resolve) => { resume = resolve; });
      }
      return original(method, params);
    };
    const pending = manager.click("bot-a", "b11");
    await started;
    manager.cancelAgentActions("bot-a");
    resume();
    await expect(pending).rejects.toThrow(/turn ended/);
    expect(cdpCalls(views[0]).some(([name, params]) =>
      name === "Input.dispatchMouseEvent" && params.type === "mousePressed")).toBe(false);
  });

  it("neutralizes an in-flight mouse-down before leaving control with the user", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    const original = views[0].webContents.debugger.sendCommand;
    let resume;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let paused = false;
    views[0].webContents.debugger.sendCommand = async (method, params) => {
      const result = await original(method, params);
      if (!paused && method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
        paused = true;
        markStarted();
        await new Promise((resolve) => { resume = resolve; });
      }
      return result;
    };
    const pending = manager.click("bot-a", "b11");
    await started;
    manager.setHumanControl("bot-a", true);
    resume();
    await expect(pending).rejects.toThrow(/held by the user|control changed/);
    const mouse = cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent").map(([, params]) => params.type);
    expect(mouse).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  it("marks a revocation key release synthetic instead of claiming human control", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    const original = views[0].webContents.debugger.sendCommand;
    let resume;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let paused = false;
    views[0].webContents.debugger.sendCommand = async (method, params) => {
      const result = await original(method, params);
      if (!paused && method === "Input.dispatchKeyEvent" && params?.type === "keyDown") {
        paused = true;
        markStarted();
        await new Promise((resolve) => { resume = resolve; });
      } else if (method === "Input.dispatchKeyEvent" && params?.type === "keyUp") {
        // Electron emits this for debugger-dispatched key events. The
        // neutralizer's synthetic echo must consume it while held=false.
        views[0].listeners.get("before-input-event")?.({}, { type: "keyUp", key: params.key });
      }
      return result;
    };
    const pending = manager.press("bot-a", "Enter", "");
    await started;
    manager.cancelAgentActions("bot-a");
    resume();
    await expect(pending).rejects.toThrow(/turn ended/);
    expect(manager.controlLease("bot-a", "")).toMatchObject({ held: false });
    expect(cdpCalls(views[0]).filter(([method, params]) =>
      method === "Input.dispatchKeyEvent" && params.type === "keyUp")).toHaveLength(1);
  });

  it("hovers, drags, and chooses select options through the page", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await manager.hover("bot-a", "b11");
    expect(cdpCalls(views[0]).filter(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseMoved")).toHaveLength(1);
    await manager.drag("bot-a", "b11", "b13");
    const dragMoves = cdpCalls(views[0]).filter(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseMoved");
    expect(dragMoves.at(-1)[1]).toMatchObject({ x: 250, y: 40 });
    expect(cdpCalls(views[0]).filter(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseReleased").at(-1)[1]).toMatchObject({ x: 250, y: 40 });
    await manager.select("bot-a", "b13", "India");
    const call = cdpCalls(views[0]).find(([name]) => name === "Runtime.callFunctionOn")[1];
    expect(call.objectId).toBe("obj-13");
    expect(call.arguments).toEqual([{ value: ["India"] }]);
    await expect(manager.select("bot-a", "b13", [])).rejects.toThrow(/option value or label/);
  });

  it("fills a field by focusing it, selecting everything, and inserting text", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await manager.fill("bot-a", "b12", "running shoes");
    const all = cdpCalls(views[0]);
    const start = all.findIndex(([name]) => name === "DOM.focus");
    const sequence = all
      .slice(start)
      .filter(([name]) => name === "DOM.focus" || name.startsWith("Input."))
      .slice(0, 6)
      .map(([name, params]) => [name, params.type ?? params.text ?? params.backendNodeId]);
    expect(sequence).toEqual([
      ["DOM.focus", 12],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.insertText", "running shoes"],
    ]);
    // macOS select-all is ⌘A (modifier 4), not ^A
    expect(cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchKeyEvent" && params.key === "a")[1].modifiers).toBe(4);
  });

  it("refuses to fill or type into protected credential and payment fields", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    views[0].setSensitive("obj-12");
    await expect(manager.fill("bot-a", "b12", "super-secret")).rejects.toThrow(/require user control/);
    expect(cdpCalls(views[0]).some(([name, params]) => name === "Input.insertText" && params.text === "super-secret")).toBe(false);

    views[0].setSensitive("active-element");
    await expect(manager.type("bot-a", "123456")).rejects.toThrow(/require user control/);
    expect(cdpCalls(views[0]).some(([name, params]) => name === "Input.insertText" && params.text === "123456")).toBe(false);

    // A cross-origin iframe exposes only the top iframe as activeElement.
    // Unknown/custom focus fails closed instead of typing into a hidden card
    // or login field inside that frame.
    views[0].setFieldClassification("active-element", "unknown");
    await expect(manager.type("bot-a", "cannot-leak")).rejects.toThrow(/proven ordinary editable field/);
  });

  it("cannot submit or mutate a user-entered protected form through another action", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    views[0].setProtectedScreenshotValue(true);
    await expect(manager.click("bot-a", "b11")).rejects.toThrow(/protected .* field contains a value/);
    expect(cdpCalls(views[0]).some(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mousePressed")).toBe(false);

    views[0].setProtectedScreenshotValue(false);
    views[0].setSensitive("active-element");
    await expect(manager.press("bot-a", "Enter")).rejects.toThrow(/require user control/);
    await expect(manager.press("bot-a", "Backspace")).rejects.toThrow(/require user control/);
    expect(cdpCalls(views[0]).some(([name, params]) => name === "Input.dispatchKeyEvent" && ["Enter", "Backspace"].includes(params.key))).toBe(false);
  });

  it("rechecks focus during fill so a page cannot redirect typing into a protected field", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    // Explicit ref is ordinary; focus initially remains ordinary, then a page
    // key handler redirects the active target to a password/card field.
    views[0].queueFieldClassifications("active-element", ["ordinary", "sensitive"]);
    await expect(manager.fill("bot-a", "b12", "must-not-land")).rejects.toThrow(/require user control/);
    expect(cdpCalls(views[0]).some(([name, params]) => name === "Input.insertText" && params.text === "must-not-land")).toBe(false);
    expect(cdpCalls(views[0]).some(([name, params]) =>
      name === "Input.dispatchKeyEvent" && params.key === "Backspace" && params.type === "keyDown")).toBe(false);
  });

  it("presses named keys, scrolls the fixed viewport, and screenshots through the protocol", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await expect(manager.press("bot-a", "F13")).rejects.toThrow(/unsupported key/);
    await manager.press("bot-a", "Enter");
    const enter = cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchKeyEvent" && params.key === "Enter" && params.type === "keyDown");
    expect(enter?.[1]).toMatchObject({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await manager.scroll("bot-a", "down");
    expect(cdpCalls(views[0]).findLast(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseMoved")?.[1])
      .toMatchObject({ x: 640, y: 400 });
    expect(cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseWheel")[1]).toMatchObject({ x: 640, y: 400, deltaX: 0, deltaY: 600 });
    await expect(manager.scroll("bot-a", "sideways")).rejects.toThrow(/direction/);
    const shot = await manager.screenshot("bot-a");
    expect(shot).toMatchObject({ format: "jpeg", width: 1024, height: 640, png: Buffer.from("cdp-jpeg").toString("base64") });
    expect(cdpCalls(views[0]).find(([name]) => name === "Page.captureScreenshot")[1].clip).toMatchObject({
      width: 1280,
      height: 800,
      scale: 0.4,
    });
  });

  it("normalizes a narrow capturePage fallback to the fixed screenshot size", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    const originalSendCommand = views[0].webContents.debugger.sendCommand;
    views[0].webContents.debugger.sendCommand = async (method, params) => {
      if (method === "Page.captureScreenshot") throw new Error("fixture protocol capture failure");
      return originalSendCommand(method, params);
    };
    const resize = vi.fn(({ width, height }) => ({
      getSize: () => ({ width, height }),
      toJPEG: () => Buffer.from("fallback-jpeg"),
    }));
    views[0].webContents.capturePage = async () => ({
      getSize: () => ({ width: 400, height: 250 }),
      resize,
      toJPEG: () => Buffer.from("unscaled-jpeg"),
    });

    await expect(manager.screenshot("bot-a")).resolves.toMatchObject({
      format: "jpeg",
      width: 1024,
      height: 640,
      png: Buffer.from("fallback-jpeg").toString("base64"),
    });
    expect(resize).toHaveBeenCalledWith({ width: 1024, height: 640 });
  });

  it("uses normalized native capture on Linux without issuing a hanging CDP screenshot", async () => {
    const { manager, views } = harness({ platform: "linux" });
    manager.layout("bot-a", { x: 10, y: 20, width: 820, height: 600 }, "", "expanded");
    await manager.navigate("bot-a", "https://example.com");
    const resize = vi.fn(({ width, height }) => ({
      getSize: () => ({ width, height }),
      toJPEG: () => Buffer.from("linux-native-jpeg"),
    }));
    views[0].webContents.capturePage = vi.fn(async () => ({
      getSize: () => ({ width: 400, height: 250 }),
      resize,
      toJPEG: () => Buffer.from("unscaled-jpeg"),
    }));

    await expect(manager.screenshot("bot-a")).resolves.toMatchObject({
      format: "jpeg",
      width: 1024,
      height: 640,
      png: Buffer.from("linux-native-jpeg").toString("base64"),
    });
    expect(cdpCalls(views[0]).some(([name]) => name === "Page.captureScreenshot")).toBe(false);
    expect(views[0].webContents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 820, height: 513 });
    expect(resize).toHaveBeenCalledWith({ width: 1024, height: 640 });
  });

  it("refuses screenshots with populated protected fields and discards captures that overlap takeover", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    views[0].setProtectedScreenshotValue(true);
    await expect(manager.screenshot("bot-a")).rejects.toThrow(/protected field contains a value/);
    expect(cdpCalls(views[0]).some(([name]) => name === "Page.captureScreenshot")).toBe(false);

    views[0].setProtectedScreenshotValue(false);
    const original = views[0].webContents.debugger.sendCommand;
    let resume;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    views[0].webContents.debugger.sendCommand = async (method, params) => {
      if (method === "Page.captureScreenshot") {
        markStarted();
        await new Promise((resolve) => { resume = resolve; });
      }
      return original(method, params);
    };
    const pending = manager.screenshot("bot-a");
    await started;
    manager.setHumanControl("bot-a", true);
    manager.setHumanControl("bot-a", false);
    resume();
    await expect(pending).rejects.toThrow(/control changed/);
  });

  it("fails observations closed while protected or human-typed page text could echo a secret", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    views[0].setProtectedScreenshotValue(true);
    views[0].setPageText("mirrored fixture-secret");
    views[0].setTitle("fixture-secret");
    await expect(manager.read("bot-a")).rejects.toThrow(/browser_read is unavailable/);
    const protectedPage = await manager.snapshot("bot-a");
    expect(protectedPage).toMatchObject({ url: "", title: "Protected content hidden", yaml: null, elements: [] });
    await expect(manager.agentState("bot-a", "")).resolves.toMatchObject({ url: "", title: "Protected content hidden" });
    expect(JSON.stringify(protectedPage)).not.toContain("fixture-secret");

    views[0].setProtectedScreenshotValue(false);
    manager.setHumanControl("bot-a", true, "");
    views[0].listeners.get("before-input-event")?.({}, { type: "keyDown", key: "x" });
    manager.setHumanControl("bot-a", false, "");
    await expect(manager.read("bot-a")).rejects.toThrow(/browser_read is unavailable/);
    expect(await manager.snapshot("bot-a")).toMatchObject({ title: "Protected content hidden", elements: [] });

    // Only a committed document navigation clears the conservative taint.
    views[0].listeners.get("did-navigate")?.();
    views[0].setPageText("safe page");
    views[0].setTitle("Safe");
    await expect(manager.read("bot-a")).resolves.toMatchObject({ title: "Safe", text: "safe page" });
  });

  it("waits for text or an address, reads the page, and reports dialogs it answered", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    const read = await manager.read("bot-a");
    expect(read).toMatchObject({ url: "https://example.com/", text: "Welcome. Docs Search", truncated: false });
    const textExtraction = cdpCalls(views[0]).find(([name, params]) =>
      name === "Runtime.evaluate" && String(params.expression).includes("root.innerText"));
    expect(textExtraction?.[1].expression).toContain("__ombSensitiveField");
    expect(textExtraction?.[1].expression).toContain("[redacted]");
    await expect(manager.waitFor("bot-a", { text: "Docs" })).resolves.toMatchObject({ url: "https://example.com/" });
    await expect(manager.waitFor("bot-a", { text: "never there", timeoutMs: 300 })).rejects.toThrow(/timed out waiting for text "never there"/);
    await expect(manager.waitFor("bot-a", { url: "example.com" })).resolves.toBeTruthy();
    // a JS dialog is answered by the surface and surfaces in the next result
    views[0].debuggerListeners.get("message")?.({}, "Page.javascriptDialogOpening", { type: "confirm", message: "fixture-secret" });
    await vi.waitFor(() => {
      expect(cdpCalls(views[0])).toContainEqual(["Page.handleJavaScriptDialog", { accept: false }]);
    });
    views[0].debuggerListeners.get("message")?.({}, "Page.fileChooserOpened", {});
    await vi.waitFor(() => {
      expect(cdpCalls(views[0])).toContainEqual(["Page.handleFileChooser", { action: "cancel" }]);
    });
    const page = await manager.snapshot("bot-a");
    expect(page.dialogs).toEqual([
      { type: "confirm", message: "", accepted: false },
      { type: "filechooser", message: "the page asked for a file upload; uploads are not supported yet", accepted: false },
    ]);
    expect(page.text).toContain("Dialog (confirm) was dismissed automatically; its page-supplied text was hidden.");
    expect(page.text).not.toContain("fixture-secret");
    expect((await manager.snapshot("bot-a")).dialogs).toEqual([]);
  });

  it("removes the did-stop-loading listener when the bounded settle timer wins", async () => {
    const { manager, views } = harness({ loadWaitMs: 5 });
    manager.ensure("bot-a", "");
    views[0].setLoading(true);
    await manager.snapshot("bot-a");
    expect(views[0].listeners.has("did-stop-loading")).toBe(false);
  });

  it("uses Playwright's snapshot with e-refs when the page carries the script, injecting it once per document", async () => {
    const { manager, views } = harness({ injectedSource: "/*injected*/" });
    const page = await manager.navigate("bot-a", "https://example.com");
    expect(page.yaml).toBe('- heading "Docs" [ref=e1]\n- textbox "Search" [ref=e2]');
    expect(page.text).toContain('[ref=e1]');
    expect(page.elements).toEqual([]);
    // injected exactly once, then reused
    const injections = views[0].calls.filter(([name, params]) => name === "Runtime.evaluate" && params.expression === "/*injected*/");
    expect(injections).toHaveLength(1);
    await manager.snapshot("bot-a");
    expect(views[0].calls.filter(([name, params]) => name === "Runtime.evaluate" && params.expression === "/*injected*/")).toHaveLength(1);
    // clicks resolve through the page, at the element's centre
    await manager.click("bot-a", "e1");
    const pressed = cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mousePressed")[1];
    expect(pressed).toMatchObject({ x: 77, y: 33 });
    await expect(manager.click("bot-a", "e9")).rejects.toThrow(/stale or unknown/);
    await expect(manager.click("bot-a", "b11")).rejects.toThrow(/stale or unknown/);
    // fill focuses through the page; select resolves the element handle through the page
    await manager.fill("bot-a", "e2", "shoes");
    expect(cdpCalls(views[0]).some(([name]) => name === "DOM.focus")).toBe(false);
    await manager.select("bot-a", "e2", "India");
    expect(cdpCalls(views[0]).find(([name]) => name === "Runtime.callFunctionOn")[1].objectId).toBe("obj-e1");
    // no bundle → the bare accessibility tree with b-refs
    const bare = harness({ injectedSource: null });
    const fallback = await bare.manager.navigate("bot-a", "https://example.com");
    expect(fallback.yaml).toBeNull();
    expect(fallback.elements.map((element) => element.ref)).toEqual(["b11", "b12", "b13"]);
  });

  it("revalidates rich refs and compositor hit targets in the isolated helper", async () => {
    const { manager, views } = harness({ injectedSource: "/*injected*/" });
    await manager.navigate("bot-a", "https://example.com");
    views[0].setRichRefValid(false);
    await expect(manager.click("bot-a", "e1")).rejects.toThrow(/stale because the page changed/);

    views[0].setRichRefValid(true);
    await manager.snapshot("bot-a");
    views[0].setRichHit(false);
    await expect(manager.click("bot-a", "e1")).rejects.toThrow(/covers that ref/);
    expect(cdpCalls(views[0]).some(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mousePressed")).toBe(false);
  });

  it("runs every page helper in a CDP isolated world and ignores a hostile page global", async () => {
    const { manager, views } = harness({ injectedSource: "/*injected*/" });
    manager.ensure("bot-a", "");
    views[0].spoofMainWorldBrowserHelper();
    const page = await manager.navigate("bot-a", "https://example.com");
    expect(page.yaml).toContain("[ref=e1]");
    const helperCalls = cdpCalls(views[0]).filter(([name]) => name === "Runtime.evaluate");
    expect(helperCalls.length).toBeGreaterThan(0);
    expect(helperCalls.every(([, params]) => params.contextId === 42)).toBe(true);
    expect(helperCalls.some(([, params]) => params.expression === "/*injected*/")).toBe(true);
    expect(cdpCalls(views[0])).toContainEqual([
      "Page.createIsolatedWorld",
      { frameId: "main-frame", worldName: "openmausbot-browser-snapshot", grantUniveralAccess: false },
    ]);
  });

  it("drops every bot's view on a deleted profile and leaves other sessions alone", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "work", "compact");
    manager.layout("bot-b", BOUNDS, "work", "compact");
    manager.layout("bot-c", BOUNDS, "", "compact");
    expect(manager.forgetProfile("work")).toBe(2);
    expect(manager.size()).toBe(1);
    expect(views[2].calls.some(([name]) => name === "close")).toBe(false);
    expect(manager.state("bot-a")).toMatchObject({ open: false });
    expect(manager.forgetProfile(GUEST_PROFILE)).toBe(0);
    expect(manager.forgetProfile("")).toBe(0);
  });

  it("accepts exact migrated partitions but refuses lossy aliases", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "work", "compact");
    manager.layout("bot-b", BOUNDS, "Work", "compact");
    expect(manager.size()).toBe(2);
    expect(manager.forgetProfile("Work")).toBe(1);
    for (const alias of ["work!", "../work"]) {
      expect(() => manager.layout("bot-b", BOUNDS, alias, "compact")).toThrow(/valid browser profile partition id/);
      expect(() => manager.setCapabilityActive("bot-b", alias, true)).toThrow(/valid browser profile partition id/);
      expect(() => manager.forgetProfile(alias)).toThrow(/valid browser profile partition id/);
    }
    expect(manager.size()).toBe(1);
    expect(manager.forgetProfile("work")).toBe(1);
    expect(views[0].calls.some(([name]) => name === "close")).toBe(true);
  });

  it("tears every view down on closeAll and hides them all on hideAll", async () => {
    const { manager, owner, views, states } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    manager.layout("bot-b", BOUNDS, "", "compact");
    expect(manager.size()).toBe(2);
    manager.hideAll();
    expect(views.map((view) => view.visible)).toEqual([false, false]);
    manager.close("bot-a");
    expect(manager.size()).toBe(1);
    manager.closeAll();
    expect(manager.size()).toBe(0);
    expect(owner.contentView.children).toEqual([]);
    expect(states.at(-1)).toMatchObject({ botId: "bot-b", open: false });
  });
});
