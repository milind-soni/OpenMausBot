// app_settings' theme actions: read the person's themes with the guide, save and wear one, copy a file from the bot's own
// folders into a theme, and list or go back on their look changes. A theme is the person's who started the turn, so it
// reaches their windows and no one else's.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { z } from "zod";

import { SKIN_IDS } from "../../shared/app-settings.ts";
import { THEME_ID, THEME_LIMITS, themeCssProblem, themeFileSchema, themeGuide, type LookChange, type ThemeFile } from "../../shared/theme.ts";
import { openMessageFile } from "../message-file.ts";
import type { WritableEntry } from "../app-settings/registry.ts";
import type { Skin } from "./history.ts";
import { isRefusal, pictureKind, slugFor, type ThemeStore } from "./store.ts";

type Turn = { botId: string; threadId: string; generation: string };
type Reply = { status: number; body: Record<string, unknown> };

/** What a change writes: which theme the person wears, a theme's file to save first, and the skin underneath; or, for
 * going back and for Undo on the card, the look history entry to return to the look right after. */
type Wear = { id: string | null; save?: { id: string; file: ThemeFile }; skin?: Skin } | { undoTo: number };

export interface ThemeToolDeps {
  store: ThemeStore;
  /** The person whose own message began this turn's work; null when no one person's did. */
  person(turn: Turn): string | null;
  changed(person: string, skin?: string): void;
  /** Folders the bot may copy a theme file from; the attachment store; and this conversation's attached files, oldest
   * first, with the names they were attached under (server/conversation-attachments.ts). */
  sources(turn: Turn): { roots: string[]; attachmentsDir: string; attachments: ReadonlyArray<{ path: string; name: string }> };
}

type Opened = Awaited<ReturnType<typeof openMessageFile>>;
/** An opened file, the name it goes by, its size and what its first bytes say it is. */
type Picked = { file: Opened; name: string; size: number; kind: ReturnType<typeof pictureKind> };
const OPEN_ANY_SIZE = Number.MAX_SAFE_INTEGER;

async function picked(file: Opened, name: string): Promise<Picked> {
  const head = Buffer.alloc(4096);
  const [{ bytesRead }, stat] = await Promise.all([file.handle.read(head, 0, head.length, 0), file.handle.stat()]);
  return { file, name, size: stat.size, kind: pictureKind(head.subarray(0, bytesRead)) };
}
const HEIC = "That is a HEIC photo, which the app cannot show. Ask the person to send it as a JPEG or PNG (on an iPhone: share it, Options, Most Compatible), or, if you have a shell, convert it (on a Mac: sips -s format jpeg -Z 2560 in.heic --out out.jpg) and pass the new file.";
const TOO_BIG = `A theme file may be up to ${THEME_LIMITS.assetBytes / 1024 / 1024} MB. Ask the person for a smaller one, or, if you have a shell, shrink it (on a Mac: sips -s format jpeg -Z 2560 in.jpg --out out.jpg) and pass the new file.`;
/** The guide's veil over a picture background (shared/theme.ts; src/lib/theme/palette.test.ts holds it readable). */
const VEIL = "color-mix(in srgb, var(--color-app) 62%, transparent)";
const NOT_FOUND = "That file is not in your workspace or this conversation's attachments, or it cannot be read.";

const BUILT_IN: readonly string[] = [...SKIN_IDS, "system"];

const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });
const refuse = (status: number, error: string) => reply(status, { error });

/** A look change in a few words, as the bot reads it in theme_history and on a card. */
function said(change: LookChange): string {
  switch (change.kind) {
    case "made": return `made ${change.name}`;
    case "edited": return `edited ${change.name}`;
    case "deleted": return `deleted ${change.name} while wearing it`;
    case "wore": return `wore ${change.name}`;
    case "skin": return `wore the built-in ${change.name} skin`;
    case "default": return "back to default";
    case "undid": return `went back ${change.count === 1 ? "1 change" : `${change.count} changes`}`;
  }
}

