// The workspaces of this computer's own on the rail (each a profile, clean-workspace.mjs): their names and colours, a new
// one from the rail's ＋, and switching between them. One runs at a time, on this computer's one server: opening another
// stops the one that runs once the work under way in it has finished (as the move waits for it, server/move-waits.ts),
// or after SETTLE_MS, when its server notes each turn cut short as a quit does.
//
// Who sees them: once My Cloud is home, every one, This Mac (`default`) first; before any home, This computer is the data
// folder as ever and the named ones sit beside it, so This Mac's profile is never offered there. A server of the person's
// own as home offers none yet.
//
// Removing one moves its folder to the computer's Trash (the same keep-it-recoverable step the app takes before it replaces
// a file it downloaded), never deleting it outright, and never while its server runs: the window goes to another place
// and the server back to this computer's own copy first.
import { randomBytes } from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";

import { CLOUD_SWATCHES, swatchColor } from "./cloud-list.mjs";
import { DEFAULT_PROFILE, PROFILE_ID, profileDir, profilesDir } from "./clean-workspace.mjs";

export const PROFILES_FILE = "profiles.json";
export const PROFILE_NAME_LIMIT = 40;
export const MAX_PROFILES = 20;
/** The longest a switch waits for the work under way in the workspace it leaves. */
export const SETTLE_MS = 60_000;
export const SETTLE_POLL_MS = 1_000;

/** A name as a person typed it: one line, no control characters, at most PROFILE_NAME_LIMIT characters; null when empty. */
export function profileName(value) {
  if (typeof value !== "string") return null;
  const printable = Array.from(value, (char) => { const code = char.codePointAt(0) ?? 0; return code < 32 || (code >= 127 && code < 160) ? " " : char; }).join("");
  const name = Array.from(printable.replace(/\s+/gu, " ").trim()).slice(0, PROFILE_NAME_LIMIT).join("").trim();
  return name || null;
}

const swatch = (value) => (CLOUD_SWATCHES.includes(value) ? value : null);
const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * The registry beside the profiles' folders: `{ v: 1, profiles: [{ id, name, color, createdAt }] }`, in the rail's order.
 * Without the file, This Mac (`default`) is its only entry, unnamed (the app calls it This Mac or This PC) and plain: so a
 * computer from before keeps its This Mac with its folder as it was, and the first change writes it down.
 * @param {{ dataDir(): string, fs?: typeof nodeFs, now?(): number, random?(): string }} deps
 */
export function createProfileRegistry({ dataDir, fs = nodeFs, now = Date.now, random = () => randomBytes(3).toString("hex") }) {
  const file = () => path.join(profilesDir(dataDir()), PROFILES_FILE);
  const born = (id) => { try { return Math.round(fs.statSync(profileDir(dataDir(), id)).birthtimeMs) || now(); } catch { return now(); } };
  function list() {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file(), "utf8")); } catch {}
    if (!Array.isArray(saved?.profiles)) return [{ id: DEFAULT_PROFILE, name: null, color: null, createdAt: born(DEFAULT_PROFILE) }];
    const seen = new Set();
    return saved.profiles.filter((entry) => typeof entry?.id === "string" && PROFILE_ID.test(entry.id) && !seen.has(entry.id) && seen.add(entry.id))
      .map((entry) => ({ id: entry.id, name: profileName(entry.name), color: swatch(entry.color), createdAt: Number.isSafeInteger(entry.createdAt) ? entry.createdAt : now() }));
  }
  function write(profiles) {
    const target = file(), temporary = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(temporary, JSON.stringify({ v: 1, profiles }), { mode: 0o600 });
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
    return profiles;
  }
  /** The name is free: no other workspace here has it, This Mac's own word for itself (`reserved`) included. */
  const free = (profiles, name, except, reserved) => !profiles.some((entry) => entry.id !== except && sameName(entry.name ?? (entry.id === DEFAULT_PROFILE ? reserved : null), name));
  function idFor(name, profiles) {
    const used = (id) => id === DEFAULT_PROFILE || profiles.some((entry) => entry.id === id) || fs.existsSync(profileDir(dataDir(), id));
    const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
    if (slug && PROFILE_ID.test(slug) && !used(slug)) return slug;
    for (;;) {
      const id = `${slug && PROFILE_ID.test(slug) ? `${slug}-` : "w-"}${random()}`;
      if (!used(id)) return id;
    }
  }
  const find = (id) => list().find((entry) => entry.id === id) ?? null;
  return {
    list,
    get: find,
    /** A new workspace's entry, last; its folder is made when it first opens. `reserved`: what This Mac is called here. */
    create({ name, color = null, reserved = null }) {
      const clean = profileName(name), profiles = list();
      if (!clean) return { ok: false, error: "name" };
      if (!free(profiles, clean, null, reserved)) return { ok: false, error: "taken" };
      if (profiles.length >= MAX_PROFILES) return { ok: false, error: "full" };
      const profile = { id: idFor(clean, profiles), name: clean, color: swatch(color), createdAt: now() };
      write([...profiles, profile]);
      return { ok: true, profile };
    },
    rename(id, name, reserved = null) {
      const clean = profileName(name), profiles = list();
      if (!profiles.some((entry) => entry.id === id)) return { ok: false, error: "gone" };
      if (!clean) return { ok: false, error: "name" };
      if (!free(profiles, clean, id, reserved)) return { ok: false, error: "taken" };
      write(profiles.map((entry) => (entry.id === id ? { ...entry, name: clean } : entry)));
      return { ok: true };
    },
    recolor(id, color) {
      const profiles = list();
      if (!profiles.some((entry) => entry.id === id)) return { ok: false, error: "gone" };
      write(profiles.map((entry) => (entry.id === id ? { ...entry, color: swatch(color) } : entry)));
      return { ok: true };
    },
    remove(id) {
      const profiles = list();
      if (!profiles.some((entry) => entry.id === id)) return false;
      write(profiles.filter((entry) => entry.id !== id));
      return true;
    },
  };
}

