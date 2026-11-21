import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { PANE_PARTITION } from "../../../electron/browser-pane-wire.mjs";
import { removeTempDir } from "../../testing/cleanup.ts";
import { CdpConnection } from "../cdp/connection.ts";
import { BrowserService } from "../service.ts";
import { FakeBackend, FakeChrome, type FakeDocument } from "../testing/fake-chrome.ts";
import { PaneBackend, panePartition } from "./backend.ts";
import { PaneEndpoint, PERSON_HOLDS_TAB, type PaneChannel } from "./endpoint.ts";
import { PaneLink } from "./link.ts";
import { withPasskeyNotice } from "../passkey-notice.ts";
import { FakeMain } from "./testing/fake-main.ts";

const FORM: FakeDocument = {
  title: "Sign up",
  text: "Sign up\nName\nGo",
  elements: [
    { role: "heading", name: "Sign up", box: [10, 10, 300, 40] },
    { role: "textbox", name: "Name", selector: "#name", editable: true, value: "", box: [10, 60, 200, 30] },
    { role: "button", name: "Go", selector: "#go", box: [10, 100, 80, 30], onClick: (page) => { page.text += "\nHello"; } },
  ],
};
const documents = (url: string): FakeDocument => (url.endsWith("/form") ? FORM : { title: url.split("/").pop() ?? "", text: `page ${url}`, elements: [] });
const BROWSER_LEVEL = /^(?:Browser\.|Target\.(?:createTarget|closeTarget|getTargets|setDiscoverTargets|attachToTarget|activateTarget))/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const folders: string[] = [];
const services: BrowserService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.closeAll())); });
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

function setup({ quietMs = 1_000, linkOptions = {} }: { quietMs?: number; linkOptions?: ConstructorParameters<typeof PaneLink>[1] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-browser-pane-"));
  folders.push(dataDir);
  const main = new FakeMain(documents);
  const link = new PaneLink(main, { quietMs, maxHoldMs: 2_000, ...linkOptions });
  const backend = new PaneBackend(link, dataDir, async () => 41_000, { platform: "darwin" });
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 200 });
  services.push(service);
  const target = { session: "bot-a", key: "bot:a" };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    service.agentRpc(target, "tools/call", { name, arguments: args }) as Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? `[${part.type}]`).join("\n");
  return { main, link, backend, service, target, call, text, dataDir };
}

