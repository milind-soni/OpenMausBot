import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
const head = new window.DOMParser().parseFromString(html, "text/html").head;

describe("phone web app installation assets", () => {
  it("links a standalone manifest whose start URL never includes pairing credentials", () => {
    const href = head.querySelector('link[rel="manifest"]')?.getAttribute("href");
    expect(href).toBeDefined();
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL(`public${href}`, root)), "utf8"));
    expect(manifest.name).toBe("OpenMausBot");
    expect(manifest.display).toBe("standalone");
    const origin = "https://workspace.example.test";
    const start = new URL(manifest.start_url, origin);
    const scope = new URL(manifest.scope, origin);
    expect(start.origin).toBe(origin);
    expect(start.href.startsWith(scope.href)).toBe(true);
    expect(start.search + start.hash).toBe("");
    expect(new URL(manifest.id, origin).origin).toBe(origin);
    expect(manifest.prefer_related_applications).not.toBe(true);
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((icon: { sizes: string }) => icon.sizes === `${size}x${size}`);
      expect(icon).toBeDefined();
      const png = readFileSync(new URL(`public${icon.src}`, root));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    }
  });

  it("offers Safari a correctly sized touch icon and a safe-area viewport", () => {
    const href = head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href");
    expect(href).toBeDefined();
    const png = readFileSync(new URL(`public${href}`, root));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
    const viewport = head.querySelector('meta[name="viewport"]')?.getAttribute("content");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).not.toMatch(/user-scalable=no|maximum-scale=1/);
  });
});