/**
 * @param {{
 *   registry: ReturnType<typeof createProfileRegistry>,
 *   clean: import("./clean-workspace.mjs").CleanWorkspace,
 *   dataDir(): string,
 *   home(): "cloud" | "local" | null,
 *   window: { openProfile(id: string): Promise<boolean>, profile(): string | null, showCloud(): Promise<unknown> },
 *   showLocal(): unknown,
 *   onLocal(): boolean,
 *   busy(): Promise<{ name: string, what?: string } | null>,
 *   trash(dir: string): Promise<void>,
 *   reserved?(): string | null,
 *   allowed?(): boolean,
 *   remember?(place: { profile: string } | null): void,
 *   changed?(): void,
 *   log?(line: string): void,
 *   fs?: typeof nodeFs,
 *   sleep?(ms: number): Promise<void>,
 *   now?(): number,
 *   settleMs?: number,
 * }} deps `home()`: My Cloud is home ("cloud"), no home but this computer ("local"), or another home (null). `window`: the
 * home window's profile on screen (home-window.mjs), and My Cloud shown again. `showLocal()`: the window onto this
 * computer's page, LOCAL_ID active. `onLocal()`: this computer's page is on screen. `busy()`: what the server that runs now
 * still does (GET /api/move/freeze), null when nothing. `trash(dir)`: moves a folder to the computer's Trash. `reserved()`:
 * what This Mac is called here (This Mac or This PC). `remember(place)`: the place the next launch opens:
 * the workspace that opened, or null once This computer's own copy is back.
 */
