import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { forbiddenCommand } from "./cdp/testing/real-chrome.ts";
import { BROWSER_CONTROL_REFUSAL } from "./control.ts";
import { REDDIT_REFUSAL } from "./egress/reddit.ts";
import { BrowserService, type BrowserServiceOptions } from "./service.ts";
import type { Backend } from "./backends.ts";
import { FakeBackend, FakeChrome, type FakeDocument, type FakePage } from "./testing/fake-chrome.ts";
import { TOOL_LIST } from "./tools.ts";

const folders: string[] = [];
const services: BrowserService[] = [];
const backends: FakeBackend[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.closeAll())); });
afterAll(async () => {
  for (const folder of folders) await removeTempDir(folder);
  const forbidden = backends.flatMap((backend) => backend.chromes.flatMap((chrome) => chrome.sent)).filter((sent) => forbiddenCommand({ ...sent, pageWorld: false }));
  expect(forbidden).toEqual([]);
});

const FORM: FakeDocument = {
  title: "Sign up",
  text: "Sign up\nName\nGo",
  elements: [
    { role: "heading", name: "Sign up", box: [10, 10, 300, 40] },
    { role: "textbox", name: "Name", selector: "#name", editable: true, value: "", box: [10, 60, 200, 30] },
    { role: "button", name: "Go", selector: "#go", box: [10, 100, 80, 30], onClick: (page) => { page.text += "\nHello"; } },
    { role: "link", name: "Help", selector: "#help", box: [10, 140, 80, 20] },
  ],
};

/** Two buttons, each noting its click on the page. */
const swapPage = (): FakeDocument => ({
  title: "Swap",
  text: "A B",
  elements: [
    { role: "button", name: "A", selector: "#a", box: [100, 100, 300, 120], onClick: (page) => { page.text += "\nclicked A"; } },
    { role: "button", name: "B", selector: "#b", box: [100, 300, 300, 120], onClick: (page) => { page.text += "\nclicked B"; } },
  ],
});

function documents(url: string): FakeDocument {
  if (url.endsWith("/form")) return FORM;
  if (url.endsWith("/swap")) return swapPage();
  return { title: url.split("/").pop() ?? "", text: `page ${url}`, elements: [] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(options: Partial<BrowserServiceOptions> = {}, startUrls?: string[]) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-browser-service-"));
  folders.push(dataDir);
  const backend = new FakeBackend(() => new FakeChrome({ documents, ...(startUrls ? { startUrls } : {}) }));
  backends.push(backend);
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 200, ...options });
  services.push(service);
  const target = { session: "bot-a", key: "bot:a" };
  const call = async (name: string, args: Record<string, unknown> = {}, on = target) =>
    service.agentRpc(on, "tools/call", { name, arguments: args }) as Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? `[${part.type}]`).join("\n");
  return { service, backend, target, call, text, dataDir };
}

