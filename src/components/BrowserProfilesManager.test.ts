import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BrowserProfile } from "@/state/store";

const fixture = vi.hoisted(() => ({ profiles: [] as BrowserProfile[], bots: [] as Bot[], myChrome: true, engine: undefined as Record<string, unknown> | undefined }));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  ApiError: class extends Error {},
  useStore: () => ({
    state: { config: { browserProfiles: fixture.profiles, browserEngine: fixture.engine ?? { kind: "engine", myChrome: fixture.myChrome } }, bots: fixture.bots },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
  }),
}));
import { BrowserProfilesManager } from "./BrowserProfilesManager";

const bot = { id: "pepper", name: "Pepper", browserProfile: "work" } as Bot;
beforeEach(() => {
  fixture.profiles = [{ id: "work", name: "Work", partitionId: "LegacyWork" }];
  fixture.bots = [bot, { id: "scout", name: "Scout", browserProfile: "work" } as Bot];
  fixture.myChrome = true;
  fixture.engine = undefined;
});

describe("browser profile manager", () => {
  it("renders on the web without an Electron bridge and never exposes internal partition ids", () => {
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager));
    expect(html).toContain("Create profile");
    expect(html).toContain("Work");
    expect(html).toContain("used by Pepper, Scout");
    expect(html).not.toContain("LegacyWork");
    expect(html).toMatch(/<details[^>]*\bopen/);
  });

  it("offers own, shared and temporary sessions without changing the current selection", () => {
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager, { bot }));
    expect(html).toContain('value="">Own browser</option>');
    expect(html).toContain('value="work" selected="">Work</option>');
    expect(html).toContain('value="guest"');
    expect(html).toContain("Bots on a shared profile use the same logins.");
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html.match(/<select[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("explains busy bot restrictions and deletion effects in accessible controls", () => {
    fixture.bots = [{ ...bot, busy: true }];
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager, { bot }));
    expect(html).toContain("Stop this bot&#x27;s turn before switching browser profiles.");
    expect(html).toContain('aria-label="Delete Work"');
    expect(html).toContain("Pepper is still running.");
    expect(html).toContain('maxLength="40"');
  });

  it("keeps a disappeared selection explicit instead of silently displaying another login", () => {
    fixture.profiles = [];
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager, { bot }));
    expect(html).toContain("This profile was removed.");
    expect(html).toContain('value="work" disabled="" selected=""');
    expect(html).toContain("Each bot still has its own browser.");
  });

  it("offers each profile Built-in or My Chrome, and lists a built-in profile's signed-in sites with who shares them", () => {
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager));
    expect(html).toMatch(/<select[^>]*>.*?<option value="" selected="">Built-in<\/option><option value="chrome">My Chrome<\/option><\/select>/);
    expect(html).toContain("Signed-in sites");
    expect(html).toContain("Pepper, Scout share this browser: signing out here signs all of them out.");
    expect(html).not.toContain("act inside your real Chrome");
  });

  it("says plainly that a My Chrome profile's bots act in the person's real, signed-in Chrome", () => {
    fixture.profiles = [{ id: "work", name: "Work", browser: "chrome" }];
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager));
    expect(html).toContain('<option value="chrome" selected="">My Chrome</option>');
    expect(html).toContain("Bots on this profile act inside your real Chrome, signed in as you");
    expect(html).toContain("chrome://inspect/#remote-debugging");
    expect(html).not.toContain("Signed-in sites");
    const botHtml = renderToStaticMarkup(createElement(BrowserProfilesManager, { bot }));
    expect(botHtml).toContain("act inside your real Chrome");
  });

  it("says on Cloud and servers that My Chrome does not apply, and keeps the built-in browser", () => {
    fixture.myChrome = false;
    fixture.profiles = [{ id: "work", name: "Work", browser: "chrome" }];
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager));
    expect(html).toContain('<option value="chrome" disabled="" selected="">My Chrome</option>');
    expect(html).toContain("My Chrome is for the desktop app, where bots run on your own computer. Anywhere else, such as the Cloud, there is no Chrome of yours to use, so every profile uses the built-in browser.");
    expect(html).not.toContain("act inside your real Chrome");
    expect(html).toContain("Signed-in sites");
  });

  it("on My Cloud, My Chrome names the lent computer and says when it is offline", () => {
    fixture.engine = { myChrome: true, myChromeOn: { name: "Studio Mac", device: "Mac", online: false } };
    fixture.profiles = [{ id: "work", name: "Work", browser: "chrome" }];
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager, { bot: { ...bot, browserProfile: "work" } }));
    expect(html).toContain("the Chrome on Studio Mac, your Mac");
    expect(html).toContain("Studio Mac is offline right now.");
    expect(html).not.toMatch(/<option value="chrome" disabled/);
  });

  it("on My Cloud with nothing lent, it says how to lend Chrome", () => {
    fixture.engine = { myChrome: false, myChromeLendable: true };
    fixture.profiles = [{ id: "work", name: "Work", browser: "chrome" }];
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager));
    expect(html).toContain("turn on Your Chrome");
    expect(html).toContain("bots on a My Chrome profile can&#x27;t browse");
    expect(html).toContain("switching a profile to Built-in works too");
    expect(html).not.toContain("there is no Chrome of yours to use");
  });

  it("on My Cloud with nothing lent and every profile Built-in, it never says a profile can't browse", () => {
    fixture.engine = { myChrome: false, myChromeLendable: true };
    fixture.profiles = [{ id: "work", name: "Work" }];
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager));
    expect(html).toContain("turn on Your Chrome");
    expect(html).not.toContain("this profile&#x27;s bots");
  });

  it("on My Cloud with nothing lent, a My Chrome profile shows the My Chrome note and how to lend it, never a sign-ins list", () => {
    fixture.engine = { myChrome: false, myChromeLendable: true };
    fixture.profiles = [{ id: "work", name: "Work", browser: "chrome" }];
    const html = renderToStaticMarkup(createElement(BrowserProfilesManager));
    expect(html).toContain("act inside your real Chrome");
    expect(html).not.toContain("Signed-in sites");
    const botPanel = renderToStaticMarkup(createElement(BrowserProfilesManager, { bot })).split("<details")[0]!;
    expect(botPanel).toContain("act inside your real Chrome");
    expect(botPanel).toContain("turn on Your Chrome");
    expect(botPanel).not.toContain("Signed-in sites");
  });

  it("lists the bot's own browser's sites, shared by nobody, and none for a temporary browser", () => {
    fixture.bots = [{ ...bot, browserProfile: undefined }];
    const own = renderToStaticMarkup(createElement(BrowserProfilesManager, { bot: fixture.bots[0] }));
    expect(own.match(/Signed-in sites/g)).toHaveLength(2);
    expect(own).not.toContain("share this browser");
    fixture.bots = [{ ...bot, browserProfile: "guest" }];
    const guest = renderToStaticMarkup(createElement(BrowserProfilesManager, { bot: fixture.bots[0] }));
    expect(guest.match(/Signed-in sites/g)).toHaveLength(1);
  });
});