export function createLocalProfiles({ registry, clean, dataDir, home, window: shown, showLocal, onLocal, busy, trash, reserved = () => null, allowed = () => true,
  remember = () => {}, changed = () => {}, log = () => {}, fs = nodeFs, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, settleMs = SETTLE_MS }) {
  /** Each switch asked for; a newer one (another tile, My Cloud) ends the wait of the one before. */
  let turn = 0;
  /** The workspace a switch waits to open (null: This computer's own copy), and for whom. */
  let settling = null;
  const listed = (id) => registry.list().find((entry) => entry.id === id && offered(entry.id)) ?? null;
  const offered = (id) => (home() === "cloud" ? true : home() === "local" ? id !== DEFAULT_PROFILE : false);
  const running = () => clean.profile();
  const tell = () => { try { changed(); } catch {} };

  /** Waits while the server that runs now still works and will stop for this switch, at most `settleMs`. False when a newer
   * switch took over. */
  async function settle(mine, target, stops) {
    if (!stops) return true;
    const until = now() + settleMs;
    for (;;) {
      if (mine !== turn) return false;
      let who = null;
      try { who = await busy(); } catch {}
      if (mine !== turn) return false;
      if (!who) break;
      if (now() >= until) { log(`local profiles: ${target} opens though ${who.name || who.what || "a turn"} still works`); break; }
      if (settling?.id !== target || settling.name !== who.name) { settling = { id: target, name: who.name || "" }; tell(); }
      await sleep(SETTLE_POLL_MS);
    }
    if (settling && mine === turn) { settling = null; tell(); }
    return mine === turn;
  }

  /** True once workspace `id` is on screen, false when it can't open, null when a newer switch took over. */
  async function open(id) {
    const mine = ++turn;
    if (!allowed() || !listed(id)) return false;
    const stops = running() !== id && (home() === "local" || running() !== null);
    if (!(await settle(mine, id, stops))) return null;
    const opened = home() === "cloud" ? await shown.openProfile(id) : running() === id ? (await showLocal(), true) : await clean.open(id);
    if (opened) remember({ profile: id });
    return opened || mine === turn ? opened : null;
  }

  return {
    /** The rail's rows (cloud-rail.mjs railPlaces `profiles`); `activeLocal`: this computer's page is the window's place. */
    places({ activeLocal }) {
      const mode = home();
      if (!allowed() || !mode) return [];
      const onScreen = activeLocal ? (mode === "cloud" ? shown.profile() : running()) : null;
      return registry.list().filter((entry) => offered(entry.id)).map((entry) => ({ id: entry.id, name: entry.name, color: swatchColor(entry.color), swatch: entry.color,
        ...(entry.id === onScreen ? { active: true } : {}), ...(settling?.id === entry.id ? { settling: settling.name } : {}) }));
    },
    /** The workspace a switch waits to open (`id` null: This computer), and the name of what it waits for. */
    settling: () => settling,
    /** A new workspace may be added from ＋ here. */
    creatable: () => allowed() && home() !== null,
    open,
    /** Back to This computer's own copy from a workspace (no home but this computer). */
    async computer() {
      const mine = ++turn;
      if (running() === null) { await showLocal(); remember(null); return true; }
      if (!(await settle(mine, null, true))) return null;
      const left = await clean.leave();
      if (left && mine === turn) remember(null);
      return left;
    },
    /** Another place was chosen: a switch still waiting ends. */
    cancel() { turn++; if (settling) { settling = null; tell(); } },
    /** A new workspace's entry; the rail opens it next (cloud-rail.mjs), so a switch that waits shows on its circle. */
    create({ name, color }) {
      if (!allowed() || home() === null) return { outcome: "failed" };
      const made = registry.create({ name, color, reserved: reserved() });
      if (!made.ok) return { outcome: made.error === "full" ? "failed" : made.error };
      tell();
      return { outcome: "made", id: made.profile.id };
    },
    rename(id, name) {
      if (!listed(id)) return { outcome: "gone" };
      const done = registry.rename(id, name, reserved());
      if (done.ok) tell();
      return { outcome: done.ok ? "saved" : done.error };
    },
    recolor(id, color) {
      if (!listed(id)) return { outcome: "gone" };
      const done = registry.recolor(id, color);
      if (done.ok) tell();
      return { outcome: done.ok ? "saved" : done.error };
    },
    /** Removes workspace `id` from this computer: its server stopped first (the window on another place), then its folder
     * to the Trash, then its entry. */
    async remove(id) {
      if (!listed(id)) return { outcome: "gone" };
      turn++;
      if (running() === id) {
        if (!(await clean.leave()) || running() === id) return { outcome: "failed" };
        if (home() === "cloud") await shown.showCloud();
      }
      const dir = profileDir(dataDir(), id);
      try {
        if (fs.existsSync(dir)) await trash(dir);
      } catch (error) {
        log(`local profiles: ${id} could not go to the Trash (${error?.message ?? error})`);
        try { fs.renameSync(dir, path.join(profilesDir(dataDir()), `.removed-${id}-${now()}`)); }
        catch { return { outcome: "failed" }; }
      }
      registry.remove(id);
      tell();
      if (home() === "local" && running() === null && !onLocal()) await showLocal();
      return { outcome: "removed" };
    },
    /** What the window's top bar and line call the workspace that runs: its own name, or null for This Mac's. */
    name: (id) => registry.get(id)?.name ?? null,
  };
}
