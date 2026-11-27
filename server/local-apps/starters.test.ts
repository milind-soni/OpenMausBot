import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_APP_ID } from "../../shared/local-apps.ts";
import { AppDocs } from "../app-docs.ts";
import { createLocalApps } from "./service.ts";
import { bundledStarterApps, removedStartersFile, STARTER_APPS, type StarterApp, type StarterSource } from "./starters.ts";
import { localAppsFile, LocalAppsStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "omb-starters-")); dirs.push(dir); return dir; };

const chat = { messagesFor: () => [], botByThread: () => null, groupByThread: () => null, taskByThread: () => null };
const TWO: StarterApp[] = [
  { id: "la_starter_one_____", name: "One", file: "one.html" },
  { id: "la_starter_two_____", name: "Two", file: "two.html" },
];
const pages = (html: Record<string, string>): StarterSource => ({ apps: TWO, html: (app) => html[app.file] ?? null });
const open = (dataDir: string, starters?: StarterSource) => {
  const apps = createLocalApps({ chat, docs: new AppDocs(join(dataDir, "app-docs")), dataDir, ...(starters ? { starters } : {}), now: () => 1_000 });
  return apps;
};

describe("starter apps", () => {
  it("ship four pages with fixed ids, each found where the server looks", () => {
    expect(STARTER_APPS).toHaveLength(4);
    expect(new Set(STARTER_APPS.map((app) => app.id)).size).toBe(STARTER_APPS.length);
    const source = bundledStarterApps();
    for (const app of STARTER_APPS) {
      expect(app.id).toMatch(LOCAL_APP_ID);
      expect(source.html(app), app.file).toBeTruthy();
    }
  });

  it("make no outside request, keep nothing in the browser, and say they are sample data", () => {
    const source = bundledStarterApps();
    for (const app of STARTER_APPS) {
      const html = source.html(app)!;
      expect(html.match(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)]*/gi)?.filter((url) => url !== "http://www.w3.org/2000/svg") ?? [], app.file).toEqual([]);
      expect(html, app.file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|window\.hero|window\.__|fonts\.googleapis|\bfetch\(|XMLHttpRequest|WebSocket|mausbot\./);
      expect(html, app.file).toMatch(/sample data/i);
    }
  });

  it("are added once after the person's own apps, from no bot and no chat", () => {
    const dir = fresh();
    const own = new LocalAppsStore(dir).add({ name: "Mine", botId: "b1", threadId: "t1", messageId: "m1", versions: [{ rev: 0, doc: "a".repeat(64), at: 0 }], manifest: { name: "Mine" } });
    const apps = open(dir, pages({ "one.html": "<h1>One</h1>", "two.html": "<h1>Two</h1>" }));
    expect(apps.list().map((app) => app.id)).toEqual([own.id, ...TWO.map((app) => app.id)]);
    const one = apps.view(apps.get(TWO[0]!.id)!);
    expect(one).toMatchObject({ name: "One", sample: true, bot: null, botId: "", threadId: "", chat: false, rev: 0, manifest: { name: "One" } });
    expect(one.manifest.uses).toBeUndefined();
    expect(apps.document(TWO[0]!.id)?.srcdoc).toContain("<h1>One</h1>");
    expect(apps.view(apps.get(own.id)!).sample).toBeUndefined();
    const written = readFileSync(localAppsFile(dir), "utf8");
    open(dir, pages({ "one.html": "<h1>One</h1>", "two.html": "<h1>Two</h1>" }));
    expect(readFileSync(localAppsFile(dir), "utf8")).toBe(written);
  });

  it("stay removed: the removal is remembered across starts and releases", () => {
    const dir = fresh();
    const source = pages({ "one.html": "<h1>One</h1>", "two.html": "<h1>Two</h1>" });
    expect(open(dir, source).remove(TWO[0]!.id)).toBe(true);
    expect(JSON.parse(readFileSync(removedStartersFile(dir), "utf8"))).toEqual({ version: 1, ids: [TWO[0]!.id] });
    const again = open(dir, pages({ "one.html": "<h1>One, newer</h1>", "two.html": "<h1>Two</h1>" }));
    expect(again.list().map((app) => app.id)).toEqual([TWO[1]!.id]);
    expect(again.remove(TWO[1]!.id)).toBe(true);
    expect(open(dir, source).list()).toEqual([]);
    expect(JSON.parse(readFileSync(removedStartersFile(dir), "utf8")).ids).toEqual(TWO.map((app) => app.id));
  });

  it("take a changed page as a new version, keeping the person's name and kept version", () => {
    const dir = fresh();
    const first = open(dir, pages({ "one.html": "<h1>One</h1>" }));
    first.rename(TWO[0]!.id, "My one");
    first.pin(TWO[0]!.id, 0);
    const next = open(dir, pages({ "one.html": "<h1>One, newer</h1>" }));
    const one = next.view(next.get(TWO[0]!.id)!);
    expect(one).toMatchObject({ name: "My one", versions: [{ rev: 0 }, { rev: 1 }], pinnedRev: 0, rev: 0 });
    expect(next.document(TWO[0]!.id, 1)?.srcdoc).toContain("One, newer");
    expect(open(dir, pages({ "one.html": "<h1>One, newer</h1>" })).get(TWO[0]!.id)?.versions).toHaveLength(2);
  });

  it("add nothing when the saved apps or the removals can't be read", () => {
    const unreadable = fresh();
    writeFileSync(localAppsFile(unreadable), JSON.stringify({ version: 2, apps: [{ id: "la_from_a_newer_bu" }] }));
    const before = readFileSync(localAppsFile(unreadable), "utf8");
    expect(open(unreadable, pages({ "one.html": "<h1>One</h1>" })).list()).toEqual([]);
    expect(readFileSync(localAppsFile(unreadable), "utf8")).toBe(before);

    const removals = fresh();
    open(removals, pages({ "one.html": "<h1>One</h1>" }));
    writeFileSync(removedStartersFile(removals), "{not json");
    const broken = open(removals, pages({ "one.html": "<h1>One</h1>", "two.html": "<h1>Two</h1>" }));
    expect(broken.list().map((app) => app.id)).toEqual([TWO[0]!.id]);
    expect(() => broken.remove(TWO[0]!.id)).toThrow();
    expect(readFileSync(removedStartersFile(removals), "utf8")).toBe("{not json");
    expect(broken.get(TWO[0]!.id)).not.toBeNull();
  });

  it("leave out a page that isn't there, and add nothing without a source", () => {
    const dir = fresh();
    expect(open(dir, pages({ "two.html": "<h1>Two</h1>" })).list().map((app) => app.id)).toEqual([TWO[1]!.id]);
    expect(open(fresh()).list()).toEqual([]);
  });
});
