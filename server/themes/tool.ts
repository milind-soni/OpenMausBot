// app_settings' theme actions: read the person's themes with the guide, save and wear one, and copy a file from the bot's
// own folders into a theme. A theme is the person's who started the turn, so it reaches their windows and no one else's.
import { basename, dirname, extname } from "node:path";
import { z } from "zod";

import { SKIN_IDS } from "../../shared/app-settings.ts";
import { THEME_ID, THEME_LIMITS, themeCssProblem, themeFileSchema, themeGuide, type ThemeFile } from "../../shared/theme.ts";
import { openMessageFile } from "../message-file.ts";
import type { WritableEntry } from "../app-settings/registry.ts";
import { isRefusal, slugFor, type ThemeStore } from "./store.ts";

type Turn = { botId: string; threadId: string; generation: string };
type Reply = { status: number; body: Record<string, unknown> };

/** What Undo writes back as well as what a change writes: which theme the person wears, and a theme's file to save first. */
type Wear = { id: string | null; save?: { id: string; file: ThemeFile }; skin?: string };

export interface ThemeToolDeps {
  store: ThemeStore;
  /** The person whose own message began this turn's work; null when no one person's did. */
  person(turn: Turn): string | null;
  changed(person: string, skin?: string): void;
  /** Folders the bot may copy a theme file from, and this conversation's attached files. */
  sources(turn: Turn): { roots: string[]; attachments: string[] };
}

const BUILT_IN: readonly string[] = [...SKIN_IDS, "system"];

const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });
const refuse = (status: number, error: string) => reply(status, { error });

export function createThemeTool(deps: ThemeToolDeps) {
  const { store } = deps;

  /** The person's current theme as a setting, so the applied card and its Undo work as every other setting's do. */
  function entry(person: string): WritableEntry {
    const read = () => {
      const id = store.active(person);
      return id ? (store.read(person, id)?.name ?? id) : "";
    };
    return {
      id: "appearance.theme", label: "Theme", help: "A custom look for the app.", where: "Settings → Appearance", synonyms: [], tier: "safe",
      value: z.unknown(), allowed: "a theme", read,
      current: (value) => {
        const wanted = value as Wear;
        const previous = wanted.save ? store.read(person, wanted.save.id) : null;
        return { id: store.active(person), ...(wanted.save && previous ? { save: { id: wanted.save.id, file: previous } } : {}) } satisfies Wear;
      },
      write: async (value) => {
        const wear = value as Wear;
        if (wear.save) {
          const refusal = store.save(person, wear.save.id, wear.save.file);
          if (refusal) return refusal.refusal;
        }
        const refusal = store.setActive(person, wear.id);
        if (refusal) return refusal.refusal;
        deps.changed(person, wear.skin);
        return null;
      },
    };
  }

  function overview(person: string, id: unknown): Reply {
    const list = store.list(person);
    const asked = typeof id === "string" && THEME_ID.test(id) ? store.read(person, id) : null;
    const current = list.active ? store.read(person, list.active) : null;
    return reply(200, {
      text: JSON.stringify({
        current: list.active ? { id: list.active, theme: current } : "none: the person's built-in skin",
        builtIn: BUILT_IN,
        saved: list.themes,
        ...(asked ? { theme: { id, ...asked } } : {}),
        guide: themeGuide(),
      }),
    });
  }

  /** What set_theme asks for, as the change to make and the line its card shows; or why it cannot. */
  function wanted(person: string, body: Record<string, unknown>): { wear: Wear; change: string } | { error: string } {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (body.theme !== undefined) {
      let raw: unknown = body.theme;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          return { error: "theme must be the theme as JSON: {\"name\", \"canvas\", \"accent\", \"colors\", \"css\", ...}." };
        }
      }
      const parsed = themeFileSchema.safeParse(raw);
      if (!parsed.success) return { error: `The theme does not fit: ${parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join(".") || "theme"}: ${issue.message}`).join("; ")}.` };
      const themeId = id || slugFor(parsed.data.name);
      if (BUILT_IN.includes(themeId) || !THEME_ID.test(themeId) || themeId === "none") return { error: `${themeId} cannot be a saved theme's id. Use lowercase letters, digits and dashes, not a built-in skin's name.` };
      const problem = parsed.data.css ? themeCssProblem(parsed.data.css) : null;
      if (problem) return { error: `Nothing changed. ${problem}` };
      const existed = store.read(person, themeId) !== null;
      return { wear: { id: themeId, save: { id: themeId, file: parsed.data } }, change: `${existed ? "Update" : "Save"} the theme ${parsed.data.name} and wear it` };
    }
    if (id === "none") return { wear: { id: null }, change: "Take off the custom theme" };
    if (BUILT_IN.includes(id)) return { wear: { id: null, skin: id }, change: id === "system" ? "Go back to the built-in look that follows the computer" : `Go back to the built-in ${id} skin` };
    const saved = THEME_ID.test(id) ? store.read(person, id) : null;
    if (!saved) return { error: `No saved theme or built-in skin is called ${JSON.stringify(id)}. Call theme to list them, or send theme to save a new one.` };
    return { wear: { id }, change: `Wear the theme ${saved.name}` };
  }

  async function addAsset(turn: Turn, person: string, body: Record<string, unknown>): Promise<Reply> {
    const id = typeof body.id === "string" ? body.id : "";
    if (!THEME_ID.test(id) || !store.read(person, id)) return refuse(404, "Name a saved theme in id: save it with set_theme first.");
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!path) return refuse(400, "path is the file in your workspace or this conversation's attachments.");
    const sources = deps.sources(turn);
    const attached = sources.attachments.includes(path);
    let file: Awaited<ReturnType<typeof openMessageFile>>;
    try {
      file = await openMessageFile(path, attached ? [dirname(path)] : sources.roots, THEME_LIMITS.assetBytes);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      return refuse(status, status === 413 ? `A theme file may be up to ${THEME_LIMITS.assetBytes / 1024 / 1024} MB.` : "That file is not in your workspace or this conversation's attachments, or it cannot be read.");
    }
    try {
      const ext = (extname(file.name).slice(1) || "").toLowerCase();
      const stem = slugFor(basename(file.name, extname(file.name))).slice(0, 60);
      const added = store.addAsset(person, id, `${stem}.${ext}`, await file.handle.readFile());
      if (isRefusal(added)) return refuse(400, added.refusal);
      return reply(200, { text: `Added. In the theme's css write url("${added.url}"). Then call set_theme with the theme to use it.` });
    } finally {
      await file.handle.close().catch(() => undefined);
    }
  }

  return { entry, overview, wanted, addAsset, person: deps.person };
}

export type ThemeTool = ReturnType<typeof createThemeTool>;
