import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyManifest, applyProduct, checkManifest, checkProduct, readProduct } from "./product.mjs";

const yaml = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
const manifest = readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8");
const renamed = { name: "Acme Helper", appName: "AcmeHelper", appId: "com.acme.helper", updates: { owner: "acme", repo: "helper" } };

describe("product.json drives the installer config", () => {
  it("is what electron-builder.yml says today", () => {
    expect(checkProduct(yaml, readProduct())).toEqual([]);
    expect(checkManifest(manifest, readProduct())).toEqual([]);
  });

  it("reads a Windows checkout's CRLF files the same way", () => {
    const crlf = (text) => text.replace(/\r?\n/g, "\r\n");
    expect(checkProduct(crlf(yaml), readProduct())).toEqual([]);
    expect(checkProduct(applyProduct(crlf(yaml), renamed), renamed)).toEqual([]);
    expect(checkManifest(applyManifest(crlf(manifest), renamed), renamed)).toEqual([]);
  });

  it("renames every installer name, the app id and the update source in one pass", () => {
    const current = readProduct();
    const next = applyProduct(yaml, renamed);
    expect(checkProduct(next, renamed)).toEqual([]);
    expect(next).not.toContain(current.appName);
    expect(next).toContain("NSMicrophoneUsageDescription: AcmeHelper uses the microphone");
    expect(applyProduct(next, renamed)).toBe(next);
    const nextManifest = applyManifest(manifest, renamed);
    expect(checkManifest(nextManifest, renamed)).toEqual([]);
    expect(JSON.parse(nextManifest).icons).toEqual(JSON.parse(manifest).icons);
  });

  it("refuses a product.json that would break the installer", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-product-"));
    try {
      writeFileSync(join(dir, "product.json"), JSON.stringify({ ...renamed, appId: "Acme Helper", updates: { owner: "acme" } }));
      expect(() => readProduct(join(dir, "product.json"))).toThrow(/appId must be reverse-DNS.*updates\.owner/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
