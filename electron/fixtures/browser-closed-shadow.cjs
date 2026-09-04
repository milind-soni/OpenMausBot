"use strict";

process.stdout.write("fixture-entered\n");
const { once } = require("node:events");
const { join } = require("node:path");
const { app, BrowserWindow, WebContentsView, nativeImage } = require("electron");
const { createBrowserSurfaceManager } = require("../browser-surface.cjs");
process.stdout.write("fixture-modules-loaded\n");

// Linux CI runs under Xvfb as root. The dedicated Windows fixture job receives
// the restricted-package filesystem ACL it needs from the test wrapper and
// otherwise launches Electron with its production sandbox defaults intact.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
}

async function waitForLifecycleEvent(emitter, event, label, timeoutMs = 2_000) {
  try {
    await once(emitter, event, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Timed out waiting for ${label} to emit ${event}`);
    throw error;
  }
}

async function waitForFixedViewport(browserView, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let viewport = null;
  do {
    viewport = await browserView.webContents.executeJavaScript(`({ width: innerWidth, height: innerHeight })`);
    if (viewport.width === 1280 && viewport.height === 800) return viewport;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`${label} viewport was not fixed: ${JSON.stringify(viewport)}`);
}

// Only Linux moves a nested scroller synchronously from the isolated world;
// everywhere else browser_scroll dispatches a real mouseWheel, which CDP
// acknowledges as soon as it is routed and the compositor applies a frame or
// more later. A fixed settle therefore races a loaded runner — macOS CI has
// read the pre-scroll 0px twice — so poll for the offset the way the viewport
// above is polled for. Only the assertions that expect movement can wait like
// this: a scroll that must NOT happen still needs a fixed settle.
async function waitForScrollTop(browserView, selector, expected, label, timeoutMs = 2_000) {
  const read = `document.querySelector(${JSON.stringify(selector)}).scrollTop`;
  const deadline = Date.now() + timeoutMs;
  let scrollTop = null;
  do {
    scrollTop = await browserView.webContents.executeJavaScript(read);
    if (scrollTop === expected) return scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`${label} moved ${scrollTop}px instead of ${expected}px`);
}

async function closeFixture(manager, browserView, owner) {
  const viewContents = browserView?.webContents;
  const viewDestroyed = viewContents && !viewContents.isDestroyed()
    ? waitForLifecycleEvent(viewContents, "destroyed", "browser WebContents")
    : Promise.resolve();
  manager.closeAll();
  try {
    await viewDestroyed;
  } finally {
    if (!owner.isDestroyed()) {
      const ownerClosed = waitForLifecycleEvent(owner, "closed", "owner BrowserWindow");
      owner.destroy();
      await ownerClosed;
    }
  }
}

async function verifySandboxedPreload() {
  const probe = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "..", "preload.cjs"),
      sandbox: true,
    },
  });
  try {
    await probe.loadURL("data:text/html,<title>preload probe</title>");
    const exposed = await probe.webContents.executeJavaScript(`({
      ogb: typeof window.ogb,
      platform: window.ogb?.platform,
      browser: typeof window.ogb?.browser,
    })`);
    const expectedBrowser = process.platform === "win32" ? "undefined" : "object";
    if (exposed.ogb !== "object" || exposed.platform !== process.platform || exposed.browser !== expectedBrowser) {
      throw new Error(`sandboxed preload bridge was not exposed correctly: ${JSON.stringify(exposed)}`);
    }
    process.stdout.write("sandboxed-preload-bridge-loaded\n");
  } finally {
    if (!probe.isDestroyed()) probe.destroy();
  }
}

async function run() {
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 });
  // Keep the fixture's owner alive while the one-shot preload probe closes;
  // otherwise Electron may treat it as the last window and quit before the
  // browser-surface assertions start.
  await verifySandboxedPreload();
  let browserView = null;
  const manager = createBrowserSurfaceManager({
    owner,
    createView: (options) => {
      browserView = new WebContentsView(options);
      return browserView;
    },
    settleMs: 0,
    loadWaitMs: 1_000,
  });
  try {
    manager.ensure("fixture-bot", "");
    manager.layout("fixture-bot", { x: 20, y: 30, width: 400, height: 250 }, "", "compact");
    const html = `<!doctype html><html><body><closed-login></closed-login><script>
      customElements.define("closed-login", class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: "closed" });
          this._closedRoot = root;
          const label = document.createElement("label");
          label.htmlFor = "credential";
          label.append("API key ");
          const nestedLabelControl = document.createElement("span");
          nestedLabelControl.setAttribute("role", "button");
          nestedLabelControl.setAttribute("aria-label", ["sk_nested_name_", "source_must_stay_private"].join(""));
          nestedLabelControl.textContent = ["nested contributor ", "text must stay private"].join("");
          label.append(nestedLabelControl);
          const input = document.createElement("input");
          input.id = "credential";
          input.name = "credential";
          input.value = "sk_closed_shadow_must_not_reach_pixels";
          const phrase = document.createElement("div");
          phrase.setAttribute("role", "textbox");
          phrase.setAttribute("contenteditable", "true");
          phrase.setAttribute("aria-label", "Recovery phrase");
          phrase.textContent = "closed shadow mnemonic must stay private";
          const action = document.createElement("button");
          action.textContent = "Continue safely";
          const echo = document.createElement("div");
          echo.id = "echo";
          input.addEventListener("input", () => {
            const transformed = btoa(input.value || "empty");
            echo.textContent = transformed;
            document.title = transformed.split("").reverse().join("");
            input.value = "";
          });
          root.append(label, input, phrase, echo, action);
        }
        clearProtectedFields() {
          this._closedRoot.querySelector("input").value = "";
          this._closedRoot.querySelector('[role="textbox"]').textContent = "";
        }
        focusCredential() { this._closedRoot.querySelector("input").focus(); }
      });
    </script></body></html>`;
    await browserView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await waitForFixedViewport(browserView, "compact browser after navigation");
    process.stdout.write("compact-viewport-stable-after-navigation\n");
    const protectedValues = [
      "sk_closed_shadow_must_not_reach_pixels",
      "closed shadow mnemonic must stay private",
      "sk_nested_name_source_must_stay_private",
      "nested contributor text must stay private",
    ];
    let readRefused = false;
    try {
      await manager.read("fixture-bot", "");
    } catch (error) {
      readRefused = /browser_read is unavailable/.test(String(error?.message ?? error));
    }
    if (!readRefused) throw new Error("closed-shadow protected text was not refused by browser_read");
    const protectedSnapshot = await manager.snapshot("fixture-bot", "");
    if (protectedSnapshot.title !== "Protected content hidden" || protectedSnapshot.elements.length !== 0) {
      throw new Error("protected closed-shadow snapshot was not genericized");
    }
    if (protectedValues.some(value => JSON.stringify(protectedSnapshot).includes(value))) {
      throw new Error("closed-shadow protected value leaked through generic snapshot");
    }
    let refused = false;
    try {
      await manager.screenshot("fixture-bot", "");
    } catch (error) {
      refused = /protected field contains a value/.test(String(error?.message ?? error));
    }
    if (!refused) throw new Error("closed-shadow protected input was not refused");
    process.stdout.write("closed-shadow-screenshot-refused\n");

    // With protected values cleared, any ordinary closed-shadow control must
    // still be represented through the conservative AX fallback.
    await browserView.webContents.executeJavaScript(`document.querySelector("closed-login").clearProtectedFields()`);
    const safeClosedSnapshot = await manager.snapshot("fixture-bot", "");
    if (!safeClosedSnapshot.elements.some(element => element.role === "button")) {
      throw new Error("closed-shadow interactive control was omitted from the AX fallback");
    }
    const nestedProtectedValues = [
      "sk_nested_name_source_must_stay_private",
      "nested contributor text must stay private",
    ];
    if (nestedProtectedValues.some(value => JSON.stringify(safeClosedSnapshot).includes(value))) {
      throw new Error("nested protected accessible-name contributor leaked after values were cleared");
    }
    process.stdout.write("closed-shadow-nested-name-source-redacted\n");

    // A hostile page can transform a human-entered password into sibling
    // text/title and clear the input before a postflight DOM scan. Native
    // human keyboard input taints the document until committed navigation,
    // so no transformed output becomes model-facing even after the field is
    // empty and exact-string redaction would be insufficient.
    manager.setHumanControl("fixture-bot", true, "");
    await browserView.webContents.executeJavaScript(`document.querySelector("closed-login").focusCredential()`);
    browserView.webContents.focus();
    browserView.webContents.sendInputEvent({ type: "keyDown", keyCode: "x" });
    browserView.webContents.sendInputEvent({ type: "char", keyCode: "x" });
    browserView.webContents.sendInputEvent({ type: "keyUp", keyCode: "x" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const transformedTitle = browserView.webContents.getTitle();
    if (!transformedTitle || transformedTitle === "Protected content hidden") {
      throw new Error("fixture did not transform the human-entered value into document.title");
    }
    manager.setHumanControl("fixture-bot", false, "");
    let taintedReadRefused = false;
    try {
      await manager.read("fixture-bot", "");
    } catch (error) {
      taintedReadRefused = /browser_read is unavailable/.test(String(error?.message ?? error));
    }
    if (!taintedReadRefused) throw new Error("transformed-and-cleared human input was readable after hand-back");
    const taintedSnapshot = await manager.snapshot("fixture-bot", "");
    if (taintedSnapshot.title !== "Protected content hidden" || JSON.stringify(taintedSnapshot).includes(transformedTitle)) {
      throw new Error("transformed human input escaped the document taint boundary");
    }
    process.stdout.write("transformed-secret-taint\n");

    // Exercise the injected Playwright snapshot on an ordinary open-DOM page.
    // The closed-shadow document above deliberately takes the conservative AX
    // fallback, so it cannot prove that nested accessible-name contributors
    // are redacted by the rich snapshot implementation itself.
    const richSnapshotHtml = `<!doctype html><html><body>
      <label id="credential-label" for="credential">
        API key
        <span id="nested-name-source" role="button" tabindex="0"></span>
      </label>
      <input id="credential" type="password" value="">
      <button id="ordinary-action">Ordinary action</button>
      <script>
        const nestedNameSource = document.getElementById("nested-name-source");
        nestedNameSource.setAttribute("aria-label", ["sk_rich_nested_", "name_source_private"].join(""));
        nestedNameSource.textContent = ["rich nested contributor ", "text private"].join("");
      </script>
    </body></html>`;
    await browserView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(richSnapshotHtml)}`);
    const richSnapshot = await manager.snapshot("fixture-bot", "");
    if (Object.prototype.toString.call(richSnapshot.yaml) !== "[object String]" || !/\[ref=e\d+\]/.test(richSnapshot.yaml)) {
      throw new Error("open-DOM fixture did not run the rich injected browser snapshot");
    }
    if (richSnapshot.elements.length !== 0 || /\[ref=b\d+\]/.test(richSnapshot.yaml)) {
      throw new Error("open-DOM fixture unexpectedly used the conservative AX fallback");
    }
    if (!/button "protected field label" \[ref=e\d+\]/.test(richSnapshot.yaml)) {
      throw new Error("rich snapshot did not retain the nested name contributor in redacted form");
    }
    if (!/button "Ordinary action" \[ref=e\d+\]/.test(richSnapshot.yaml)) {
      throw new Error("rich snapshot did not expose an ordinary open-DOM action");
    }
    const richProtectedValues = [
      "sk_rich_nested_name_source_private",
      "rich nested contributor text private",
    ];
    if (richProtectedValues.some(value => JSON.stringify(richSnapshot).includes(value))) {
      throw new Error("nested protected accessible-name contributor leaked through the rich snapshot");
    }
    process.stdout.write("rich-nested-name-source-redacted\n");

    const actionHtml = `<!doctype html><html><head><style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      #scroller { width: 100vw; height: 100vh; overflow: auto; }
      #scroll-content { min-height: 2400px; }
    </style></head><body>
      <main id="scroller"><div id="scroll-content"></div></main>
      <button id="reviewed" style="position:fixed;left:40px;top:40px;width:180px;height:60px">Publish draft</button>
      <input id="empty-password" type="password" aria-label="Password">
      <div id="empty-secret-editor" role="textbox" contenteditable="true" aria-label="Signing key"></div>
      <script>
        window.actionEvents = [];
        const reviewed = document.getElementById("reviewed");
        for (const type of ["click", "dblclick"]) reviewed.addEventListener(type, event => {
          window.actionEvents.push({ type, detail: event.detail, x: event.clientX, y: event.clientY });
        });
      </script>
    </body></html>`;
    await browserView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(actionHtml)}`);
    const actionSnapshot = await manager.snapshot("fixture-bot", "");
    const reviewedRef = String(actionSnapshot.yaml ?? "").match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
    if (!reviewedRef) throw new Error("real Electron fixture did not produce a rich browser ref");
    manager.setHumanControl("fixture-bot", false, "");

    // CDP DOM boxes are in the fixed 1280x800 page viewport, while Electron's
    // native device-emulation scale expects pointer positions in the smaller
    // WebContentsView. Exercise real compositor dispatch in both modes: this
    // failed silently before page coordinates were converted for the current
    // presentation scale.
    await waitForFixedViewport(browserView, "compact action");
    await manager.click("fixture-bot", reviewedRef, { profile: "" });
    let actionEvents = await browserView.webContents.executeJavaScript(`window.actionEvents`);
    if (JSON.stringify(actionEvents) !== JSON.stringify([{ type: "click", detail: 1, x: 130, y: 70 }])) {
      throw new Error(`compact known-coordinate click missed its target: ${JSON.stringify(actionEvents)}`);
    }
    process.stdout.write("compact-known-coordinate-click\n");

    await manager.scroll("fixture-bot", "down", 600, "");
    await waitForScrollTop(browserView, "#scroller", 600, "compact nested scroll");
    await browserView.webContents.executeJavaScript(`document.getElementById("scroller").scrollTop = 0`);
    process.stdout.write("compact-known-coordinate-scroll\n");

    const compactShot = await manager.screenshot("fixture-bot", "");
    const compactShotSize = nativeImage.createFromBuffer(Buffer.from(compactShot.png, "base64")).getSize();
    if (compactShot.width !== 1024 || compactShot.height !== 640
      || compactShotSize.width !== compactShot.width || compactShotSize.height !== compactShot.height) {
      throw new Error(`compact screenshot pixels disagree with metadata: ${JSON.stringify({ metadata: [compactShot.width, compactShot.height], encoded: compactShotSize })}`);
    }

    manager.layout("fixture-bot", { x: 10, y: 20, width: 820, height: 600 }, "", "expanded");
    await waitForFixedViewport(browserView, "expanded action");
    const expandedSnapshot = await manager.snapshot("fixture-bot", "");
    const expandedRef = String(expandedSnapshot.yaml ?? "").match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
    if (!expandedRef) throw new Error("expanded Electron fixture did not produce a rich browser ref");
    await manager.click("fixture-bot", expandedRef, { clickCount: 2, profile: "" });
    actionEvents = await browserView.webContents.executeJavaScript(`window.actionEvents`);
    const expectedEvents = [
      { type: "click", detail: 1, x: 130, y: 70 },
      { type: "click", detail: 1, x: 130, y: 70 },
      { type: "click", detail: 2, x: 130, y: 70 },
      { type: "dblclick", detail: 2, x: 130, y: 70 },
    ];
    if (JSON.stringify(actionEvents) !== JSON.stringify(expectedEvents)) {
      throw new Error(`expanded double-click sequence was incorrect: ${JSON.stringify(actionEvents)}`);
    }
    process.stdout.write("expanded-known-coordinate-click\n");
    process.stdout.write("real-double-click-sequence\n");

    await manager.scroll("fixture-bot", "down", 300, "");
    await waitForScrollTop(browserView, "#scroller", 300, "expanded nested scroll");
    process.stdout.write("expanded-known-coordinate-scroll\n");

    const expandedShot = await manager.screenshot("fixture-bot", "");
    const expandedShotSize = nativeImage.createFromBuffer(Buffer.from(expandedShot.png, "base64")).getSize();
    if (expandedShot.width !== 1024 || expandedShot.height !== 640
      || expandedShotSize.width !== expandedShot.width || expandedShotSize.height !== expandedShot.height) {
      throw new Error(`expanded screenshot pixels disagree with metadata: ${JSON.stringify({ metadata: [expandedShot.width, expandedShot.height], encoded: expandedShotSize })}`);
    }
    process.stdout.write("fixed-screenshot-pixel-size\n");

    for (const [selector, key] of [["#empty-password", "Enter"], ["#empty-secret-editor", "Backspace"]]) {
      await browserView.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      manager.setHumanControl("fixture-bot", false, "");
      let protectedFocusRefused = false;
      try {
        await manager.press("fixture-bot", key, "");
      } catch (error) {
        protectedFocusRefused = /require user control/.test(String(error?.message ?? error));
      }
      if (!protectedFocusRefused) throw new Error(`focused protected field accepted ${key}`);
    }
    process.stdout.write("protected-focused-keys-refused\n");
    await browserView.webContents.executeJavaScript(`(() => {
      const overlay = document.createElement("button");
      overlay.id = "late-overlay";
      overlay.textContent = "Delete everything";
      Object.assign(overlay.style, { position: "fixed", left: "40px", top: "40px", width: "180px", height: "60px", zIndex: "99999", opacity: "0.01" });
      document.body.append(overlay);
    })()`);
    let overlayRefused = false;
    let overlayError = "";
    try {
      await manager.click("fixture-bot", reviewedRef);
    } catch (error) {
      overlayError = String(error?.message ?? error);
      overlayRefused = /covers that ref/.test(String(error?.message ?? error));
    }
    if (!overlayRefused) throw new Error(`late overlay was not refused before mouse-down: ${overlayError || "click unexpectedly succeeded"}`);
    process.stdout.write("late-overlay-click-refused\n");

    await browserView.webContents.executeJavaScript(`document.getElementById("late-overlay").remove()`);
    const relabelSnapshot = await manager.snapshot("fixture-bot", "");
    const relabelRef = String(relabelSnapshot.yaml ?? "").match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
    if (!relabelRef) throw new Error("real Electron fixture did not refresh its ref");
    await browserView.webContents.executeJavaScript(`document.getElementById("reviewed").textContent = "Delete account"`);
    let relabelRefused = false;
    try {
      await manager.click("fixture-bot", relabelRef);
    } catch (error) {
      relabelRefused = /stale because the page changed/.test(String(error?.message ?? error));
    }
    if (!relabelRefused) throw new Error("relabelled ref was not invalidated");
    process.stdout.write("relabelled-ref-refused\n");

    const lockedRootHtml = `<!doctype html><html style="overflow:hidden"><body style="margin:0;overflow:hidden">
      <div style="height:2400px">Locked page</div>
    </body></html>`;
    await browserView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(lockedRootHtml)}`);
    manager.setHumanControl("fixture-bot", false, "");
    await manager.scroll("fixture-bot", "down", 300, "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lockedScrollTop = await browserView.webContents.executeJavaScript(`document.scrollingElement.scrollTop`);
    if (lockedScrollTop !== 0) throw new Error(`browser_scroll bypassed a root scroll lock by ${lockedScrollTop}px`);
    process.stdout.write("root-scroll-lock-preserved\n");
  } finally {
    await closeFixture(manager, browserView, owner);
  }
}

app.whenReady()
  .then(() => {
    process.stdout.write("fixture-ready\n");
    return run();
  })
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    app.exit(1);
  });
