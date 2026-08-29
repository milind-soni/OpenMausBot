"use strict";

process.stdout.write("fixture-entered\n");
const { once } = require("node:events");
const { app, BrowserWindow, WebContentsView } = require("electron");
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

async function run() {
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 });
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
    const html = `<!doctype html><html><body><closed-login></closed-login><script>
      customElements.define("closed-login", class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: "closed" });
          this._closedRoot = root;
          const label = document.createElement("label");
          label.htmlFor = "credential";
          label.textContent = "API key";
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
    const protectedValues = ["sk_closed_shadow_must_not_reach_pixels", "closed shadow mnemonic must stay private"];
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

    const actionHtml = `<!doctype html><html><body>
      <button id="reviewed" style="position:fixed;left:40px;top:40px;width:180px;height:60px">Publish draft</button>
      <input id="empty-password" type="password" aria-label="Password">
      <div id="empty-secret-editor" role="textbox" contenteditable="true" aria-label="Signing key"></div>
    </body></html>`;
    await browserView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(actionHtml)}`);
    const actionSnapshot = await manager.snapshot("fixture-bot", "");
    const reviewedRef = String(actionSnapshot.yaml ?? "").match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
    if (!reviewedRef) throw new Error("real Electron fixture did not produce a rich browser ref");
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
