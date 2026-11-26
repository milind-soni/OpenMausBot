// An app's server side never travels with its page: not in the bundle the frame is served from or a page is published
// from, not through a link, not by naming it.
import { cpSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PageBundleError, pageSignature, readPageBundle, skippedNote } from "../pages/bundle.ts";
import { isAppServerSide } from "./private-files.ts";

const FIXTURE = join(import.meta.dirname, "testing", "issue-tracker");

function botFolderWithApp(): { root: string; app: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ao-bundle-")));
  const app = join(root, "tracker");
  cpSync(FIXTURE, app, { recursive: true });
  return { root, app };
}

async function refusal(work: Promise<unknown>): Promise<PageBundleError> {
  try { await work; } catch (error) { if (error instanceof PageBundleError) return error; throw error; }
  throw new Error("expected a refusal");
}

describe("an app's server side and its page", () => {
  it("leaves app.json, server/ and migrations/ out when the app's folder is the page", async () => {
    const { root, app } = botFolderWithApp();
    writeFileSync(join(app, "index.html"), "<!doctype html><p>top</p>");
    writeFileSync(join(app, "server", "helper.json"), "{}");
    const bundle = await readPageBundle(app, [root]);
    expect(bundle.files.map((file) => file.path).sort()).toEqual(["index.html", "ui/index.html"]);
    expect(bundle.skipped).toEqual(expect.arrayContaining([
      { path: "app.json", why: "app" }, { path: "migrations/", why: "app" }, { path: "server/", why: "app" },
    ]));
    expect(skippedNote(bundle.skipped)).toContain("(an app's server side)");
  });

  it("does not follow a link from ui/ to the server side", async () => {
    const { root, app } = botFolderWithApp();
    symlinkSync(join("..", "server", "operations.js"), join(app, "ui", "ops.js"));
    symlinkSync(join("..", "app.json"), join(app, "ui", "manifest.json"));
    symlinkSync(join("..", "migrations"), join(app, "ui", "sql"));
    const bundle = await readPageBundle(join(app, "ui"), [root]);
    expect(bundle.files.map((file) => file.path)).toEqual(["index.html"]);
    expect(bundle.skipped.map((file) => file.why)).toEqual(["app", "app", "app"]);
  });

  it("refuses the server side named directly, in any case", async () => {
    const { root, app } = botFolderWithApp();
    writeFileSync(join(app, "server", "page.html"), "<p>x</p>");
    writeFileSync(join(app, "migrations", "notes.html"), "<p>x</p>");
    for (const path of [join(app, "server"), join(app, "server", "page.html"), join(app, "migrations", "notes.html"), "tracker/server"]) {
      expect((await refusal(readPageBundle(path, [root]))).status, path).toBe(403);
    }
    expect(isAppServerSide(join(app, "SERVER", "operations.js"), root)).toBe(true);
    expect(isAppServerSide(join(app, "App.json"), root)).toBe(true);
    expect(isAppServerSide(join(app, "ui", "index.html"), root)).toBe(false);
  });

  it("a live page does not refresh when only the server side changes", async () => {
    const { app } = botFolderWithApp();
    writeFileSync(join(app, "index.html"), "<p>top</p>");
    const before = await pageSignature(app);
    writeFileSync(join(app, "server", "operations.js"), "export async function list() { return []; }\n// changed\n");
    expect(await pageSignature(app)).toBe(before);
    expect(before).not.toMatch(/server|migrations|app\.json/);
  });
});
