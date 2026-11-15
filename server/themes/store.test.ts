import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isRefusal, createThemeStore } from "./store.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "themes-"));
  dirs.push(dataDir);
  return { dataDir, store: createThemeStore({ dataDir }) };
}

describe("theme store", () => {
  it("keeps each person's themes and choice apart", () => {
    const { store } = fixture();
    expect(store.save("owner", "neon", { name: "Neon", canvas: "#0b1020" })).toBeNull();
    expect(store.setActive("owner", "neon")).toBeNull();
    expect(store.list("owner")).toEqual({ active: "neon", themes: [{ id: "neon", name: "Neon", hasCss: false, assets: [] }] });
    expect(store.list("p_aaaaaaaaaaaaaaaaaaaaaa")).toEqual({ active: null, themes: [] });
    expect(store.setActive("p_aaaaaaaaaaaaaaaaaaaaaa", "neon")).toMatchObject({ refusal: expect.stringContaining("neon") });
  });

  it("refuses CSS that loads from the internet, ids that are route words, and keeps names out of paths", () => {
    const { store, dataDir } = fixture();
    expect(store.save("owner", "x", { name: "X", css: "a { background: url(https://example.com/a.png) }" })).toMatchObject({ refusal: expect.stringContaining("never the internet") });
    expect(store.save("owner", "active", { name: "X" })).not.toBeNull();
    expect(store.save("owner", "../escape", { name: "X" })).not.toBeNull();
    expect(store.save("../../evil", "ok", { name: "X" })).toBeNull();
    expect(existsSync(join(dataDir, "evil"))).toBe(false);
    expect(store.list("../../evil").themes).toHaveLength(1);
  });

  it("stores images and fonts only as what they claim to be, within the caps", () => {
    const { store } = fixture();
    store.save("owner", "neon", { name: "Neon" });
    expect(store.addAsset("owner", "neon", "stars.png", PNG)).toEqual({ url: "/api/theme-assets/neon/stars.png" });
    expect(store.addAsset("owner", "neon", "spin.gif", GIF)).toEqual({ url: "/api/theme-assets/neon/spin.gif" });
    expect(store.addAsset("owner", "neon", "mark.svg", SVG)).toEqual({ url: "/api/theme-assets/neon/mark.svg" });
    expect(isRefusal(store.addAsset("owner", "neon", "fake.png", Buffer.from("<html>")))).toBe(true);
    expect(isRefusal(store.addAsset("owner", "neon", "page.html", Buffer.from("<html>")))).toBe(true);
    expect(isRefusal(store.addAsset("owner", "neon", "../x.png", PNG))).toBe(true);
    expect(isRefusal(store.addAsset("owner", "neon", "big.png", Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)])))).toBe(true);
    expect(isRefusal(store.addAsset("owner", "missing", "a.png", PNG))).toBe(true);
    expect(store.asset("owner", "neon", "stars.png")).toMatchObject({ type: "image/png", bytes: PNG.byteLength });
    expect(store.asset("owner", "neon", "../theme.json")).toBeNull();
    expect(store.asset("someone-else", "neon", "stars.png")).toBeNull();
  });

  it("exports with files inlined and imports them again under a free id, CSS pointed at the new copy", () => {
    const { store } = fixture();
    store.save("owner", "neon", { name: "Neon", css: '[data-look="app"] { background: url("/api/theme-assets/neon/stars.png") }' });
    store.addAsset("owner", "neon", "stars.png", PNG);
    const exported = store.exportTheme("owner", "neon")!;
    expect(exported.assets?.["stars.png"]).toMatch(/^data:image\/png;base64,/);
    const imported = store.importTheme("owner", exported);
    expect(imported).toEqual({ id: "neon-2" });
    expect(store.read("owner", "neon-2")?.css).toContain("/api/theme-assets/neon-2/stars.png");
    expect(store.asset("owner", "neon-2", "stars.png")?.bytes).toBe(PNG.byteLength);
    const copy = store.duplicate("owner", "neon", "Neon copy");
    expect(copy).toEqual({ id: "neon-copy" });
    expect(store.read("owner", "neon-copy")?.css).toContain("/api/theme-assets/neon-copy/stars.png");
  });

  it("deleting the worn theme takes it off", () => {
    const { store } = fixture();
    store.save("owner", "neon", { name: "Neon" });
    store.setActive("owner", "neon");
    store.remove("owner", "neon");
    expect(store.list("owner")).toEqual({ active: null, themes: [] });
  });
});
