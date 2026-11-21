import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { extensionPage, installedExtensions } from "./extensions.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(32);

function profile(extensions: Record<string, Record<string, Record<string, unknown>>>): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-extensions-"));
  folders.push(dir);
  for (const [id, versions] of Object.entries(extensions)) {
    for (const [version, manifest] of Object.entries(versions)) {
      const root = join(dir, "Default", "Extensions", id, version);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
    }
  }
  return dir;
}

describe("installed extensions", () => {
  it("lists each extension's options page, else its popup, by name", () => {
    const dir = profile({
      [A]: { "2.0": { name: "Zeta", options_page: "/settings/index.html", action: { default_popup: "popup.html" } } },
      [B]: { "1.0": { name: "Alpha", action: { default_popup: "popup.html" } } },
      [C]: { "1.0": { name: "Background only", background: { service_worker: "sw.js" } } },
      [D]: { "1.0": { name: "Elsewhere", options_page: "https://example.com/options" } },
      "not-an-id": { "1.0": { name: "Odd", options_page: "o.html" } },
    });
    expect(installedExtensions(dir)).toEqual([
      { id: B, name: "Alpha", url: `chrome-extension://${B}/popup.html` },
      { id: A, name: "Zeta", url: `chrome-extension://${A}/settings/index.html` },
    ]);
  });

  it("keeps the page inside its own extension", () => {
    const dir = profile({ [A]: { "1.0": { name: "Escape", options_page: "//" + B + "/x.html" } }, [B]: { "1.0": { name: "Up", options_page: "../../" + "x.html" } } });
    expect(installedExtensions(dir).map((extension) => new URL(extension.url).hostname)).toEqual([B]);
  });

  it("is empty for a profile with no extensions", () => {
    expect(installedExtensions(join(tmpdir(), "omb-no-such-profile"))).toEqual([]);
  });

  it("accepts only a chrome-extension:// page of a well-formed id", () => {
    expect(extensionPage(`chrome-extension://${A}/options.html`)).toBe(true);
    expect(extensionPage("chrome://settings")).toBe(false);
    expect(extensionPage("chrome-extension://short/options.html")).toBe(false);
    expect(extensionPage("https://example.com/")).toBe(false);
  });
});
