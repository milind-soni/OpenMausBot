/* oxlint-disable anti-slop/no-runtime-typeof -- CDP, DOM, and JSON are runtime I/O boundaries in this dependency-free browser harness. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const configPath = process.argv[2];
if (!configPath) throw new Error("product journey config path is required");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (!config || !["drive", "verify"].includes(config.mode) || typeof config.origin !== "string" || typeof config.outputDir !== "string" || typeof config.resultFile !== "string" || typeof config.browserExecutable !== "string" || typeof config.browserProfile !== "string") {
  throw new Error("product journey config is invalid");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function freePort() {
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CDP port probe failed");
  await new Promise((accept) => server.close(accept));
  return address.port;
}

async function waitForCdp(port, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) throw new Error(`isolated browser exited before CDP readiness (${child.exitCode})`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = Array.isArray(targets) ? targets.find((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string") : undefined;
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error("isolated browser did not expose CDP within 20 seconds");
}

function createCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data));
    if (typeof payload.id === "number") {
      const waiting = pending.get(payload.id);
      if (!waiting) return;
      pending.delete(payload.id);
      if (payload.error) waiting.reject(new Error(payload.error.message));
      else waiting.resolve(payload.result);
      return;
    }
    if (typeof payload.method === "string") {
      for (const listener of listeners.get(payload.method) ?? []) listener(payload.params ?? {});
    }
  });
  const opened = new Promise((accept, reject) => {
    socket.addEventListener("open", accept, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    opened,
    on(method, listener) {
      const current = listeners.get(method) ?? [];
      current.push(listener);
      listeners.set(method, current);
    },
    async send(method, params = {}) {
      await opened;
      const id = ++nextId;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, callback, argument) {
  const serialized = argument === undefined ? "undefined" : JSON.stringify(argument);
  const response = await cdp.send("Runtime.evaluate", {
    expression: `(${callback.toString()})(${serialized})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "renderer evaluation failed");
  return response.result?.value;
}

async function waitFor(cdp, callback, argument, label, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(cdp, callback, argument).catch(() => null);
    if (value) return value;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function activateVisibleControl(cdp, label) {
  const clicked = await evaluate(cdp, (text) => {
    const element = [...document.querySelectorAll("button, [role='button']")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const name = candidate.getAttribute("aria-label") ?? candidate.textContent?.trim();
      return name === text && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth;
    });
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`visible control not found: ${label}`);
}

async function pressVisibleButton(cdp, label) {
  const focused = await evaluate(cdp, (text) => {
    const element = [...document.querySelectorAll("button")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const name = candidate.getAttribute("aria-label") ?? candidate.textContent?.trim();
      return name === text && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth;
    });
    if (!(element instanceof HTMLButtonElement)) return false;
    window.__benchmarkLastKey = { key: null, keyTrusted: false, clicked: false, clickTrusted: false, control: null };
    document.addEventListener("keydown", (event) => {
      window.__benchmarkLastKey = {
        key: event.key,
        keyTrusted: event.isTrusted,
        clicked: false,
        clickTrusted: false,
        control: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? null,
      };
    }, { capture: true, once: true });
    element.addEventListener("click", (event) => {
      window.__benchmarkLastKey = {
        ...window.__benchmarkLastKey,
        clicked: true,
        clickTrusted: event.isTrusted,
      };
    }, { capture: true, once: true });
    element.focus();
    return document.activeElement === element;
  }, label);
  if (!focused) throw new Error(`visible decision button not found: ${label}`);
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  return waitFor(cdp, () => window.__benchmarkLastKey?.clicked ? window.__benchmarkLastKey : false, undefined, `${label} keyboard activation`);
}

async function openMobileSidebar(cdp) {
  const open = await evaluate(cdp, () => {
    const button = document.querySelector('button[aria-label="Open bot list"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  if (!open) throw new Error("mobile bot-list control is unavailable");
  await new Promise((accept) => setTimeout(accept, 300));
}

async function setViewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 390 });
  await waitFor(cdp, (size) => innerWidth === size.width && innerHeight === size.height, { width, height }, `${width}x${height} viewport`);
  await new Promise((accept) => setTimeout(accept, 350));
}

async function screenshot(cdp, file) {
  const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const bytes = Buffer.from(capture.data, "base64");
  await writeFile(`${config.outputDir}/${file}`, bytes);
  return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function pageAssertions(cdp, expectedButtons = []) {
  return evaluate(cdp, (labels) => {
    const root = document.documentElement;
    const sidebar = document.querySelector('aside[aria-label="Agents and navigation"]');
    const drawerButton = document.querySelector('button[aria-label="Open bot list"]');
    const horizontalScrollers = [...document.querySelectorAll("body *")].flatMap((element) => {
      if (!(element instanceof HTMLElement) || element.clientWidth <= 0 || element.scrollWidth - element.clientWidth <= 1) return [];
      const style = getComputedStyle(element);
      if (!["auto", "scroll"].includes(style.overflowX)) return [];
      return [{
        tag: element.tagName.toLowerCase(),
        className: element.className.slice(0, 240),
        ariaLabel: element.getAttribute("aria-label"),
        overflow: element.scrollWidth - element.clientWidth,
      }];
    });
    const buttons = labels.map((label) => {
      const element = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
      if (!(element instanceof HTMLButtonElement)) return { label, found: false };
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        label,
        found: true,
        disabled: element.disabled,
        display: style.display,
        visibility: style.visibility,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: root.scrollWidth - innerWidth,
      horizontalScrollers,
      closedMobileSidebarOcclusion: innerWidth <= 390
        && drawerButton?.getAttribute("aria-expanded") === "false"
        && sidebar instanceof HTMLElement
        && sidebar.getBoundingClientRect().right > 1,
      bodyText: document.body.innerText,
      buttons,
    };
  }, expectedButtons);
}

async function startSyntheticAction(cdp, fixtureBot, marker) {
  const started = await evaluate(cdp, async (input) => {
    const response = await fetch(`/api/bots/${encodeURIComponent(input.botId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.marker }),
    });
    return { status: response.status, body: await response.json() };
  }, { botId: fixtureBot.id, marker });
  if (started.status !== 202 || started.body?.ok !== true) throw new Error(`synthetic action turn did not start: ${JSON.stringify(started)}`);
  return started;
}

async function navigateToWork(cdp, mobile) {
  if (mobile) await openMobileSidebar(cdp);
  await activateVisibleControl(cdp, "Work");
  await waitFor(cdp, () => document.querySelector("h1")?.textContent === "Work", undefined, "Work view");
  if (mobile) await waitFor(cdp, () => {
    const sidebar = document.querySelector('aside[aria-label="Agents and navigation"]');
    return document.querySelector('button[aria-label="Open bot list"]')?.getAttribute("aria-expanded") === "false"
      && sidebar instanceof HTMLElement
      && sidebar.getBoundingClientRect().right <= 1;
  }, undefined, "closed mobile sidebar");
}

async function navigateToFixtureBot(cdp, mobile) {
  if (mobile) await openMobileSidebar(cdp);
  await activateVisibleControl(cdp, "Atlas");
  await waitFor(cdp, () => document.querySelector('[aria-label="Message Atlas"]') !== null, undefined, "fixture chat");
  if (mobile) await waitFor(cdp, () => {
    const sidebar = document.querySelector('aside[aria-label="Agents and navigation"]');
    return document.querySelector('button[aria-label="Open bot list"]')?.getAttribute("aria-expanded") === "false"
      && sidebar instanceof HTMLElement
      && sidebar.getBoundingClientRect().right <= 1;
  }, undefined, "closed mobile sidebar");
}

async function loadFixtureBot(cdp) {
  const bot = await evaluate(cdp, async () => {
    const response = await fetch("/api/bots");
    const body = await response.json();
    return body.bots.find((candidate) => candidate.name === "Atlas") ?? null;
  });
  if (!bot || typeof bot.id !== "string" || typeof bot.threadId !== "string") throw new Error("fixture bot is missing from product API");
  return bot;
}

async function drive(cdp, fixtureBot) {
  const screenshots = [];
  await setViewport(cdp, 1440, 900);
  await navigateToFixtureBot(cdp, false);
  const allowStarted = await startSyntheticAction(cdp, fixtureBot, "[benchmark-allow] Prepare the synthetic issue fixture.");
  await waitFor(cdp, () => document.body.innerText.includes("Approval requested") && document.body.innerText.includes("Create a GitHub issue"), undefined, "desktop approval controls");
  const desktopApproval = await pageAssertions(cdp, ["Cancel turn", "Deny", "Remember exact · 30d", "Allow once"]);
  screenshots.push(await screenshot(cdp, "desktop-approval.png"));
  const allowKeyboard = await pressVisibleButton(cdp, "Allow once");
  await waitFor(cdp, () => document.body.innerText.includes("reconciliation 200 not_verified"), undefined, "fail-closed reconciliation result");
  await navigateToWork(cdp, false);
  await waitFor(cdp, () => document.body.innerText.includes("Create a GitHub issue") && document.body.innerText.includes("In progress"), undefined, "honest unverified Work state");
  const desktopWork = await pageAssertions(cdp);
  screenshots.push(await screenshot(cdp, "desktop-work.png"));
  await setViewport(cdp, 390, 844);
  await navigateToFixtureBot(cdp, true);
  const denyStarted = await startSyntheticAction(cdp, fixtureBot, "[benchmark-deny] Prepare the synthetic blocked comment fixture.");
  await waitFor(cdp, () => document.body.innerText.includes("Approval requested") && document.body.innerText.includes("Comment on a GitHub issue"), undefined, "mobile approval controls");
  const mobileApproval = await pageAssertions(cdp, ["Cancel turn", "Deny", "Remember exact · 30d", "Allow once"]);
  screenshots.push(await screenshot(cdp, "mobile-approval.png"));
  const denyKeyboard = await pressVisibleButton(cdp, "Deny");
  await waitFor(cdp, () => document.body.innerText.includes("authorization 403 deny"), undefined, "blocked authorization result");
  await navigateToWork(cdp, true);
  await waitFor(cdp, () => document.body.innerText.includes("Comment on a GitHub issue") && document.body.innerText.includes("Blocked"), undefined, "blocked Work state");
  const mobileWork = await pageAssertions(cdp);
  screenshots.push(await screenshot(cdp, "mobile-work.png"));
  return { allowStarted, denyStarted, allowKeyboard, denyKeyboard, desktopApproval, desktopWork, mobileApproval, mobileWork, screenshots };
}

async function verify(cdp) {
  const screenshots = [];
  await setViewport(cdp, 1440, 900);
  await navigateToWork(cdp, false);
  await waitFor(cdp, () => {
    const text = document.body.innerText;
    return text.includes("Create a GitHub issue") && text.includes("Comment on a GitHub issue") && text.includes("Blocked");
  }, undefined, "fresh desktop Work projection");
  const desktopWork = await pageAssertions(cdp);
  screenshots.push(await screenshot(cdp, "verify-desktop-work.png"));
  await setViewport(cdp, 390, 844);
  const mobileWork = await pageAssertions(cdp);
  screenshots.push(await screenshot(cdp, "verify-mobile-work.png"));
  return { desktopWork, mobileWork, screenshots };
}

const cdpPort = await freePort();
const browser = spawn(config.browserExecutable, [
  "--headless=new",
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${config.browserProfile}`,
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let browserOutput = "";
browser.stdout.setEncoding("utf8").on("data", (chunk) => { browserOutput += chunk; });
browser.stderr.setEncoding("utf8").on("data", (chunk) => { browserOutput += chunk; });
let cdp;
const rendererEvents = [];
const externalRequests = [];
try {
  const webSocketUrl = await waitForCdp(cdpPort, browser);
  cdp = createCdp(webSocketUrl);
  await cdp.opened;
  cdp.on("Runtime.consoleAPICalled", (params) => {
    rendererEvents.push({
      kind: "console",
      type: params.type,
      values: Array.isArray(params.args)
        ? params.args.map((argument) => argument.value ?? argument.description ?? argument.type).slice(0, 8)
        : [],
    });
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    rendererEvents.push({
      kind: "exception",
      text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "renderer exception",
      url: params.exceptionDetails?.url,
      lineNumber: params.exceptionDetails?.lineNumber,
      columnNumber: params.exceptionDetails?.columnNumber,
    });
  });
  cdp.on("Log.entryAdded", (params) => {
    rendererEvents.push({ kind: "log", level: params.entry?.level, text: params.entry?.text, url: params.entry?.url });
  });
  cdp.on("Fetch.requestPaused", (params) => {
    let allowed = false;
    try {
      const url = new URL(params.request.url);
      allowed = ["data:", "blob:", "devtools:"].includes(url.protocol) || (url.protocol === "http:" && url.hostname === "127.0.0.1");
    } catch {}
    if (!allowed) externalRequests.push({ method: params.request.method, urlSha256: sha256(params.request.url), blocked: true });
    void cdp.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: "BlockedByClient" });
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  const version = await cdp.send("Browser.getVersion");
  await cdp.send("Page.navigate", { url: config.origin });
  await waitFor(cdp, () => document.readyState === "complete" && document.querySelector('button[aria-label="Work"]') !== null, undefined, "built product shell");
  const fixtureBot = await loadFixtureBot(cdp);
  await waitFor(cdp, () => document.querySelector('[role="button"][aria-label="Atlas"]') !== null, undefined, "fixture agent control");
  const journey = config.mode === "drive" ? await drive(cdp, fixtureBot) : await verify(cdp);
  const pages = config.mode === "drive"
    ? [journey.desktopApproval, journey.desktopWork, journey.mobileApproval, journey.mobileWork]
    : [journey.desktopWork, journey.mobileWork];
  const controls = pages.flatMap((value) => value.buttons ?? []);
  const keyboard = config.mode === "drive" ? [journey.allowKeyboard, journey.denyKeyboard] : [];
  const passed = externalRequests.every((request) => request.blocked === true)
    && pages.every((value) => value.horizontalOverflow <= 0 && value.horizontalScrollers.length === 0 && value.closedMobileSidebarOcclusion === false)
    && controls.every((button) => button.found && !button.disabled && button.display !== "none" && button.visibility !== "hidden" && button.insideViewport)
    && keyboard.every((event) => event.key === " " && event.keyTrusted === true && event.clicked === true && event.clickTrusted === true);
  const result = {
    schemaVersion: 1,
    mode: config.mode,
    passed,
    browser: version.product,
    networkIsolation: { nonLoopbackAllowed: 0, blockedExternalRequests: externalRequests.length },
    externalRequests,
    ...journey,
  };
  await writeFile(config.resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (!passed) process.exitCode = 1;
  await cdp.send("Browser.close").catch(() => {});
} catch (error) {
  if (cdp) {
    const diagnostic = await evaluate(cdp, () => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body?.innerText?.slice(0, 4_000) ?? null,
      bodyHtml: document.body?.innerHTML?.slice(0, 12_000) ?? null,
      rootChildren: document.querySelector("#root")?.childElementCount ?? null,
    })).catch((diagnosticError) => ({ captureError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) }));
    const diagnosticRoot = dirname(config.browserProfile);
    const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }).catch(() => null);
    if (capture?.data) await writeFile(join(diagnosticRoot, `${config.mode}-shell-failure.png`), Buffer.from(capture.data, "base64"));
    await writeFile(join(diagnosticRoot, `${config.mode}-renderer-diagnostic.json`), `${JSON.stringify({ diagnostic, rendererEvents: rendererEvents.slice(-100), externalRequests }, null, 2)}\n`, "utf8");
  }
  throw new Error(`${error instanceof Error ? error.message : String(error)}${browserOutput ? `\nBrowser tail:\n${browserOutput.slice(-2_000)}` : ""}`);
} finally {
  cdp?.close();
  if (browser.exitCode === null) browser.kill();
}