describe("the bots' browser as desktop panes", () => {
  it("runs the driver's tools on panes that speak page-level CDP only", async () => {
    const { main, call, text } = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opened = text(await call("agent_browser_open", { url: "https://example.com/form" }));
    expect(opened).toContain("Opened https://example.com/form in t1.");
    expect(opened).toContain(`textbox "Name" [ref=e1]`);
    expect(text(await call("agent_browser_fill", { ref: "e1", text: "Ada" }))).toContain("Filled the field.");
    const clicked = text(await call("agent_browser_click", { ref: "e2" }));
    expect(clicked).toContain(`Text that appeared on the page: "Hello".`);
    expect((await call("agent_browser_type", { selector: "#name", text: "b" })).isError).toBeUndefined();
    expect((await call("agent_browser_press", { key: "Enter" })).isError).toBeUndefined();
    expect((await call("agent_browser_navigate", { url: "https://example.com/next" })).isError).toBeUndefined();
    expect(text(await call("agent_browser_snapshot"))).toContain("https://example.com/next");
    expect(text(await call("agent_browser_screenshot"))).toContain("Screenshot of t1");
    const page = main.page("p1");
    expect(page.url).toBe("https://example.com/next");
    expect(FORM.elements[1]!.value).toBe("Adab");
    FORM.elements[1]!.value = "";
    // Nothing browser-level ever reached a pane's own debugger, and only the app was asked to open the tab.
    expect(main.commands.filter((command) => BROWSER_LEVEL.test(command.method))).toEqual([]);
    expect(main.toMain.filter((message) => message.op === "create")).toHaveLength(1);
    expect(main.partitions).toHaveLength(1);
    expect(main.partitions[0]).toMatch(PANE_PARTITION);
    expect(main.egress).toEqual([41_000]);
  });

  it("opens a new tab as another pane and closes every pane with the browser", async () => {
    const { main, service, call, text } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    expect(text(await call("agent_browser_open", { url: "https://example.com/b", tab: "new" }))).toContain("in t2");
    expect([...main.panes.keys()]).toEqual(["p1", "p2"]);
    await service.closeAll();
    expect(main.panes.size).toBe(0);
    expect(main.toMain.some((message) => message.op === "close")).toBe(true);
  });

  it("adopts a popup the page opened as a tab with its opener", async () => {
    const { main, call, text } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    await main.popup("p1", "https://accounts.example/sign-in");
    await sleep(20);
    const tabs = text(await call("agent_browser_tabs", { action: "list" }));
    expect(tabs).toContain("accounts.example");
  });

  it("re-enables page events before each navigation, as a renderer swap drops them", async () => {
    const { main, call } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    main.commands.length = 0;
    await call("agent_browser_navigate", { url: "https://other.example/b" });
    const methods = main.commands.map((command) => command.method);
    const navigate = methods.indexOf("Page.navigate");
    expect(navigate).toBeGreaterThan(2);
    expect(methods.slice(navigate - 3, navigate)).toEqual(["Network.enable", "Page.enable", "Page.setLifecycleEventsEnabled"]);
  });

  it("holds the bot's input while the person uses the page, and drops the bot's refs after", async () => {
    const { main, call, text } = setup({ quietMs: 300 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    main.personInput("bot:a");
    await sleep(10);
    const stale = await call("agent_browser_click", { ref: "e2" });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("Take a fresh snapshot");
    main.commands.length = 0;
    main.personInput("bot:a");
    await sleep(10);
    const started = Date.now();
    expect((await call("agent_browser_click", { selector: "#go" })).isError).toBeUndefined();
    const input = main.commands.findIndex((command) => command.method.startsWith("Input."));
    expect(input).toBeGreaterThanOrEqual(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("lets the person hold a tab: the bot's input is refused, its refs drop on release, and the tab says who acted last", async () => {
    const { main, service, call, text } = setup({ quietMs: 0 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    const run = service.profiles()[0]!.run!;
    const control = run.opened.personControl!;
    const targetId = run.browser.activePage!.targetId;
    expect(control.owner(targetId)).toBe(null);
    control.hold(targetId, true);
    main.commands.length = 0;
    expect(control.owner(targetId)).toBe("person");
    const refused = await call("agent_browser_click", { selector: "#go" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("The person is using this tab.");
    expect((await call("agent_browser_navigate", { url: "https://example.com/away" })).isError).toBe(true);
    expect(main.commands.some((command) => command.method.startsWith("Input.") || command.method === "Page.navigate")).toBe(false);
    control.hold(targetId, false);
    const stale = await call("agent_browser_click", { ref: "e2" });
    expect(text(stale)).toContain("Take a fresh snapshot");
    expect((await call("agent_browser_click", { selector: "#go" })).isError).toBeUndefined();
    expect(control.owner(targetId)).toBe("bot");
    main.personInput("bot:a", "p1");
    await sleep(5);
    expect(control.owner(targetId)).toBe("person");
  });

  it("takes a hold from the app's panel only for the tab that panel shows, and ends every hold when the window goes", async () => {
    const { main, link, service, call, text } = setup({ quietMs: 0 });
    link.resolveWith((botId) => (botId === "a" ? "bot:a" : null));
    await call("agent_browser_open", { url: "https://example.com/form" });
    const control = service.profiles()[0]!.run!.opened.personControl!;
    const answered = async (fields: Record<string, unknown>) => {
      const req = 900 + main.toMain.length;
      main.post({ op: "hold", req, threadId: null, tab: "p1", ...fields });
      await sleep(5);
      return main.toMain.find((message) => message.op === "hold-result" && (message as { req: number }).req === req) as { held: boolean } | undefined;
    };
    // Another bot's panel cannot hold this browser's tab.
    expect(await answered({ botId: "b", browser: "bot:a", held: true })).toMatchObject({ held: false });
    expect(control.holding()).toBe(false);
    expect(await answered({ botId: "a", browser: "bot:a", held: true })).toMatchObject({ held: true });
    expect(text(await call("agent_browser_click", { selector: "#go" }))).toContain("The person is using this tab.");
    main.post({ op: "let-go" });
    await sleep(5);
    expect(control.holding()).toBe(false);
    expect((await call("agent_browser_click", { selector: "#go" })).isError).toBeUndefined();
  });

  it("holds the tab the HTTP route names, not the bot's active one", async () => {
    const { service, target, call, text } = setup({ quietMs: 0 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    expect(service.holdTab(target.session, "t1", true)).toBe("t1");
    expect(text(await call("agent_browser_click", { selector: "#go" }))).toContain("The person is using this tab.");
    // The bot's tab opened behind the person's is the bot's active one; the person's hold stays on theirs.
    await call("agent_browser_tabs", { action: "new" });
    expect(text(await call("agent_browser_click", { selector: "#go", tab: "t1" }))).toContain("The person is using this tab.");
    expect(service.holdTab(target.session, "t1", false)).toBe("t1");
    expect(text(await call("agent_browser_click", { ref: "e2", tab: "t1" }))).toContain("Take a fresh snapshot");
    expect(service.holdTab(target.session, "t9", true)).toBe(null);
    expect(service.holdTab("no-such-session", "t1", true)).toBe(null);
  });

  it("answers the page's dialog at once, never behind input waiting for the person to finish", async () => {
    const { main, service, call } = setup({ quietMs: 1_500 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    const page = service.profiles()[0]!.run!.browser.activePage!;
    main.personInput("bot:a", "p1");
    await sleep(5);
    void page.session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a" }).catch(() => undefined);
    main.commands.length = 0;
    const started = Date.now();
    await page.session.send("Page.handleJavaScriptDialog", { accept: false });
    expect(Date.now() - started).toBeLessThan(500);
    expect(main.commands.map((command) => command.method)).toEqual(["Page.handleJavaScriptDialog"]);
  });

  it("never holds the bot's navigate behind a turn's preview of a page under an alert, with the panel watching", async () => {
    const { main, service, target, call, text } = setup({ quietMs: 0 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 730, maxHeight: 1156 }, (output) => { if (output.type === "frame") output.ack(); });
    await sleep(20);
    main.post({ op: "event", browser: "bot:a", tab: "p1", method: "Page.javascriptDialogOpening", params: { type: "alert", message: "hello alert", url: "https://example.com/form" } });
    await sleep(5);
    // Under the alert the page answers no screencast change, script, read or capture, as Electron's did live.
    let open = true;
    main.hang = (command) => {
      if (command.method === "Page.handleJavaScriptDialog") open = false;
      return open && /^(?:Page\.(?:startScreencast|stopScreencast|getLayoutMetrics|captureScreenshot)|Runtime\.|DOM\.|Accessibility\.)/.test(command.method);
    };
    const preview = service.previewFrame("bot-a").then(() => "pictured", (error: Error) => error.message);
    const started = Date.now();
    const result = await call("agent_browser_open", { url: "https://example.com/next" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(text(result)).toContain("Dismissed the page's open alert dialog");
    expect(await preview).toMatch(/dialog/);
    await viewer.close();
  });

  it("dismisses the alert a page left open when the bot navigates away, and says so", async () => {
    const { main, call, text } = setup({ quietMs: 0 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    main.post({ op: "event", browser: "bot:a", tab: "p1", method: "Page.javascriptDialogOpening", params: { type: "alert", message: "Saved!", url: "https://example.com/form" } });
    await sleep(5);
    main.commands.length = 0;
    const result = await call("agent_browser_navigate", { url: "https://example.com/next" });
    expect(result.isError, text(result)).toBeUndefined();
    expect(text(result)).toContain(`Dismissed the page's open alert dialog "Saved!" to leave the page.`);
    const methods = main.commands.map((command) => command.method);
    expect(methods.indexOf("Page.handleJavaScriptDialog")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("Page.handleJavaScriptDialog")).toBeLessThan(methods.indexOf("Page.navigate"));
    expect(main.commands.find((command) => command.method === "Page.handleJavaScriptDialog")!.params).toEqual({ accept: false });
  });

  it("keeps every pane emulating focus, so a pane the person is not in still takes the bot's keys", async () => {
    const { main, call } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    expect(main.commands.filter((command) => command.method === "Emulation.setFocusEmulationEnabled").map((command) => command.params)).toEqual([{ enabled: true }]);
  });

  it("refuses to emulate a page size on a pane, which the app window sizes", async () => {
    const { main, call } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    const page = [...services[0]!.profiles()][0]!.run!.browser.activePage!;
    await expect(page.emulateSize({ width: 400, height: 300 }, 1)).rejects.toThrow(/sized by the app window/);
    expect(main.commands.some((command) => command.method === "Emulation.setDeviceMetricsOverride")).toBe(false);
  });

  it("fails to open when the app has not said it shows panes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-browser-pane-"));
    folders.push(dataDir);
    const silent = { on: () => undefined, postMessage: () => undefined };
    const link = new PaneLink(silent);
    expect(link.available).toBe(false);
    const backend = new PaneBackend(link, dataDir, async () => 41_000);
    await expect(backend.open({ key: "bot:a", mode: "headless", fresh: false, viewport: { width: 1280, height: 720 }, downloadDir: dataDir })).rejects.toThrow(/does not show browser panes/);
    expect(new PaneLink(null).available).toBe(false);
  });
});

describe("what a held pane lets the bot do", () => {
  it("reads only: no input, script writes, dialog answers or tab switches on the page or its frames", async () => {
    const { main, service, call, text } = setup({ quietMs: 0 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    await call("agent_browser_open", { url: "https://example.com/other", tab: "new" });
    const run = service.profiles()[0]!.run!;
    const [first, second] = run.browser.pages();
    run.opened.personControl!.hold(first!.targetId, true);
    main.commands.length = 0;
    // The person holds t1: the bot may not bring it back or switch the front tab away from them.
    expect(text(await call("agent_browser_click", { selector: "#go", tab: "t1" }))).toContain("The person is using this tab.");
    const connection = run.browser.connection;
    const page = connection.session(first!.session.id!)!;
    await expect(page.send("Runtime.callFunctionOn", { functionDeclaration: "function () { this.value = 1; }", objectId: "x" })).rejects.toThrow(PERSON_HOLDS_TAB);
    await expect(page.send("Page.handleJavaScriptDialog", { accept: true })).rejects.toThrow(PERSON_HOLDS_TAB);
    await expect(page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: 1 })).rejects.toThrow(PERSON_HOLDS_TAB);
    await expect(connection.root.send("Target.activateTarget", { targetId: second!.targetId })).rejects.toThrow(PERSON_HOLDS_TAB);
    // The driver's own fronting before a navigation leaves the page behind the person's.
    await second!.session.send("Page.bringToFront");
    // A frame of the held page is held too.
    main.post({ op: "event", browser: "bot:a", tab: "p1", method: "Target.attachedToTarget", params: { sessionId: "IFRAME1", targetInfo: { targetId: "F", type: "iframe", url: "", title: "" }, waitingForDebugger: false } });
    await sleep(5);
    const frame = connection.session("pane-p1:IFRAME1")!;
    await expect(frame.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a" })).rejects.toThrow(PERSON_HOLDS_TAB);
    // Reads still run, a script call the driver marks read-only included.
    expect((await page.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: "document.title", contextId: 1, returnByValue: true }, { readOnly: true })).result).toBeDefined();
    const snapshot = await call("agent_browser_snapshot", { tab: "t1" });
    expect(snapshot.isError, text(snapshot)).toBeUndefined();
    expect(main.commands.some((command) => /^(?:Input\.|Page\.handleJavaScriptDialog|DOM\.scrollIntoViewIfNeeded)/.test(command.method))).toBe(false);
    expect(main.commands.some((command) => command.method === "Runtime.callFunctionOn" && String(command.params.functionDeclaration).includes("this.value = 1"))).toBe(false);
    expect(main.toMain.filter((message) => message.op === "front").map((message) => (message as { tab: string }).tab)).toEqual(["p1"]);
  });

  it("takes the same reads as a held browser does, and refuses every other tool on the held tab before it reaches the pane", async () => {
    const { main, service, call, text } = setup({ quietMs: 0 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    const run = service.profiles()[0]!.run!;
    run.opened.personControl!.hold(run.browser.activePage!.targetId, true);
    for (const [name, args] of [["agent_browser_status", {}], ["agent_browser_snapshot", {}], ["agent_browser_screenshot", {}], ["agent_browser_read", {}], ["agent_browser_tabs", { action: "list" }]] as const) {
      const answer = await call(name, args);
      expect(answer.isError, `${name}: ${text(answer)}`).toBeUndefined();
    }
    main.commands.length = 0;
    for (const [name, args] of [["agent_browser_wait", { text: "Sign up" }], ["agent_browser_eval", { expression: "1" }], ["agent_browser_screenshot", { fullPage: true }], ["agent_browser_click", { selector: "#go" }]] as const) {
      expect(text(await call(name, args)), name).toContain(PERSON_HOLDS_TAB);
    }
    expect(main.commands).toEqual([]);
  });

  it("opens a bot's new tab behind the one the person holds, and says so", async () => {
    const { main, service, call, text } = setup({ quietMs: 0 });
    await call("agent_browser_open", { url: "https://example.com/a" });
    const run = service.profiles()[0]!.run!;
    const held = run.browser.activePage!.targetId;
    run.opened.personControl!.hold(held, true);
    const opened = await call("agent_browser_open", { url: "https://example.com/b", tab: "new" });
    expect(opened.isError, text(opened)).toBeUndefined();
    expect(main.toMain.filter((message) => message.op === "create").map((message) => (message as { background?: boolean }).background)).toEqual([undefined, true]);
    expect(main.commands.some((command) => command.tab === "p2" && command.method === "Page.navigate")).toBe(true);
    const listed = text(await call("agent_browser_tabs", { action: "new", url: "https://example.com/c" }));
    expect(listed).toContain("behind the tab the person is using");
    expect(listed).not.toContain("in front");
    expect(text(await call("agent_browser_tabs", { action: "switch", tab: "t2" }))).toContain("stays behind it");
    expect(main.toMain.filter((message) => message.op === "front").map((message) => (message as { tab: string }).tab).filter((tab) => tab !== "p1")).toEqual([]);
    run.opened.personControl!.hold(held, false);
    expect(text(await call("agent_browser_tabs", { action: "new" }))).toContain("It is in front");
  });
});

describe("the pane's downloads", () => {
  it("are saved to the profile's download folder by the app and tracked as a launched Chrome's are", async () => {
    const { main, service, call } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    const run = service.profiles()[0]!.run!;
    const folder = main.downloadDirs[0]!;
    expect(folder).toBe(service.profiles()[0]!.downloadDir);
    const guid = "0b7c4a52-4f0a-4b8e-9d55-0a1f2b3c4d5e";
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, guid), "report");
    main.post({ op: "download", browser: "bot:a", tab: "p1", guid, state: "begin", url: "https://example.com/report.csv", name: "report.csv" });
    main.post({ op: "download", browser: "bot:a", tab: "p1", guid, state: "completed", received: 6, total: 6, path: join(folder, guid) });
    const done = await run.browser.downloads!.finished((download) => download.guid === guid, 2_000);
    expect(done.state).toBe("completed");
    expect(done.owner).toBe(run.browser.activePage!.targetId);
    expect(readFileSync(done.path!, "utf8")).toBe("report");
    await run.browser.connection.root.send("Browser.cancelDownload", { guid });
    expect(main.toMain.some((message) => message.op === "cancel-download")).toBe(true);
  });
});

describe("when the app cannot host a pane or does not answer", () => {
  it("starts the browser on the launched Chrome while no app window can host a pane", async () => {
    const { main, service, backend, call, text } = setup();
    const fallback = new FakeBackend(() => new FakeChrome({ documents }));
    backend.fallBackTo(fallback);
    main.noWindow = true;
    expect(text(await call("agent_browser_open", { url: "https://example.com/form" }))).toContain("Opened https://example.com/form in t1.");
    expect(fallback.chromes).toHaveLength(1);
    expect(main.panes.size).toBe(0);
    expect(backend.used("bot:a")).toBe(false);
    expect(service.profiles()[0]!.run).not.toBeNull();
  });

  it("fails a command the app never answers, and closes panes whose opening answered too late", async () => {
    const { main, link } = setup({ linkOptions: { requestTimeoutMs: 50, openTimeoutMs: 50 } });
    await sleep(5);
    main.openDelayMs = 120;
    await expect(link.open("bot:late", panePartition(folders.at(-1)!, "bot:late"), 41_000, folders.at(-1)!)).rejects.toThrow(/did not open the browser pane in time/);
    await sleep(150);
    expect(main.toMain.filter((message) => message.op === "close" && message.browser === "bot:late").length).toBeGreaterThanOrEqual(2);
    main.openDelayMs = 0;
    const opened = await link.open("bot:b", panePartition(folders.at(-1)!, "bot:b"), 41_000, folders.at(-1)!);
    main.hang = () => true;
    const connection = new CdpConnection(opened.endpoint, { defaultTimeoutMs: 0 });
    opened.endpoint.tabOpened({ tab: "p1", target: "F1", url: "about:blank", title: "" });
    await connection.root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await expect(connection.session("pane-p1")!.send("Page.getFrameTree")).rejects.toThrow(/did not answer the browser pane in time/);
    connection.close();
  });
});

describe("deleting a bot's browser with the pane", () => {
  it("clears a partition only for a profile whose panes ever opened here", async () => {
    const { main, backend, call } = setup();
    expect(backend.used("bot:a")).toBe(false);
    await call("agent_browser_open", { url: "https://example.com/a" });
    expect(backend.used("bot:a")).toBe(true);
    backend.erase("bot:b");
    expect(main.toMain.some((message) => message.op === "erase")).toBe(false);
    backend.erase("bot:a");
    expect(main.toMain.filter((message) => message.op === "erase")).toEqual([{ type: "openmausbot:browser-pane", op: "erase", partition: main.partitions[0] }]);
    expect(backend.used("bot:a")).toBe(false);
  });
});

describe("the pane's identity", () => {
  it("is Electron's Chromium as it is: the driver sends no user agent, client hint, automation switch or main-world script", async () => {
    const { main, call } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    await call("agent_browser_fill", { selector: "#name", text: "Ada" });
    await call("agent_browser_click", { selector: "#go" });
    await call("agent_browser_open", { url: "https://example.com/b", tab: "new" });
    expect(main.toMain.filter((message) => message.op === "open").map((message) => (message as { identity: string }).identity)).toEqual(["native"]);
    const sent = main.commands;
    expect(sent.filter((command) => /UserAgentOverride|setDeviceMetricsOverride|setAutomationOverride/.test(command.method))).toEqual([]);
    expect(sent.filter((command) => command.method === "Page.addScriptToEvaluateOnNewDocument" && !command.params.worldName)).toEqual([]);
    expect(sent.filter((command) => (command.method === "Runtime.evaluate" || command.method === "Runtime.callFunctionOn") && command.params.contextId === undefined && command.params.objectId === undefined)).toEqual([]);
    expect(JSON.stringify(sent)).not.toMatch(/Firefox|webdriver|AutomationControlled|Google Chrome/);
    FORM.elements[1]!.value = "";
  });

  it("refuses a user agent override that would blank Chromium's client hints", async () => {
    const { main, service, call } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    const page = service.profiles()[0]!.run!.browser.activePage!;
    await expect(page.session.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 Chrome/146.0.0.0" })).rejects.toThrow(/needs userAgentMetadata/);
    await expect(page.session.send("Network.setUserAgentOverride", { userAgent: "x" })).rejects.toThrow(/needs userAgentMetadata/);
    expect(main.commands.some((command) => command.method.endsWith("UserAgentOverride"))).toBe(false);
  });

  it("passes the cleaned identity to the app when the config asks for it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-browser-pane-"));
    folders.push(dataDir);
    const main = new FakeMain(documents);
    const link = new PaneLink(main);
    await sleep(5);
    const backend = new PaneBackend(link, dataDir, async () => 41_000, { identity: () => "cleaned" });
    const opened = await backend.open({ key: "bot:c", mode: "headless", fresh: false, viewport: { width: 1280, height: 720 }, downloadDir: dataDir });
    expect(main.toMain.find((message) => message.op === "open")).toMatchObject({ identity: "cleaned" });
    await opened.close();
  });

  it("turns a passkey request down at once instead of leaving the page waiting for a sheet Electron never draws", async () => {
    const { main, call } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    expect(main.commands.filter((command) => command.method.startsWith("WebAuthn.")).map((command) => command.method)).toEqual(["WebAuthn.enable", "WebAuthn.addVirtualAuthenticator"]);
  });
});

describe("the pane's debugger and its frames", () => {
  it("never leaves a frame waiting: auto-attach never pauses, and a frame that arrives paused is run at once", async () => {
    const sent: Array<{ tab: string; method: string; params: Record<string, unknown>; session?: string }> = [];
    const endpoint = new PaneEndpoint({
      version: "146", userAgent: "ua", create: async () => ({ tab: "p9", target: "F9", url: "", title: "" }),
      command: async (tab, method, params, session) => { sent.push({ tab, method, params, ...(session ? { session } : {}) }); return {}; },
      front: () => {}, closeTab: () => {}, cancelDownload: () => {}, close: () => {},
    }, [{ tab: "p1", target: "F1", url: "https://a.test/", title: "A" }]);
    const connection = new CdpConnection(endpoint);
    await connection.root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    endpoint.pageEvent("p1", "Target.attachedToTarget", { sessionId: "IFR", targetInfo: { targetId: "X", type: "iframe", url: "https://accounts.google.com/", title: "" }, waitingForDebugger: true });
    await sleep(1);
    expect(sent).toContainEqual({ tab: "p1", method: "Runtime.runIfWaitingForDebugger", params: {}, session: "IFR" });
    await connection.session("pane-p1:IFR")!.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    expect(sent.at(-1)).toEqual({ tab: "p1", method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session: "IFR" });
    connection.close();
  });
});

describe("a site turning the pane away", () => {
  it("is reported when Google refuses sign-in or asks for a passkey, and the bot is told to use My Chrome", async () => {
    const { main, service, call } = setup();
    await call("agent_browser_open", { url: "https://example.com/a" });
    const run = service.profiles()[0]!.run!;
    const refusals: Array<{ kind: string; url: string }> = [];
    run.opened.onSiteRefusal!((refusal) => refusals.push({ kind: refusal.kind, url: refusal.url }));
    const frame = (url: string) => main.post({ op: "event", browser: "bot:a", tab: "p1", method: "Page.frameNavigated", params: { frame: { id: run.browser.activePage!.targetId, url, loaderId: "L" } } });
    frame("https://accounts.google.com/v3/signin/rejected?continue=x");
    frame("https://accounts.google.com/v3/signin/challenge/pk?TL=1");
    frame("https://accounts.google.com/v3/signin/identifier");
    await sleep(5);
    expect(refusals).toEqual([
      { kind: "google-rejected", url: "https://accounts.google.com/v3/signin/rejected?continue=x" },
      { kind: "passkey", url: "https://accounts.google.com/v3/signin/challenge/pk?TL=1" },
    ]);
    const told = withPasskeyNotice({ content: [{ type: "text", text: "Opened https://accounts.google.com/v3/signin/rejected in t1." }] }, "pane") as { content: Array<{ text: string }> };
    expect(told.content.at(-1)!.text).toContain("My Chrome");
    expect(told.content.at(-1)!.text).toContain("this app's built-in browser");
    const passkey = withPasskeyNotice({ content: [{ type: "text", text: "https://accounts.google.com/v3/signin/challenge/pk" }] }, "pane") as { content: Array<{ text: string }> };
    expect(passkey.content.at(-1)!.text).toContain("My Chrome");
  });
});

describe("the pane partition", () => {
  it("is per profile and per data folder, and in memory for a temporary profile", async () => {
    const one = mkdtempSync(join(tmpdir(), "omb-browser-pane-"));
    const two = mkdtempSync(join(tmpdir(), "omb-browser-pane-"));
    folders.push(one, two);
    expect(panePartition(one, "bot:a")).toMatch(/^persist:omb-pane-[0-9a-f]{24}$/);
    expect(panePartition(one, "bot:a")).toBe(panePartition(one, "bot:a"));
    expect(panePartition(one, "bot:a")).not.toBe(panePartition(one, "bot:b"));
    expect(panePartition(one, "bot:a")).not.toBe(panePartition(two, "bot:a"));
    expect(panePartition(one, "temp:guest-1", () => "0a1b2c3d")).toMatch(/^omb-pane-[0-9a-f]{24}-0a1b2c3d$/);
    for (const partition of [panePartition(one, "shared:p1"), panePartition(one, "temp:guest-1")]) expect(partition).toMatch(PANE_PARTITION);
  });
});

describe("the pane link", () => {
  it("answers which profile a bot's panel shows, and ignores what is not a pane message", async () => {
    const main = new FakeMain();
    const link = new PaneLink(main);
    link.resolveWith((botId) => (botId === "a" ? `bot:${botId}` : null));
    await sleep(5);
    expect(link.available).toBe(true);
    main.toMain.length = 0;
    main.post({ op: "which", req: 1, botId: "a", threadId: null });
    main.post({ op: "which", req: 2, botId: "b", threadId: "t-1" });
    await sleep(5);
    expect(main.toMain).toEqual([
      { type: "openmausbot:browser-pane", op: "resolved", req: 1, browser: "bot:a" },
      { type: "openmausbot:browser-pane", op: "resolved", req: 2, browser: null },
    ]);
    expect(() => main.post({ op: "which", req: 3, botId: "a b", threadId: null })).toThrow(/malformed/);
  });
});

describe("the pane endpoint", () => {
  function channel(sent: Array<{ tab: string; method: string; params: Record<string, unknown>; session?: string }>): PaneChannel {
    return {
      version: "146.0.7680.0",
      userAgent: "Mozilla/5.0 Chrome/146.0.0.0",
      create: async () => ({ tab: "p9", target: "F9", url: "about:blank", title: "" }),
      command: async (tab, method, params, session) => { sent.push({ tab, method, params, ...(session ? { session } : {}) }); return {}; },
      front: () => {},
      closeTab: () => {},
      cancelDownload: () => {},
      close: () => {},
    };
  }

  it("keeps two panes' iframe sessions apart and routes each back to its own pane", async () => {
    const sent: Array<{ tab: string; method: string; params: Record<string, unknown>; session?: string }> = [];
    const endpoint = new PaneEndpoint(channel(sent), [{ tab: "p1", target: "F1", url: "https://a.test/", title: "A" }, { tab: "p2", target: "F2", url: "https://b.test/", title: "B" }]);
    const connection = new CdpConnection(endpoint);
    await connection.root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    expect(connection.session("pane-p1")?.kind).toBe("page");
    for (const tab of ["p1", "p2"]) {
      endpoint.pageEvent(tab, "Target.attachedToTarget", { sessionId: "F00D", targetInfo: { targetId: "frame", type: "iframe", url: "", title: "" }, waitingForDebugger: false });
    }
    await sleep(1);
    const first = connection.session("pane-p1:F00D");
    const second = connection.session("pane-p2:F00D");
    expect(first?.kind).toBe("frame");
    expect(second?.kind).toBe("frame");
    await second!.send("Page.getFrameTree");
    expect(sent.at(-1)).toEqual({ tab: "p2", method: "Page.getFrameTree", params: {}, session: "F00D" });
    await connection.session("pane-p1")!.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    expect(sent.at(-1)).toEqual({ tab: "p1", method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
    const version = await connection.root.send<{ product: string }>("Browser.getVersion");
    expect(version.product).toBe("Chrome/146.0.7680.0");
    await expect(connection.root.send("Storage.getCookies", {})).rejects.toThrow(/not available on a desktop pane/);
    connection.close();
  });

  it("sends a viewer's screencast frames to that viewer only, and stops the screencast when the last one leaves", async () => {
    const sent: Array<{ tab: string; method: string; params: Record<string, unknown>; session?: string }> = [];
    const endpoint = new PaneEndpoint(channel(sent), [{ tab: "p1", target: "F1", url: "https://a.test/", title: "A" }]);
    const connection = new CdpConnection(endpoint);
    await connection.root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { sessionId } = await connection.root.send<{ sessionId: string }>("Target.attachToTarget", { targetId: "F1", flatten: true });
    const viewer = connection.session(sessionId)!;
    const frames: string[] = [];
    viewer.on("Page.screencastFrame", () => frames.push("viewer"));
    connection.session("pane-p1")!.on("Page.screencastFrame", () => frames.push("page"));
    await viewer.send("Page.startScreencast", { format: "jpeg" });
    endpoint.pageEvent("p1", "Page.screencastFrame", { data: "", sessionId: 1, metadata: {} });
    await sleep(1);
    expect(frames).toEqual(["viewer"]);
    await connection.root.send("Target.detachFromTarget", { sessionId });
    expect(sent.map((command) => command.method)).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
    connection.close();
  });

  it("tells the driver a pane is gone, crashed or closed", async () => {
    const endpoint = new PaneEndpoint(channel([]), [{ tab: "p1", target: "F1", url: "https://a.test/", title: "A" }]);
    const connection = new CdpConnection(endpoint);
    const events: string[] = [];
    for (const method of ["Target.targetCrashed", "Target.detachedFromTarget", "Target.targetDestroyed"]) connection.root.on(method, () => events.push(method));
    await connection.root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const page = connection.session("pane-p1")!;
    endpoint.tabGone("p1", true);
    await sleep(1);
    expect(events).toEqual(["Target.targetCrashed", "Target.detachedFromTarget", "Target.targetDestroyed"]);
    expect(page.detached).toBe(true);
    endpoint.closed("the app window closed");
    expect(connection.closed).toBe(true);
  });
});
