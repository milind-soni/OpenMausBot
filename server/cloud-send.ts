// GET /api/cloud-send: what this server holds that Send to My Cloud compares, as a short hash per part. Read only, and
// never a secret: a login is its site and username (as GET /api/logins shows them), 1Password is when it was connected
// and which bots its vaults are kept to.
import { createHash } from "node:crypto";

import { BOT_PARTS, EMPTY, PICTURE_PART, itemKey } from "../electron/cloud-send-parts.mjs";
import type { SendKind } from "../electron/cloud-send-parts.mjs";
import type { LoginBots } from "../shared/logins.ts";
import { canonicalJson } from "../shared/package-format.ts";
import type { BotRecord } from "./store.ts";

export interface CloudSendItem {
  key: string;
  kind: SendKind;
  label: string;
  detail?: string;
  /** This server's own id for it: the bot's, the login's or the skill's name. */
  id?: string;
  bot?: string;
  parts: Record<string, string>;
}

export interface CloudSendSummary { v: 1; appVersion: string; items: CloudSendItem[] }

export interface CloudSendSources {
  appVersion: string;
  bots(): readonly BotRecord[];
  /** The conversation holds only the greeting a new bot starts with, still under this name. */
  greetingOnly(threadId: string, name: string): boolean;
  /** The bot is in a room, whose chats go to My Cloud only with their bots. */
  inRoom?(botId: string): boolean;
  skills(bot: BotRecord): ReadonlyArray<{ name: string; description?: string; sha256: string; enabled: boolean }>;
  /** The stored picture's bytes, or null when it is gone. */
  picture(avatarUrl: string): Uint8Array | null;
  logins(): ReadonlyArray<{ id: string; site: string; hosts: readonly string[]; exactHost: boolean; username: string; updatedAt: number }>;
  onePassword(): { connectedAt: number; grants: Record<string, LoginBots> } | null;
  settings(): { profile?: { name?: string; email?: string; aboutMe?: string }; language?: string };
  /** What only a move carries, of the bots it carries (cloud-send-kinds.ts), and a bot's parts only a move compares.
   * `only`: a move of that one bot into a team. */
  move?: { items(bots: ReadonlySet<string>, only?: BotRecord): CloudSendItem[]; botParts(bot: BotRecord): Record<string, string> };
}

/** What a bot's move into a team never carries: being someone's Chief of Staff (the team has its own). */
const TEAM_HELD_PARTS = ["chief", "helper"];

function empty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

/** "-" for nothing at all, so a part My Cloud has no value for is told apart from one it changed. */
export function partHash(value: unknown): string {
  if (empty(value)) return EMPTY;
  const kept = typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, field]) => !empty(field)))
    : value;
  if (empty(kept)) return EMPTY;
  return createHash("sha256").update(canonicalJson(kept)).digest("hex").slice(0, 24);
}

const pictureHashes = new Map<string, string>();

/** A stored picture never changes under its name: a new picture is a new attachment. */
function pictureHash(avatarUrl: string, picture: (avatarUrl: string) => Uint8Array | null): string {
  const known = pictureHashes.get(avatarUrl);
  if (known) return known;
  const bytes = picture(avatarUrl);
  if (!bytes) return EMPTY;
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
  if (pictureHashes.size > 1000) pictureHashes.clear();
  pictureHashes.set(avatarUrl, hash);
  return hash;
}

export function botParts(bot: BotRecord, picture: (avatarUrl: string) => Uint8Array | null): Record<string, string> {
  const fields = bot as unknown as Record<string, unknown>;
  const parts: Record<string, string> = {};
  for (const [part, names] of Object.entries(BOT_PARTS)) {
    parts[part] = partHash(names.length === 1 ? fields[names[0]!] : Object.fromEntries(names.map((name) => [name, fields[name]])));
  }
  parts[PICTURE_PART] = bot.avatarUrl ? pictureHash(bot.avatarUrl, picture) : EMPTY;
  return parts;
}

/** A bot nobody has touched since it was made (a fresh install's starter): left out, so it never lands beside My Cloud's
 * own starter. A bot sent from another computer arrives without a greeting, so it never reads as unused. */
export function unused(bot: BotRecord, skills: number, greetingOnly: (threadId: string, name: string) => boolean, inRoom: (botId: string) => boolean = () => false): boolean {
  return !bot.soul?.trim() && !bot.title && !bot.description && !bot.avatarUrl && !bot.sidebarHidden && !bot.welcomed && skills === 0 && (bot.tasks?.length ?? 1) <= 1 && greetingOnly(bot.threadId, bot.name)
    && !inRoom(bot.id);
}

/** `move`: a move's comparison, with what only a move carries. `bot`: a move of that one bot into a team: the bot, its
 * skills, its routines and the library skills it uses, never anything of the person's own. */
export function cloudSendSummary(sources: CloudSendSources, { move = false, bot: only }: { move?: boolean; bot?: string } = {}): CloudSendSummary {
  const items: CloudSendItem[] = [];
  const carried = new Set<string>();
  for (const bot of sources.bots()) {
    if (only !== undefined && bot.id !== only) continue;
    const skills = sources.skills(bot);
    if (only === undefined && unused(bot, skills.length, sources.greetingOnly, sources.inRoom)) continue;
    carried.add(bot.id);
    const parts: Record<string, string> = { ...botParts(bot, sources.picture), ...(move && sources.move ? sources.move.botParts(bot) : {}) };
    if (only !== undefined) for (const part of TEAM_HELD_PARTS) delete parts[part];
    items.push({ key: itemKey.bot(bot.id), kind: "bot", label: bot.name, id: bot.id, parts });
    for (const skill of skills) {
      items.push({ key: itemKey.skill(bot.id, skill.name), kind: "skill", label: skill.name, id: skill.name, bot: bot.id,
        parts: { text: skill.sha256.slice(0, 24) || EMPTY, on: skill.enabled ? "on" : "off" } });
    }
  }
  if (only !== undefined) {
    const bot = sources.bots().find((candidate) => candidate.id === only);
    if (move && sources.move && bot) items.push(...sources.move.items(carried, bot));
    return { v: 1, appVersion: sources.appVersion, items };
  }
  for (const login of sources.logins()) {
    items.push({ key: itemKey.login(login.site, login.username, login.exactHost ? login.hosts[0] : undefined), kind: "login", label: login.hosts[0] ?? login.site, detail: login.username, id: login.id,
      parts: { saved: partHash(login.updatedAt) } });
  }
  const onePassword = sources.onePassword();
  if (onePassword) {
    items.push({ key: itemKey.onePassword(), kind: "1password", label: "1Password",
      parts: { token: partHash(onePassword.connectedAt), vaults: partHash(onePassword.grants) } });
  }
  const { profile = {}, language } = sources.settings();
  items.push({ key: itemKey.setting("profile"), kind: "setting", label: "profile",
    parts: { name: partHash(profile.name), email: partHash(profile.email), about: partHash(profile.aboutMe) } });
  items.push({ key: itemKey.setting("language"), kind: "setting", label: "language", parts: { value: partHash(language) } });
  if (move && sources.move) items.push(...sources.move.items(carried));
  return { v: 1, appVersion: sources.appVersion, items };
}
