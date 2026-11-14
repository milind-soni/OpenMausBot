// Each person's themes on this workspace: <dataDir>/themes/<person>/<theme id>/theme.json with its files beside it in
// assets/, and active.json naming the one their windows wear.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  rehomeThemeCss, THEME_ASSET_NAME, THEME_EXPORT_VERSION, THEME_ID, THEME_LIMITS, themeAssetType, themeAssetUrl, themeCssProblem,
  themeFileSchema, type ThemeExport, type ThemeFile, type ThemeList,
} from "../../shared/theme.ts";
import { writeFileAtomic } from "../atomic.ts";

export type Refusal = { refusal: string };
const refused = (refusal: string): Refusal => ({ refusal });
export const isRefusal = (value: unknown): value is Refusal => typeof value === "object" && value !== null && "refusal" in value;

/** A person's folder name: the key itself when it is plain, a hash otherwise, so no key can name a path. */
const personFolder = (person: string) => (/^[\w-]{1,64}$/.test(person) ? person : `h_${createHash("sha256").update(person).digest("hex").slice(0, 32)}`);

/** Route words under /api/themes/, and the tool's word for no theme. */
const RESERVED_IDS: ReadonlySet<string> = new Set(["active", "import", "none"]);

export const slugFor = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "theme";

/** Security: a file's first bytes must match its extension, so a theme file is only ever the image or font it claims. */
function looksLike(name: string, bytes: Buffer): boolean {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const ascii = (at: number, text: string) => bytes.subarray(at, at + text.length).toString("latin1") === text;
  switch (ext) {
    case "png": return starts(0x89, 0x50, 0x4e, 0x47);
    case "jpg": case "jpeg": return starts(0xff, 0xd8, 0xff);
    case "gif": return ascii(0, "GIF8");
    case "webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "avif": return ascii(4, "ftyp");
    case "woff": return ascii(0, "wOFF");
    case "woff2": return ascii(0, "wOF2");
    case "ttf": return starts(0x00, 0x01, 0x00, 0x00) || ascii(0, "true");
    case "otf": return ascii(0, "OTTO");
    case "svg": {
      const head = bytes.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
      return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head);
    }
    default: return false;
  }
}