export function createThemeTool(deps: ThemeToolDeps) {
  const { store } = deps;

  /** The person's current theme as a setting, so the applied card and its Undo work as every other setting's do. */
  function entry(person: string): WritableEntry {
    const read = () => {
      const id = store.active(person);
      return id ? (store.read(person, id)?.name ?? id) : "";
    };
    return {
      id: "appearance.theme", label: "Theme", help: "A custom look for the app.", where: "theme", synonyms: [], tier: "safe",
      value: z.unknown(), allowed: "a theme", read,
      current: () => ({ undoTo: store.history(person)[0]?.seq ?? 0 }) satisfies Wear,
      write: async (value) => {
        const wear = value as Wear;
        const done = "undoTo" in wear ? store.restore(person, wear.undoTo) : store.change(person, { saves: wear.save ? [wear.save] : [], wear: wear.id, ...(wear.skin ? { skin: wear.skin } : {}) });
        if (isRefusal(done)) return done.refusal;
        deps.changed(person, done.skin);
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
    if (BUILT_IN.includes(id)) return { wear: { id: null, skin: id as Skin }, change: id === "system" ? "Go back to the built-in look that follows the computer" : `Go back to the built-in ${id} skin` };
    const saved = THEME_ID.test(id) ? store.read(person, id) : null;
    if (!saved) return { error: `No saved theme or built-in skin is called ${JSON.stringify(id)}. Call theme to list them, or send theme to save a new one.` };
    return { wear: { id }, change: `Wear the theme ${saved.name}` };
  }

  function history(person: string): Reply {
    const items = store.history(person).map((item) => ({
      index: item.index, at: item.at, what: said(item),
      look: item.file ? { theme: item.file.name, ...(item.file.canvas ? { canvas: item.file.canvas } : {}), ...(item.file.accent ? { accent: item.file.accent } : {}) } : item.look.skin && item.look.skin !== "system" ? `built-in ${item.look.skin}` : "default",
    }));
    return reply(200, { text: items.length ? JSON.stringify({ now: new Date().toISOString(), changes: items }) : "No look changes yet." });
  }

  /** What undo_theme asks for: `steps` back (default 1), or `index` from theme_history to return to the look right after it. */
  function undo(person: string, body: Record<string, unknown>): { wear: Wear; change: string } | { error: string } {
    const items = store.history(person);
    const whole = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN);
    const byIndex = body.index !== undefined && body.index !== "";
    const count = byIndex ? whole(body.index) - 1 : body.steps === undefined || body.steps === "" ? 1 : whole(body.steps);
    if (!items.length) return { error: "There are no look changes to go back on." };
    if (!Number.isInteger(count) || count < (byIndex ? 0 : 1) || count > items.length - (byIndex ? 1 : 0)) {
      return { error: `${byIndex ? "index" : "steps"} must be a whole number from 1 to ${items.length}. Call theme_history to see the changes.` };
    }
    if (count === 0) return { error: "That is how it looks now." };
    const target = byIndex ? items[count]! : items[count - 1]!;
    const undoTo = byIndex ? target.seq : target.seq - 1;
    const missing = store.missingAssets(person, undoTo);
    const back = byIndex ? `Go back to the look after: ${said(target)}` : count === 1 ? `Undo the last look change (${said(items[0]!)})` : `Undo the last ${count} look changes`;
    return { wear: { undoTo }, change: `${back}${missing.length ? `; files no longer there: ${missing.join(", ")}` : ""}` };
  }

  /**
   * The file a bot names: an attachment of this conversation by its exact path, by the stored file's name (a bot box
   * shows uploads under another folder) or by the name it was attached under, else a file in the bot's own folders.
   * Security: an attachment opens only directly inside the attachment store, and only one this conversation carries; a
   * tag naming any other file on disk opens nothing. The latest match wins. Opened at any size: the caller reads the
   * first bytes, so a large HEIC photo is named as one, and reads the rest only within the limit.
   */
  async function openNamed(turn: Turn, path: string): Promise<Picked | { error: string; status: number }> {
    const sources = deps.sources(turn);
    const wanted = basename(path.replaceAll("\\", "/"));
    const lower = wanted.toLowerCase();
    const newest = [...sources.attachments].reverse();
    const exact = newest.find((one) => one.path === path);
    const byName = newest.find((one) => basename(one.path) === wanted) ?? newest.find((one) => one.name.toLowerCase() === lower);
    const attached = async (one: { path: string; name: string }) => picked(await openAttachment(sources.attachmentsDir, one.path), one.name);
    try {
      if (exact) return await attached(exact);
      const file = await openMessageFile(path, sources.roots, OPEN_ANY_SIZE);
      return await picked(file, file.name);
    } catch (error) {
      try {
        if (byName) return await attached(byName);
      } catch {
        // Reported as the path the bot named.
      }
      return { status: (error as { status?: number }).status ?? 400, error: NOT_FOUND };
    }
  }

  async function openAttachment(store: string, path: string): Promise<Opened> {
    if (resolve(dirname(path)) !== resolve(store)) throw Object.assign(new Error("outside the attachment store"), { status: 403 });
    return openMessageFile(path, [store], OPEN_ANY_SIZE);
  }

  /** The newest file attached in this conversation that is a picture (or a HEIC photo, so it is refused by name rather
   * than an older picture used in its place), judged by its bytes. */
  async function latestPicture(turn: Turn): Promise<Picked | null> {
    const sources = deps.sources(turn);
    for (const one of [...sources.attachments].reverse()) {
      let found: Picked;
      try {
        found = await picked(await openAttachment(sources.attachmentsDir, one.path), one.name);
      } catch {
        continue;
      }
      if (found.kind) return found;
      await found.file.handle.close().catch(() => undefined);
    }
    return null;
  }

  /**
   * Copies a file into a theme. `id` left out means the theme the person wears; with none worn, or an id no theme has
   * yet, a theme is made for it (saved, not worn, over the person's built-in skin) so the bot never needs a set_theme
   * first. `path` left out means the latest picture attached in this conversation. Wearing the theme with the file in
   * its CSS is set_theme's, which posts the card with Undo.
   */
  async function addAsset(turn: Turn, person: string, body: Record<string, unknown>): Promise<Reply> {
    const asked = typeof body.id === "string" ? body.id.trim() : "";
    if (asked && (BUILT_IN.includes(asked) || !THEME_ID.test(asked) || asked === "none")) return refuse(400, `${asked} cannot be a saved theme's id. Use lowercase letters, digits and dashes, not a built-in skin's name.`);
    const given = typeof body.path === "string" ? body.path.trim() : "";
    // "none" and "latest" read as left out: models send a word where the schema says to leave a field out.
    const path = /^(none|latest|null)$/i.test(given) ? "" : given;
    const opened = path ? await openNamed(turn, path) : await latestPicture(turn);
    if (!opened) return refuse(404, "No picture is attached in this conversation. Ask the person to attach one, or pass path.");
    if ("error" in opened) return refuse(opened.status, opened.error);
    const { file, kind } = opened;
    try {
      if (kind === "heic") return refuse(400, HEIC);
      if (opened.size > THEME_LIMITS.assetBytes) return refuse(413, TOO_BIG);
      // With nothing worn, the theme an earlier call made here and never wore (it has no CSS yet) takes the file, so
      // trying again, or after Undo, does not leave Background, Background 2, ... behind.
      const unworn = store.read(person, "background");
      const id = asked || store.active(person) || (unworn && !unworn.css ? "background" : store.freeId(person, "Background"));
      const made = !store.read(person, id);
      if (made) {
        const saved = store.save(person, id, { name: asked || "Background" });
        if (saved) return refuse(400, saved.refusal);
      }
      // A stored attachment's own name is an id with a store extension; the bytes say what a picture is.
      const ext = kind ?? (extname(opened.name).slice(1) || "").toLowerCase();
      const stem = slugFor(basename(opened.name, extname(opened.name))).slice(0, 52);
      const bytes = await file.handle.readFile();
      // Another file under the same name (every pasted screenshot is image.png) gets its own, so going back to an
      // earlier look still shows that look's picture.
      const taken = store.asset(person, id, `${stem}.${ext}`);
      const name = taken && !readFileSync(taken.path).equals(bytes) ? `${stem}-${createHash("sha256").update(bytes).digest("hex").slice(0, 6)}.${ext}` : `${stem}.${ext}`;
      const added = store.addAsset(person, id, name, bytes);
      if (isRefusal(added)) {
        if (made) store.remove(person, id);
        return refuse(400, added.refusal);
      }
      const theme = store.read(person, id)!;
      return reply(200, { text: [
        made ? `Made the theme ${theme.name} (id ${id}) for this file over the person's built-in skin; it is not worn yet.` : `Added to the theme ${theme.name} (id ${id}).`,
        `In its css write url("${added.url}")${kind ? `; as the chat background: [data-look="chat-backdrop"] { background: linear-gradient(${VEIL}, ${VEIL}), url("${added.url}") center / cover no-repeat; } (the veil of the theme's ground colour keeps text readable)` : ""}.`,
        `Then call set_theme with id ${id} and the whole theme to wear it${made ? "" : ", keeping its other fields (theme with this id returns them)"}.`,
      ].join(" ") });
    } finally {
      await file.handle.close().catch(() => undefined);
    }
  }

  return { entry, overview, wanted, undo, history, addAsset, person: deps.person };
}

export type ThemeTool = ReturnType<typeof createThemeTool>;