describe("the bots' browser tools", () => {
  it("advertises 21 tools and restart_browser, with OpenMausBot's names and no launch settings", async () => {
    const { service, target } = setup();
    const listed = await service.agentRpc(target, "tools/list", {}) as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_LIST.map((tool) => tool.name));
    expect(listed.tools).toHaveLength(22);
    for (const tool of listed.tools) {
      for (const owned of ["session", "extraArgs", "headed", "path", "allowedDomains"]) expect(tool.inputSchema.properties ?? {}).not.toHaveProperty(owned);
    }
  });

  it("opens a page and answers with its tree and refs, then acts on those refs and says what changed", async () => {
    const { call, text } = setup();
    const opened = text(await call("agent_browser_open", { url: "https://example.com/form" }));
    expect(opened).toContain("Opened https://example.com/form in t1.");
    expect(opened).toContain(`textbox "Name" [ref=e1]`);
    expect(opened).toContain(`button "Go" [ref=e2]`);
    expect(text(await call("agent_browser_fill", { ref: "e1", text: "Ada" }))).toContain("Filled the field.");
    const clicked = text(await call("agent_browser_click", { ref: "e2" }));
    expect(clicked).toContain("Clicked e2.");
    expect(clicked).toContain(`Text that appeared on the page: "Hello".`);
  });

  it("accepts the names agent-browser advertised, with their arguments", async () => {
    const { call, text } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    expect(text(await call("agent_browser_get_url"))).toBe("https://example.com/form");
    expect(text(await call("agent_browser_get_title"))).toBe("Sign up");
    expect(text(await call("agent_browser_click", { selector: "@e2", newTab: false }))).toContain("Clicked");
    expect(text(await call("agent_browser_get_text", { selector: "#go" }))).toContain("Go");
    expect((await call("agent_browser_wait_ms", { ms: 1 })).isError).toBeUndefined();
    expect(text(await call("agent_browser_tab_list"))).toContain(`"tab":"t1"`);
    expect(text(await call("agent_browser_back"))).toContain("t1 is now at");
    const unknown = await call("agent_browser_teleport");
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("There is no browser tool named agent_browser_teleport.");
  });

  it("says how a screenshot's pixels map to the CSS pixels a point takes, and refuses a point outside the viewport as it is now", async () => {
    const { service, call, text, target, backend } = setup();
    await call("agent_browser_open", { url: "https://example.com/swap" });
    expect(text(await call("agent_browser_screenshot"))).toContain("Screenshot of t1: \"Swap\" at https://example.com/swap, 1280x800 pixels, one per CSS pixel of the viewport");
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 800, maxHeight: 1500, size: { width: 400, height: 750 } }, (output) => {
      if (output.type === "frame") output.ack();
    });
    await sleep(20);
    expect(backend.chrome.viewport).toEqual({ width: 1280, height: 2400 });
    expect(text(await call("agent_browser_screenshot"))).toContain("794x1488 pixels: the 1280x2400 CSS-pixel viewport drawn at 0.62, so divide x and y read off it by 0.62");
    expect(text(await call("agent_browser_click", { x: 200, y: 2000 }))).toContain("Clicked 200,2000.");
    await viewer.close();
    await sleep(20);
    const refused = await call("agent_browser_click", { x: 200, y: 2000 });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("200,2000 is outside the page's viewport, which is 1280x800 CSS pixels now. Take a new screenshot and aim inside it.");
    expect((await call("agent_browser_hover", { x: 1280, y: 10 })).isError).toBe(true);
    expect((await call("agent_browser_drag", { from: { x: 10, y: 10 }, to: { x: 10, y: 900 } })).isError).toBe(true);
    expect((await call("agent_browser_click", { x: 1279, y: 799 })).isError).toBeUndefined();
  });

  it("names a tab the page opened, which comes to the front", async () => {
    const { call, text, backend } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    const page = [...backend.chrome.pages.values()].find((candidate) => candidate.url.endsWith("/form"))!;
    page.elements[3]!.onClick = (opener: FakePage) => { backend.chrome.popup(opener, "https://example.com/popup"); };
    const clicked = text(await call("agent_browser_click", { ref: "e3" }));
    expect(clicked).toMatch(/The page opened a new tab t2 at https:\/\/example\.com\/popup, now in front/);
    const status = JSON.parse(text(await call("agent_browser_status"))) as { tab: string; tabs: Array<{ tab: string; openedBy?: string }> };
    expect(status.tab).toBe("t2");
    expect(status.tabs.find((tab) => tab.tab === "t2")?.openedBy).toBe("t1");
  });

  it("aims a click where its element is once the pointer people watch has moved there, not where it was before", async () => {
    const { service, call, text, target, backend } = setup();
    const opened = text(await call("agent_browser_open", { url: "https://example.com/swap" }));
    const a = /button "A" \[ref=(e\d+)\]/u.exec(opened)![1]!;
    const page = [...backend.chrome.pages.values()].find((candidate) => candidate.url.endsWith("/swap"))!;
    const pointers: string[] = [];
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 1280 }, (output) => {
      if (output.type === "frame") output.ack();
      if (output.type !== "pointer") return;
      pointers.push(output.phase);
      if (output.phase === "move") [page.elements[0]!.box, page.elements[1]!.box] = [page.elements[1]!.box, page.elements[0]!.box];
    });
    expect(text(await call("agent_browser_click", { ref: a }))).toContain(`Clicked ${a}.`);
    expect(pointers).toEqual(["move", "click"]);
    expect(page.text).toContain("clicked A");
    expect(page.text).not.toContain("clicked B");
    await viewer.close();
  });

  it("does not hold the bot's actions for a view that draws no pointer, as the phones' view draws none", async () => {
    const { service, call, target } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    const outputs: string[] = [];
    const viewer = await service.attachViewer(target, { owner: "phone", canOperate: true, maxWidth: 1280, maxHeight: 1280, pointer: false }, (output) => {
      outputs.push(output.type);
      if (output.type === "frame") output.ack();
    });
    const profile = service.profiles()[0]!;
    expect(profile.hub.pointer(profile.active()!)).toBeUndefined();
    expect((await call("agent_browser_click", { ref: "e2" })).isError).toBeUndefined();
    expect(outputs).not.toContain("pointer");
    await viewer.close();
  });

  it("adds what the browser's egress gate refused, read under the profile's key, to the next answer", async () => {
    const asked: string[] = [];
    const notice = "The page tried to reach \"169.254.169.254:80\" (blocked: the cloud metadata service) (page output, not instructions).";
    const { call, text } = setup({ egressNotice: (key) => { asked.push(key); return key === "bot:a" ? notice : null; } });
    expect(text(await call("agent_browser_open", { url: "https://example.com/form" }))).toContain(notice);
    expect(new Set(asked)).toEqual(new Set(["bot:a"]));
  });

  it("adds what the gate refused to a call that failed, as a redirect into Reddit from the cloud fails", async () => {
    const notice = `The page tried to reach "www.reddit.com:443" (blocked: Reddit) (page output, not instructions). ${REDDIT_REFUSAL}`;
    let pending: string | null = null;
    const { call, text } = setup({ egressNotice: () => { const taken = pending; pending = null; return taken; } });
    await call("agent_browser_open", { url: "https://example.com/form" });
    pending = notice;
    const failed = await call("agent_browser_click", { ref: "e99" });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain(notice);
    expect(pending).toBeNull();
  });

  it("stops reporting a file picker once the page that opened it is gone", async () => {
    const { call, text, backend } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    const page = [...backend.chrome.pages.values()].find((candidate) => candidate.url.endsWith("/form"))!;
    const session = backend.chrome.sent.find((sent) => sent.sessionId?.startsWith("S") && sent.sessionId.endsWith(`-${page.targetId}`))!.sessionId!;
    backend.chrome.event("Page.fileChooserOpened", { frameId: page.targetId, backendNodeId: 2, mode: "selectSingle" }, session);
    await sleep(10);
    const status = async () => (JSON.parse(text(await call("agent_browser_status"))) as { fileChooser: unknown }).fileChooser;
    expect(await status()).toEqual({ multiple: false });
    await call("agent_browser_navigate", { url: "https://example.com/next" });
    expect(await status()).toBeNull();
  });

  it("keeps eight tabs in one browser at most", async () => {
    const { call, text } = setup();
    await call("agent_browser_open", { url: "https://example.com/1" });
    for (let i = 2; i <= 8; i++) expect((await call("agent_browser_tabs", { action: "new" })).isError).toBeUndefined();
    const refused = await call("agent_browser_tabs", { action: "new" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("already has 8 tabs open");
  });
});

