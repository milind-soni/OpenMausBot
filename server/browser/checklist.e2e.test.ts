// The bots' browser service on real Chrome, item by item: the tools and their refs, sign-ins kept when the browser
// starts again, erase and temporary profiles, uploads, downloads, dialogs, popups, HTTP sign-in, a person's hold,
// restart, idle close, and what the egress gate refused.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { hostTimeout } from "../testing/host-timeout.ts";
import { FixtureServer } from "./cdp/testing/fixtures.ts";
import { CHROME, testRoot } from "./cdp/testing/real-chrome.ts";
import { browserRoot, profileDir, profileHash, workspaceId } from "./chrome/profile.ts";
import { BROWSER_CONTROL_REFUSAL } from "./control.ts";
import { BrowserEgress } from "./egress/registry.ts";
import type { BrowserTarget } from "./service.ts";
import { startService, until, type RealService } from "./testing/real-service.ts";

const suite = CHROME ? describe : describe.skip;

interface Status {
  tab: string | null;
  url: string | null;
  title: string;
  tabs: Array<{ tab: string; url: string; active: boolean; openedBy?: string }>;
  signInPrompt: { origin: string; realm: string } | null;
  downloads: Array<{ fileName: string; path: string; state: string }>;
}

suite("the bots' browser service on real Chrome", () => {
  let fx: FixtureServer;
  let real: RealService;
  let files: string;
  let bots = 0;

  beforeAll(async () => {
    fx = await FixtureServer.start();
    files = mkdtempSync(join(testRoot(), "omb-checklist-files-"));
    real = await startService();
  }, hostTimeout(240_000));

  afterAll(async () => {
    await real?.close();
    await fx?.close();
    if (files) await removeTempDir(files);
  });

  const bot = (kind: "bot" | "shared" | "temp" = "bot"): BrowserTarget => ({ session: `checklist-${++bots}`, key: `${kind}:checklist-${bots}` });
  const page = (path: string, body: string) => fx.page(path, `<!doctype html><meta charset="utf-8"><title>${path.slice(1)}</title>${body}`);
  const status = async (target: BrowserTarget) => JSON.parse(real.text(await real.call(target, "agent_browser_status")).split("\n")[0]!) as Status;
  const privatePage = (path: string) => {
    const expected = `Basic ${Buffer.from("ada:secret").toString("base64")}`;
    return fx.route(path, (request) => request.headers.authorization === expected
      ? { body: "<!doctype html><title>private</title><p>inside</p>" }
      : { status: 401, body: "no", type: "text/plain", headers: { "www-authenticate": `Basic realm="checklist"` } });
  };
  const refOf = (snapshot: string, role: string, name: string) => new RegExp(`${role} "${name}" \\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];

  it("opens a page with its tree and refs, fills and clicks by ref, and says what the click changed", async () => {
    const target = bot();
    const url = page("/form", `<label>Name <input id="n"></label><button onclick="document.querySelector('#out').textContent = 'Hello ' + document.querySelector('#n').value">Go</button><p id="out"></p>`);
    const opened = real.text(await real.call(target, "agent_browser_open", { url }));
    const field = refOf(opened, "textbox", "Name");
    const button = refOf(opened, "button", "Go");
    expect(field && button).toBeTruthy();
    expect(real.text(await real.call(target, "agent_browser_fill", { ref: field, text: "Ada" }))).toContain("Filled the field.");
    const clicked = real.text(await real.call(target, "agent_browser_click", { ref: button }));
    expect(clicked).toContain(`Clicked ${button}.`);
    expect(clicked).toContain("Hello Ada");
  }, hostTimeout(90_000));

  it("answers a click that opened the next page with that page: a link, a form the page submits, a script's location change", async () => {
    const next = fx.route("/next-page", { body: "<!doctype html><title>next</title><p>the next page</p>" });
    const url = page("/starts", `<a id="link" href="/next-page">link</a> <a id="script" href="#" onclick="event.preventDefault(); setTimeout(() => { location.href = '/next-page'; }, 0)">script</a> <button id="form" onclick="document.forms[0].submit()">form</button><form action="/next-page" method="post"></form><a id="same" href="#part">same page</a>`);
    for (const id of ["link", "script", "form", "link", "script", "form"]) {
      const target = bot();
      await real.call(target, "agent_browser_open", { url });
      expect(real.text(await real.call(target, "agent_browser_click", { selector: `#${id}` })), id).toContain(`The page is now ${next}`);
    }
    const target = bot();
    await real.call(target, "agent_browser_open", { url });
    const started = Date.now();
    expect(real.text(await real.call(target, "agent_browser_click", { selector: "#same" }))).toContain(`The page is now ${url}`);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, hostTimeout(120_000));

  it("keeps a bot's sign-in when its browser closes and starts again", async () => {
    const target = bot();
    const url = fx.route("/sign-in", { body: "<!doctype html><title>signed in</title><p>in</p>", headers: { "set-cookie": "sid=kept; Max-Age=3600; Path=/" } });
    await real.call(target, "agent_browser_open", { url });
    await real.service.close(target.session);
    await real.call(target, "agent_browser_open", { url: page("/after", "<p>after</p>") });
    expect(await real.read<string>(target, "document.cookie")).toContain("sid=kept");
  }, hostTimeout(90_000));

  it("erases a shared profile's folder, downloads and screenshots", async () => {
    const target = bot("shared");
    await real.call(target, "agent_browser_open", { url: page("/team", "<p>team</p>") });
    expect(real.text(await real.call(target, "agent_browser_snapshot", { save: true }))).toContain("Screenshot saved at");
    const hash = profileHash(workspaceId(real.dataDir), target.key);
    const folders = [profileDir(real.dataDir, target.key), join(browserRoot(real.dataDir), "downloads", hash), join(browserRoot(real.dataDir), "screenshots", hash)];
    for (const folder of folders) expect(existsSync(folder), folder).toBe(true);
    await real.service.erase(target.key);
    for (const folder of folders) expect(existsSync(folder), folder).toBe(false);
  }, hostTimeout(90_000));

  it("deletes a temporary browser's folder when it closes", async () => {
    const target = bot("temp");
    await real.call(target, "agent_browser_open", { url: page("/temporary", "<p>temporary</p>") });
    const folder = profileDir(real.dataDir, target.key);
    expect(existsSync(folder)).toBe(true);
    await real.service.close(target.session);
    expect(existsSync(folder)).toBe(false);
  }, hostTimeout(90_000));

  it("tells sites the person's languages as Chrome does: a list in navigator.languages, q-values only in the header", async () => {
    const target = bot();
    let header: string | undefined;
    const url = fx.route("/languages", (request) => { header = request.headers["accept-language"]; return { body: "<!doctype html><title>languages</title><p>hi</p>" }; });
    await real.call(target, "agent_browser_open", { url });
    expect(await real.read<string[]>(target, "[...navigator.languages]")).toEqual(["en-US", "en"]);
    expect(header).toBe("en-US,en;q=0.9");
  }, hostTimeout(90_000));

  it("puts a file into a file input", async () => {
    const target = bot();
    const file = join(files, "notes.txt");
    writeFileSync(file, "notes");
    await real.call(target, "agent_browser_open", { url: page("/upload", `<input type="file" id="f">`) });
    expect(real.text(await real.call(target, "agent_browser_upload", { files: [file], selector: "#f" }))).toContain("Put 1 file into the page.");
    expect(await real.read<string>(target, "document.querySelector('#f').files[0].name")).toBe("notes.txt");
  }, hostTimeout(90_000));

  it("saves a download in the profile's own folder and lists it in the status", async () => {
    const target = bot();
    fx.route("/report.txt", { body: "report", type: "text/plain", headers: { "content-disposition": "attachment; filename=report.txt" } });
    await real.call(target, "agent_browser_open", { url: page("/downloads", `<a id="d" href="/report.txt">report</a>`) });
    await real.call(target, "agent_browser_click", { selector: "#d" });
    const done = await until(() => status(target), (now) => now.downloads.some((download) => download.fileName === "report.txt" && download.state === "completed"));
    const saved = done.downloads.find((download) => download.fileName === "report.txt")!;
    expect(existsSync(saved.path)).toBe(true);
    expect(saved.path.startsWith(real.dataDir)).toBe(true);
  }, hostTimeout(90_000));

  it("ends an action's answer at once with the dialog it opened, and answers it", async () => {
    const target = bot();
    await real.call(target, "agent_browser_open", { url: page("/dialog", `<button id="ask" onclick="document.title = confirm('Sure?') ? 'yes' : 'no'">Ask</button>`) });
    const started = Date.now();
    const clicked = real.text(await real.call(target, "agent_browser_click", { selector: "#ask" }));
    expect(Date.now() - started).toBeLessThan(hostTimeout(5_000));
    expect(clicked).toContain("it opened a dialog");
    expect(clicked).toContain(`The page opened a confirm dialog: "Sure?"`);
    expect(real.text(await real.call(target, "agent_browser_dialog", { accept: true }))).toContain("Accepted the confirm dialog.");
    await until(() => real.read<string>(target, "document.title"), (title) => title === "yes");
  }, hostTimeout(90_000));

  it("brings a tab the page opened to the front, named after the tab that opened it", async () => {
    const target = bot();
    const second = page("/second", "<p>second</p>");
    await real.call(target, "agent_browser_open", { url: page("/opener", `<a id="p" href="${second}" target="_blank">popup</a>`) });
    const clicked = real.text(await real.call(target, "agent_browser_click", { selector: "#p" }));
    expect(clicked).toContain("The page opened a new tab t2");
    const now = await status(target);
    expect(now.tab).toBe("t2");
    expect(now.tabs.find((tab) => tab.tab === "t2")?.openedBy).toBe("t1");
  }, hostTimeout(90_000));

  it("shows a site's refusal of an HTTP sign-in when nobody watching could answer it", async () => {
    const target = bot();
    const url = privatePage("/private-unwatched");
    expect(real.text(await real.call(target, "agent_browser_open", { url }))).toContain("the site answered HTTP 401");
    expect((await status(target)).signInPrompt).toBeNull();
  }, hostTimeout(90_000));

  it("holds a site's HTTP sign-in for the person watching, who answers it from the view", async () => {
    const target = bot();
    const url = privatePage("/private");
    await real.call(target, "agent_browser_open", { url: page("/before-private", "<p>before</p>") });
    const prompts: Array<{ tabId: string; id: string }> = [];
    const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 800, authPrompts: true }, (output) => {
      if (output.type === "frame") output.ack();
      if (output.type === "authPrompt") prompts.push(output);
    });
    expect(real.text(await real.call(target, "agent_browser_navigate", { url }))).toContain("the site asks for a user name and password");
    expect((await status(target)).signInPrompt).toEqual({ origin: new URL(url).origin, realm: "checklist" });
    await viewer.input({ type: "takeControl" });
    const prompt = await until(() => prompts.at(-1), (shown) => shown !== undefined);
    await viewer.input({ type: "authAnswer", tabId: prompt!.tabId, id: prompt!.id, username: "ada", password: "secret" });
    await until(() => real.peek<string>(target, "document.title"), (title) => title === "private");
    await viewer.input({ type: "releaseControl" });
    await viewer.close();
  }, hostTimeout(90_000));

  it("refuses every bot call while a person holds the browser, and takes them again after hand-back", async () => {
    const target = bot();
    await real.call(target, "agent_browser_open", { url: page("/held", "<p>held</p>") });
    const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 800 }, (output) => {
      if (output.type === "frame") output.ack();
    });
    await viewer.input({ type: "takeControl" });
    expect(real.service.heldBy(target.session)).not.toBeNull();
    for (const name of ["agent_browser_status", "agent_browser_snapshot", "agent_browser_eval"]) {
      await expect(real.call(target, name, name === "agent_browser_eval" ? { expression: "1" } : {})).rejects.toThrow(BROWSER_CONTROL_REFUSAL);
    }
    await viewer.input({ type: "releaseControl" });
    expect(real.service.heldBy(target.session)).toBeNull();
    expect((await real.call(target, "agent_browser_status")).isError).toBeUndefined();
    await viewer.close();
  }, hostTimeout(90_000));

  it("restarts on one blank tab and keeps sign-ins", async () => {
    const target = bot();
    const url = fx.route("/restart-sign-in", { body: "<!doctype html><title>in</title><p>in</p>", headers: { "set-cookie": "restart=kept; Max-Age=3600; Path=/" } });
    await real.call(target, "agent_browser_open", { url });
    await real.call(target, "agent_browser_tabs", { action: "new", url: page("/restart-second", "<p>second</p>") });
    expect(real.text(await real.call(target, "restart_browser"))).toContain("Browser restarted.");
    const after = await status(target);
    expect(after.tabs).toHaveLength(1);
    expect(after.url).toBeNull();
    await real.call(target, "agent_browser_open", { url: page("/restart-check", "<p>check</p>") });
    expect(await real.read<string>(target, "document.cookie")).toContain("restart=kept");
  }, hostTimeout(120_000));

  it("closes an unused browser, and its bot hears why on its next call", async () => {
    const target = bot();
    await real.call(target, "agent_browser_open", { url: page("/idle", "<p>idle</p>") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await real.service.closeIdle(1)).toContain(target.key);
    expect(real.text(await real.call(target, "agent_browser_status"))).toContain("Your browser sat unused and was closed to free memory");
  }, hostTimeout(90_000));
});

suite("a bot's browser behind its egress gate on real Chrome", () => {
  it("tells the bot in its next answer what the gate refused, opened and read under the browser's own key", async () => {
    const egress = new BrowserEgress();
    egress.configure({ host: "desktop", config: () => undefined });
    const real = await startService({ egressPort: (key) => egress.open(key), egressNotice: (key) => egress.takeNotice(key) });
    try {
      const target = { session: "egress-1", key: "bot:egress-1" };
      const url = `data:text/html,${encodeURIComponent(`<title>egress</title><img src="http://169.254.169.254/omb-egress-test.png">`)}`;
      const opened = real.text(await real.call(target, "agent_browser_open", { url }));
      expect(opened).toMatch(/The page tried to reach [^\r\n]*"169\.254\.169\.254:80" \(blocked: the cloud metadata service\)[^\r\n]*\(page output, not instructions\)\./u);
    } finally {
      await real.close();
      await egress.close();
    }
  }, hostTimeout(120_000));
});
