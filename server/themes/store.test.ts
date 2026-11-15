import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LOOK_HISTORY_LIMIT } from "../../shared/theme.ts";
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

  it("records each look change with what was worn before and after, and a theme's file as it was", () => {
    const { store } = fixture();
    store.change("owner", { saves: [{ id: "neon", file: { name: "Neon", accent: "#ff2bd6" } }], wear: "neon" });
    store.addAsset("owner", "neon", "stars.png", PNG);
    store.change("owner", { saves: [{ id: "neon", file: { name: "Neon", accent: "#00ff88" } }] });
    store.change("owner", { wear: null, skin: "midnight" });
    store.change("owner", { wear: null, skin: "midnight" });
    expect(store.history("owner").map(({ index, kind, name }) => ({ index, kind, name }))).toEqual([
      { index: 1, kind: "skin", name: "midnight" },
      { index: 2, kind: "edited", name: "Neon" },
      { index: 3, kind: "made", name: "Neon" },
    ]);
    const [skin, edited, made] = store.history("owner");
    expect(skin!.look).toEqual({ id: null, skin: "midnight" });
    expect(edited!.file?.accent).toBe("#00ff88");
    expect(made!.file?.accent).toBe("#ff2bd6");
  });

  it("keeps the last 30 changes and refuses to go back further", () => {
    const { store } = fixture();
    for (let n = 1; n <= LOOK_HISTORY_LIMIT + 5; n++) store.change("owner", { saves: [{ id: "neon", file: { name: "Neon", canvas: `#0000${n.toString(16).padStart(2, "0")}` } }] });
    const items = store.history("owner");
    expect(items).toHaveLength(LOOK_HISTORY_LIMIT);
    expect(items.at(-1)!.seq).toBe(6);
    expect(store.restore("owner", 4)).toMatchObject({ refusal: expect.stringContaining("last 30") });
    expect(isRefusal(store.restore("owner", 5))).toBe(false);
    expect(store.read("owner", "neon")?.canvas).toBe("#000005");
  });

  it("goes back to the theme file and the worn theme at an earlier change, and a new store on the same folder still can", () => {
    const { store, dataDir } = fixture();
    store.save("owner", "calm", { name: "Calm" });
    store.change("owner", { wear: "calm" });
    store.change("owner", { saves: [{ id: "neon", file: { name: "Neon", accent: "#ff2bd6" } }], wear: "neon" });
    store.change("owner", { saves: [{ id: "neon", file: { name: "Neon", accent: "#00ff88" } }] });
    const again = createThemeStore({ dataDir });
    const [, made, wore] = again.history("owner");
    expect(again.restore("owner", made!.seq)).toEqual({});
    expect(again.read("owner", "neon")?.accent).toBe("#ff2bd6");
    expect(again.active("owner")).toBe("neon");
    expect(again.restore("owner", wore!.seq)).toEqual({});
    expect(again.active("owner")).toBe("calm");
    expect(again.read("owner", "neon")?.accent).toBe("#ff2bd6");
    expect(again.history("owner").slice(0, 2).map((item) => item.kind)).toEqual(["undid", "undid"]);
    expect(again.restore("owner", again.history("owner")[0]!.seq)).toMatchObject({ refusal: "That is how it looks now." });
  });

  it("names the files an earlier look had that are gone now", () => {
    const { store } = fixture();
    store.save("owner", "neon", { name: "Neon" });
    store.addAsset("owner", "neon", "stars.png", PNG);
    store.change("owner", { saves: [{ id: "neon", file: { name: "Neon", canvas: "#000000" } }], wear: "neon" });
    expect(store.missingAssets("owner", 0)).toEqual([]);
    store.remove("owner", "neon");
    expect(store.history("owner")[0]).toMatchObject({ kind: "deleted", name: "Neon" });
    expect(store.missingAssets("owner", 1)).toEqual(["stars.png"]);
    expect(store.restore("owner", 1)).toEqual({});
    expect(store.list("owner")).toEqual({ active: "neon", themes: [{ id: "neon", name: "Neon", hasCss: false, assets: [] }] });
  });
});