describe("a person and the bot sharing one browser", () => {
  it("refuses every bot call while a person holds the browser, reads included, and lets the bot back on release", async () => {
    const { service, call, target } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 2560, maxHeight: 1600 }, () => {});
    await viewer.input({ type: "takeControl" });
    expect(service.heldBy("bot-a")).toBe("local-owner");
    for (const name of ["agent_browser_status", "agent_browser_snapshot", "agent_browser_click", "agent_browser_eval", "agent_browser_dialog"]) {
      await expect(call(name, name === "agent_browser_click" ? { ref: "e2" } : name === "agent_browser_eval" ? { expression: "1" } : name === "agent_browser_dialog" ? { accept: true } : {})).rejects.toThrow(BROWSER_CONTROL_REFUSAL);
    }
    await viewer.input({ type: "releaseControl" });
    expect(service.heldBy("bot-a")).toBeNull();
    expect((await call("agent_browser_status")).isError).toBeUndefined();
  });

  it("waits for the bot's running action before the person's control starts, and turns that action's answer into the refusal", async () => {
    const { service, call, target, backend } = setup({ takeoverMs: 2_000 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    backend.chrome.delay = (method) => (method === "Accessibility.getFullAXTree" ? 300 : 0);
    const snapshot = call("agent_browser_snapshot").catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 2560, maxHeight: 1600 }, () => {});
    const taking = viewer.input({ type: "takeControl" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(service.heldBy("bot-a")).toBe("local-owner");
    expect(viewer.controlState().controlling).toBe(false);
    await taking;
    expect(viewer.controlState().controlling).toBe(true);
    expect(service.interrupted("bot-a")).toBe(false);
    expect(String(await snapshot)).toContain(BROWSER_CONTROL_REFUSAL);
  });

  it("grants control after the drain anyway when bot work outlasts it, and marks the browser uncertain", async () => {
    const { service, call, text, target, backend } = setup({ takeoverMs: 50, callBudgetMs: 400 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    backend.chrome.hang = (method) => method === "Accessibility.getFullAXTree";
    const stuck = call("agent_browser_snapshot").catch((error: unknown) => error);
    await sleep(20);
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 2560, maxHeight: 1600 }, () => {});
    await viewer.input({ type: "takeControl" });
    expect(viewer.controlState().controlling).toBe(true);
    expect(service.interrupted("bot-a")).toBe(true);
    await viewer.input({ type: "releaseControl" });
    expect(service.heldBy("bot-a")).toBeNull();
    expect(JSON.stringify(await stuck)).toContain("The browser did not answer this agent_browser_snapshot call.");
    expect(text(await call("agent_browser_status"))).toContain("still busy with an earlier agent_browser_snapshot call");
  });

  it("leaves the browser recoverable when a takeover outlasted a bot call: the next call says so, the one after runs", async () => {
    const { service, call, text, target } = setup({ takeoverMs: 50 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    const waiting = call("agent_browser_wait", { ms: 1_000 }).catch((error: unknown) => error);
    await sleep(20);
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 2560, maxHeight: 1600 }, () => {});
    await viewer.input({ type: "takeControl" });
    expect(service.interrupted("bot-a")).toBe(true);
    expect(String(await waiting)).toContain(BROWSER_CONTROL_REFUSAL);
    await viewer.input({ type: "releaseControl" });
    const recovered = await call("agent_browser_status");
    expect(text(recovered)).toContain("The browser answers again: the earlier agent_browser_wait call");
    expect(service.interrupted("bot-a")).toBe(false);
    const after = await call("agent_browser_status");
    expect(after.isError).toBeUndefined();
    expect(text(after)).toContain(`"tab":"t1"`);
  });

  it("releases every key and button a person left held, on hand-back and when the viewer leaves", async () => {
    const { service, call, target, backend } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 2560, maxHeight: 1600 }, () => {});
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "key", action: "down", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    await viewer.input({ type: "mouse", action: "down", x: 20, y: 20, button: "left", clickCount: 1 });
    await viewer.input({ type: "releaseControl" });
    const sent = backend.chrome.sent.filter((command) => command.sessionId?.startsWith("V"));
    expect(sent).toContainEqual(expect.objectContaining({ method: "Input.dispatchKeyEvent", params: expect.objectContaining({ type: "keyUp", code: "ShiftLeft" }) }));
    expect(sent).toContainEqual(expect.objectContaining({ method: "Input.dispatchMouseEvent", params: expect.objectContaining({ type: "mouseReleased", button: "left" }) }));
    expect(service.interrupted("bot-a")).toBe(false);
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 });
    await viewer.close();
    expect(backend.chrome.sent.filter((command) => command.method === "Input.dispatchKeyEvent" && command.params.type === "keyUp" && command.params.code === "KeyA")).toHaveLength(1);
    expect(service.heldBy("bot-a")).toBeNull();
  });

  it("hands the browser back when a sign-in card is marked Done from any device", async () => {
    const { service, call, target } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    const viewer = await service.attachViewer(target, { owner: "phone", canOperate: true, maxWidth: 1280, maxHeight: 1280 }, () => {});
    await viewer.input({ type: "takeControl" });
    await service.handBack("bot-a");
    expect(service.heldBy("bot-a")).toBeNull();
  });

  it("treats evaluation as an action: refused while held, refused while a filled password may be on the page", async () => {
    const { service, call, text, target } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    expect(text(await call("agent_browser_eval", { expression: "document.title", world: "isolated" }))).toBe(`"Sign up"`);
    await service.withSecretInput(target, async () => ({ ok: true, text: "filled", held: { url: "https://example.com/form", ms: 60_000 } }));
    const refused = await call("agent_browser_eval", { expression: "1" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("agent_browser_eval is refused here for now");
  });

  it("keeps a filled password's hold on the tab it was typed in while the bot reads another tab", async () => {
    const { service, call, text, target } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    await service.withSecretInput(target, async () => ({ ok: true, text: "filled", held: { url: "https://example.com/form", ms: 60_000 } }));
    await call("agent_browser_tabs", { action: "new", url: "https://example.com/other" });
    expect(text(await call("agent_browser_eval", { expression: "document.title", tab: "t2" }))).toBe(`"other"`);
    const refused = await call("agent_browser_eval", { expression: "document.title", tab: "t1" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("agent_browser_eval is refused here for now");
  });
});

describe("a call the browser never answers", () => {
  it("counts as lost: the next call checks the browser first and says it recovered, without running", async () => {
    const { call, text, backend } = setup({ callBudgetMs: 150 });
    await call("agent_browser_open", { url: "https://example.com/form" });
    backend.chrome.hang = (method) => method === "Accessibility.getFullAXTree";
    const lost = await call("agent_browser_snapshot");
    expect(lost.isError).toBe(true);
    expect(text(lost)).toContain("The browser did not answer this agent_browser_snapshot call.");
    const busy = await call("agent_browser_status");
    expect(text(busy)).toContain("still busy with an earlier agent_browser_snapshot call");
  });

  it("refuses a restart while bot work runs, and restarts on one blank tab", async () => {
    const { service, call, text, backend } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    await call("agent_browser_tabs", { action: "new", url: "https://example.com/two" });
    backend.chrome.delay = (method) => (method === "Accessibility.getFullAXTree" ? 300 : 0);
    const slow = call("agent_browser_snapshot");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(service.restart("bot-a", "local-owner")).rejects.toThrow(/busy/);
    await slow;
    backend.chrome.delay = () => 0;
    expect(text(await call("restart_browser"))).toContain("Browser restarted.");
    expect(backend.opened.at(-1)?.fresh).toBe(false);
    const after = JSON.parse(text(await call("agent_browser_status"))) as { tabs: unknown[] };
    expect(backend.opened.at(-1)?.fresh).toBe(true);
    expect(after.tabs).toHaveLength(1);
  });
});

describe("browsers on one computer", () => {
  it("closes an unused browser, and its bot hears why on its next call", async () => {
    const { service, call, text, backend } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await service.closeIdle(1)).toEqual(["bot:a"]);
    expect(backend.chromes).toHaveLength(1);
    const reopened = text(await call("agent_browser_status"));
    expect(reopened).toContain("Your browser sat unused and was closed to free memory");
    expect(backend.chromes).toHaveLength(2);
  });

  it("closes a running browser at once when nothing uses it, and never one a person holds", async () => {
    const { service, call, text, target, backend } = setup();
    expect(service.runs(target.session)).toBe(false);
    await call("agent_browser_open", { url: "https://example.com/form" });
    expect(service.runs(target.session)).toBe(true);
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 1280 }, (output) => {
      if (output.type === "frame") output.ack();
    });
    await viewer.input({ type: "takeControl" });
    expect(await service.closeUnused(target.session)).toBe(false);
    await viewer.input({ type: "releaseControl" });
    await viewer.close();
    expect(await service.closeUnused(target.session)).toBe(true);
    expect(service.runs(target.session)).toBe(false);
    expect(await service.closeUnused(target.session)).toBe(false);
    expect(text(await call("agent_browser_status"))).toContain("Your browser sat unused and was closed to free memory");
    expect(backend.chromes).toHaveLength(2);
  });

  it("closes a browser people only watch once it sat unused, leaving their view asleep until the bot's next call wakes it", async () => {
    const { service, call, text, target, backend } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    await sleep(25);
    const outputs: string[] = [];
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 1280 }, (output) => {
      outputs.push(output.type);
      if (output.type === "frame") output.ack();
    });
    expect(await service.closeIdle(20)).toEqual([]);
    await sleep(25);
    expect(await service.closeIdle(20)).toEqual(["bot:a"]);
    await sleep(20);
    expect(outputs).toContain("asleep");
    expect(outputs).not.toContain("gone");
    expect(service.profiles()[0]!.hub.size).toBe(1);
    expect(backend.chromes).toHaveLength(1);
    outputs.length = 0;
    expect(text(await call("agent_browser_status"))).toContain("Your browser sat unused and was closed to free memory");
    expect(backend.chromes).toHaveLength(2);
    expect(outputs).toContain("awake");
    for (let waited = 0; !outputs.includes("frame") && waited < 1_000; waited += 10) await sleep(10);
    expect(outputs).toContain("frame");
    await viewer.close();
  });

  it("counts a person's input through a view as use, never closes a browser a person holds, and starts it again when they ask", async () => {
    const { service, call, target, backend } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    const outputs: string[] = [];
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 1280 }, (output) => {
      outputs.push(output.type);
      if (output.type === "frame") output.ack();
    });
    await viewer.input({ type: "takeControl" });
    await sleep(25);
    expect(await service.closeIdle(20)).toEqual([]);
    await viewer.input({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 });
    await viewer.input({ type: "key", action: "up", key: "a", code: "KeyA", modifiers: 0 });
    await viewer.input({ type: "releaseControl" });
    expect(await service.closeIdle(20)).toEqual([]);
    await sleep(25);
    await viewer.input({ type: "resize", width: 900, height: 700 });
    expect(await service.closeIdle(20)).toEqual(["bot:a"]);
    await sleep(20);
    expect(backend.chromes).toHaveLength(1);
    await viewer.input({ type: "wake" });
    expect(backend.chromes).toHaveLength(2);
    expect(outputs.slice(outputs.indexOf("asleep"))).toContain("awake");
    expect(await service.closeIdle(20)).toEqual([]);
    await viewer.close();
  });

  it("counts a browser's start as use, so one that took long to start is not closed at once", async () => {
    let real: FakeBackend | null = null;
    const slow: Backend = { kind: "local", get caps() { return real!.caps; }, open: async (request) => { await sleep(40); return real!.open(request); } };
    const { service, target, backend } = setup({ backend: () => slow });
    real = backend;
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 1280 }, (output) => { if (output.type === "frame") output.ack(); });
    expect(await service.closeIdle(20)).toEqual([]);
    await viewer.close();
  });

  it("makes room by closing the least recently used idle browser, and waits, then refuses, when none is idle", async () => {
    const { service, call, backend } = setup({ maxRunning: 1, capacityWaitMs: 100 });
    const other = { session: "bot-b", key: "bot:b" };
    await call("agent_browser_open", { url: "https://example.com/a" });
    await call("agent_browser_open", { url: "https://example.com/b" }, other);
    expect(service.profiles().filter((profile) => profile.run).map((profile) => profile.key)).toEqual(["bot:b"]);
    const viewer = await service.attachViewer(other, { owner: "local-owner", canOperate: true, maxWidth: 2560, maxHeight: 1600 }, () => {});
    const refused = await call("agent_browser_status");
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({ text: expect.stringContaining("the most it runs at once") });
    await viewer.close();
    expect(backend.chromes.length).toBeGreaterThanOrEqual(2);
  });

  it("closes a browser that was still starting when its profile was erased or every browser closed, before either finishes", async () => {
    for (const stop of ["erase", "closeAll"] as const) {
      let real: FakeBackend | null = null;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const slow: Backend = { kind: "local", get caps() { return real!.caps; }, open: async (request) => { await gate; return real!.open(request); } };
      const { service, call, backend } = setup({ backend: () => slow });
      real = backend;
      const pending = call("agent_browser_open", { url: "https://example.com/a" });
      await sleep(10);
      const stopped = stop === "erase" ? service.erase("bot:a") : service.closeAll();
      await sleep(10);
      release();
      await stopped;
      let closed = false;
      backend.chrome.onClose(() => { closed = true; });
      expect(closed).toBe(true);
      expect(service.profiles().some((profile) => profile.run)).toBe(false);
      expect((await pending).isError).toBe(true);
    }
  });

  it("erases a deleted bot's profile folder and downloads", async () => {
    const { service, call, dataDir } = setup();
    await call("agent_browser_open", { url: "https://example.com/form" });
    const profile = service.profiles()[0]!;
    await service.erase("bot:a");
    const { existsSync } = await import("node:fs");
    expect(existsSync(profile.downloadDir)).toBe(false);
    expect(service.profiles()).toHaveLength(0);
    expect(dataDir).toBeTruthy();
  });
});
