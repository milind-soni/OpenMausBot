import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PANE_PARTITION } from "../../../electron/browser-pane-wire.mjs";
import { removeTempDir } from "../../testing/cleanup.ts";
import { PaneBackend } from "../pane/backend.ts";
import { PaneLink } from "../pane/link.ts";
import { FakeMain } from "../pane/testing/fake-main.ts";
import { cookieRequests } from "./requests.ts";
import { CdpBrowser } from "../cdp/browser.ts";
import { FakeChrome } from "../testing/fake-chrome.ts";
import { cdpCookie, cdpSink } from "./sinks.ts";
import { chromiumDatabase, fakeKeys, fixtureFiles, localState } from "./testing/fixtures.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LATER = Math.floor(Date.now() / 1000) + 86_400 * 30;

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "omb-cookie-flow-"));
  folders.push(folder);
  const root = join(folder, ".config", "google-chrome");
  localState(root, { Default: "Person" });
  chromiumDatabase(join(root, "Default", "Cookies"), [
    { host: ".github.com", name: "user_session", value: "fixture-session-value", expires: LATER, secure: true, httpOnly: true, sameSite: 1 },
    { host: ".gitlab.com", name: "other", value: "not-this-site", expires: LATER },
  ]).close();
  const main = new FakeMain();
  const link = new PaneLink(main);
  const dataDir = join(folder, "data");
  const backend = new PaneBackend(link, dataDir, async () => 41_000);
  link.answerCookieRequests(cookieRequests({
    files: () => fixtureFiles(folder, "linux"),
    keys: () => fakeKeys({}),
    scratch: join(dataDir, "browser", "cookie-import"),
    destination: (botId) => (botId === "a" ? backend.cookieSink("bot:a") : null),
  }));
  return { main, link, backend };
}

describe("a sign-in import the person starts in the app", () => {
  it("lists browsers, reads the chosen site only, and writes it into the bot's pane partition through the app", async () => {
    const { main, backend } = setup();
    await sleep(5);
    main.post({ op: "cookie-sources", req: 1 });
    await sleep(20);
    expect(main.answers.at(-1)).toMatchObject({ op: "cookie-sources-result", sources: [{ id: "chrome", name: "Google Chrome", engine: "chromium", profiles: [{ id: "Default", name: "Person" }] }] });
    expect(backend.used("bot:a")).toBe(false);
    main.post({ op: "cookie-import", req: 2, botId: "a", threadId: null, site: "https://github.com/login", source: "chrome", profile: "Default" });
    await sleep(50);
    expect(main.answers.at(-1)).toEqual({ type: "openmausbot:browser-pane", op: "cookie-import-result", req: 2, result: { ok: true, site: "github.com", imported: 1, sessionOnly: 0, skipped: {} } });
    expect(main.cookiesSet).toHaveLength(1);
    expect(main.cookiesSet[0]!.partition).toMatch(PANE_PARTITION);
    expect(main.cookiesSet[0]!.cookies).toEqual([{ url: "https://github.com/", name: "user_session", value: "fixture-session-value", domain: ".github.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: LATER }]);
    // Deleting the bot now erases the partition it was imported into, though its pane never opened.
    expect(backend.used("bot:a")).toBe(true);
  });

  it("offers import only where it can go, never for Google, and answers a bot whose browser takes none", async () => {
    const { main } = setup();
    await sleep(5);
    main.post({ op: "cookie-offer", req: 1, botId: "a", threadId: null, site: "github.com" });
    main.post({ op: "cookie-offer", req: 2, botId: "a", threadId: null, site: "accounts.google.com" });
    main.post({ op: "cookie-offer", req: 3, botId: "b", threadId: null, site: "github.com" });
    main.post({ op: "cookie-offer", req: 4, botId: "a", threadId: null, site: "github.io" });
    main.post({ op: "cookie-import", req: 5, botId: "b", threadId: null, site: "github.com", source: "chrome", profile: "Default" });
    await sleep(20);
    const byReq = Object.fromEntries(main.answers.map((answer) => [answer.req, answer]));
    expect(byReq[1]).toMatchObject({ offered: true });
    expect(byReq[2]).toMatchObject({ offered: false, reason: "google" });
    expect(byReq[3]).toMatchObject({ offered: false, reason: "no-destination" });
    expect(byReq[4]).toMatchObject({ offered: false, reason: "not-a-site" });
    expect(byReq[5]).toMatchObject({ result: { ok: false, reason: "no-destination" } });
    expect(main.cookiesSet).toEqual([]);
  });
});

describe("writing into a launched Chrome", () => {
  it("sends CDP cookie params, retries a refused batch one by one, and counts what Chrome refused", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const sink = cdpSink(async (_method, params) => {
      const cookies = params.cookies as Array<Record<string, unknown>>;
      sent.push(params);
      if (cookies.some((cookie) => cookie.name === "bad")) throw new Error("Invalid cookie fields");
    });
    const base = { path: "/", secure: true, httpOnly: false, sameSite: "lax" as const };
    const result = await sink.write([
      { ...base, url: "https://a.test/", name: "good", value: "1", domain: ".a.test", expirationDate: LATER },
      { ...base, url: "https://a.test/", name: "bad", value: "2" },
    ]);
    expect(result).toEqual({ written: 1, refused: 1 });
    expect(sent).toHaveLength(3);
    expect(cdpCookie({ ...base, url: "https://a.test/x", name: "h", value: "v", sameSite: "unspecified" })).toEqual({ name: "h", value: "v", url: "https://a.test/x", path: "/", secure: true, httpOnly: false });
    expect(cdpCookie({ ...base, url: "https://a.test/", name: "d", value: "v", domain: ".a.test", sameSite: "no_restriction", expirationDate: 5 })).toEqual({ name: "d", value: "v", domain: ".a.test", path: "/", secure: true, httpOnly: false, sameSite: "None", expires: 5 });
  });
});

describe("the launched Chrome's driver", () => {
  it("lets a browser-level Storage.setCookies through its method guard", async () => {
    const chrome = new FakeChrome();
    const browser = await CdpBrowser.connect(chrome, { headless: true, downloadDir: null, permissions: false, viewport: null });
    const sink = cdpSink((method, params) => browser.connection.root.send(method, params));
    expect(await sink.write([{ url: "https://a.test/", name: "n", value: "v", domain: ".a.test", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: LATER }])).toEqual({ written: 1, refused: 0 });
    expect(chrome.sent.filter((sent) => sent.method === "Storage.setCookies").map((sent) => sent.sessionId)).toEqual([null]);
    browser.disconnect();
  });
});