export function createThemeStore(deps: { dataDir: string }) {
  const root = join(deps.dataDir, "themes");
  const home = (person: string) => join(root, personFolder(person));
  const folder = (person: string, id: string) => join(home(person), id);
  const assetsDir = (person: string, id: string) => join(folder(person, id), "assets");
  const validId = (id: string) => THEME_ID.test(id) && !RESERVED_IDS.has(id);

  function read(person: string, id: string): ThemeFile | null {
    if (!validId(id)) return null;
    try {
      const parsed = themeFileSchema.safeParse(JSON.parse(readFileSync(join(folder(person, id), "theme.json"), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function ids(person: string): string[] {
    try {
      return readdirSync(home(person), { withFileTypes: true }).filter((entry) => entry.isDirectory() && validId(entry.name)).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  }

  function assets(person: string, id: string): string[] {
    try {
      return readdirSync(assetsDir(person, id)).filter((name) => THEME_ASSET_NAME.test(name)).sort();
    } catch {
      return [];
    }
  }

  function active(person: string): string | null {
    try {
      const value = (JSON.parse(readFileSync(join(home(person), "active.json"), "utf8")) as { id?: unknown }).id;
      return typeof value === "string" && read(person, value) ? value : null;
    } catch {
      return null;
    }
  }

  function setActive(person: string, id: string | null): Refusal | null {
    if (id !== null && !read(person, id)) return refused(`No saved theme has the id ${id}.`);
    mkdirSync(home(person), { recursive: true });
    writeFileAtomic(join(home(person), "active.json"), JSON.stringify({ id }));
    return null;
  }

  function save(person: string, id: string, file: ThemeFile): Refusal | null {
    if (!validId(id)) return refused("A theme id is lowercase letters, digits and dashes, up to 48 characters.");
    const problem = file.css ? themeCssProblem(file.css) : null;
    if (problem) return refused(problem);
    if (!read(person, id) && ids(person).length >= THEME_LIMITS.themesPerPerson) return refused(`You can keep up to ${THEME_LIMITS.themesPerPerson} themes. Delete one first.`);
    mkdirSync(folder(person, id), { recursive: true });
    writeFileAtomic(join(folder(person, id), "theme.json"), `${JSON.stringify(file, null, 2)}\n`);
    return null;
  }

  function addAsset(person: string, id: string, name: string, bytes: Buffer): { url: string } | Refusal {
    const clean = name.toLowerCase();
    if (!read(person, id)) return refused(`Save the theme ${id} first, then add files to it.`);
    if (!THEME_ASSET_NAME.test(clean)) return refused("A theme file name is lowercase letters, digits, - and _, ending in .png, .jpg, .webp, .gif, .avif, .svg, .woff2, .woff, .ttf or .otf.");
    if (bytes.byteLength === 0) return refused("The file is empty.");
    if (bytes.byteLength > THEME_LIMITS.assetBytes) return refused(`A theme file may be up to ${THEME_LIMITS.assetBytes / 1024 / 1024} MB.`);
    if (!looksLike(clean, bytes)) return refused(`${clean} is not the kind of file its name says.`);
    const others = assets(person, id).filter((existing) => existing !== clean);
    if (others.length >= THEME_LIMITS.assetsPerTheme) return refused(`A theme holds up to ${THEME_LIMITS.assetsPerTheme} files.`);
    const kept = others.reduce((sum, existing) => sum + statSync(join(assetsDir(person, id), existing)).size, 0);
    if (kept + bytes.byteLength > THEME_LIMITS.themeBytes) return refused(`A theme's files may total up to ${THEME_LIMITS.themeBytes / 1024 / 1024} MB.`);
    mkdirSync(assetsDir(person, id), { recursive: true });
    writeFileAtomic(join(assetsDir(person, id), clean), bytes);
    return { url: themeAssetUrl(id, clean) };
  }

  /** A theme file to serve, or null; the name is checked before it nears the disk. */
  function asset(person: string, id: string, name: string): { path: string; type: string; bytes: number; mtimeMs: number } | null {
    if (!validId(id) || !THEME_ASSET_NAME.test(name)) return null;
    const path = join(assetsDir(person, id), name);
    const type = themeAssetType(name);
    try {
      const stat = statSync(path);
      return stat.isFile() && type ? { path, type, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  function freeId(person: string, wanted: string): string {
    const base = slugFor(wanted);
    let id = base;
    for (let n = 2; existsSync(folder(person, id)) || RESERVED_IDS.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  function duplicate(person: string, id: string, name: string): { id: string } | Refusal {
    const file = read(person, id);
    if (!file) return refused(`No saved theme has the id ${id}.`);
    if (ids(person).length >= THEME_LIMITS.themesPerPerson) return refused(`You can keep up to ${THEME_LIMITS.themesPerPerson} themes. Delete one first.`);
    const copy = freeId(person, name);
    if (existsSync(assetsDir(person, id))) cpSync(assetsDir(person, id), assetsDir(person, copy), { recursive: true });
    const saved = save(person, copy, { ...file, name, ...(file.css ? { css: rehomeThemeCss(file.css, id, copy) } : {}) });
    return saved ?? { id: copy };
  }

  function remove(person: string, id: string): void {
    if (!validId(id)) return;
    if (active(person) === id) setActive(person, null);
    rmSync(folder(person, id), { recursive: true, force: true });
  }

  function exportTheme(person: string, id: string): ThemeExport | null {
    const theme = read(person, id);
    if (!theme) return null;
    const files = Object.fromEntries(assets(person, id).map((name) => [name, `data:${themeAssetType(name)};base64,${readFileSync(join(assetsDir(person, id), name)).toString("base64")}`]));
    return { mausbotTheme: THEME_EXPORT_VERSION, id, theme, ...(Object.keys(files).length ? { assets: files } : {}) };
  }

  /** Saves an exported theme under a new id, with its files stored again and its CSS pointed at them. */
  function importTheme(person: string, data: ThemeExport): { id: string } | Refusal {
    const id = freeId(person, data.id ?? data.theme.name);
    const theme = data.id && data.theme.css ? { ...data.theme, css: rehomeThemeCss(data.theme.css, data.id, id) } : data.theme;
    const saved = save(person, id, theme);
    if (saved) return saved;
    for (const [name, address] of Object.entries(data.assets ?? {})) {
      const added = addAsset(person, id, name, Buffer.from(address.slice(address.indexOf(",") + 1), "base64"));
      if (isRefusal(added)) {
        remove(person, id);
        return added;
      }
    }
    return { id };
  }

  return {
    read, save, active, setActive, addAsset, asset, duplicate, remove, exportTheme, importTheme, freeId,
    list(person: string): ThemeList {
      const themes = ids(person).flatMap((id) => {
        const file = read(person, id);
        return file ? [{ id, name: file.name, hasCss: Boolean(file.css), assets: assets(person, id) }] : [];
      });
      return { active: active(person), themes };
    },
  };
}

export type ThemeStore = ReturnType<typeof createThemeStore>;
