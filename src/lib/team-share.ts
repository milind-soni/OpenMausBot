// Share team…: the renderer half of a whole-team export (package format v2).
// The server builds, redacts and validates the document; this side prepares
// pictures (the server never re-encodes images), builds the request, turns
// part paths into words, and saves the file. No confirm step anywhere.
import { t, tFromServer } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { PackageDocument, PackageSummary } from "../../shared/package-format";
import { skillChoicesFrom, startingTicks } from "./team-share-skills";

// The skill choices are pure and shared with the server's export tests.
export { includedSkills, requestedSkills, skillChoicesFrom, startingTicks, tickedSkills } from "./team-share-skills";

/** Pictures are downscaled to fit this square before they are shared. */
export const PICTURE_EDGE = 256;
/** Decoded bytes per picture; the file format refuses anything larger. */
export const PICTURE_MAX_BYTES = 64 * 1024;
/** Stop adding pictures once their base64 passes this, leaving room in the 4 MB file. */
export const PICTURES_BASE64_BUDGET = 2 * 1024 * 1024;

export type ShareSkipReason =
  | "picture_too_large" | "picture_invalid" | "pictures_budget" | "stdio_server" | "insecure_address"
  | "files_not_shared" | "lead_not_in_group_chat" | "notes_too_large" | "skill_changed"
  | "skill_conflict" | "bot_skill_limit" | "team_skill_limit" | "preset_empty" | "preset_skill_conflict";

export interface ShareSkip { part: string; reason: ShareSkipReason | string }

export interface ShareChoices {
  team: string;
  name?: string;
  tagline?: string;
  summary?: string;
  release?: string;
  notes?: string;
  /** "all", or the chosen skill names. */
  skills: "all" | string[];
  includeMemory: boolean;
  avatars?: Record<string, string>;
  /** "Include my New bot defaults as a preset", with its prepared picture. */
  includeDefaultsPreset?: boolean;
  presetAvatar?: string;
  dryRun?: boolean;
}

export interface ShareResponse {
  document: PackageDocument;
  filename: string;
  redacted: string[];
  skipped: ShareSkip[];
  summary: PackageSummary;
  choices: { skills: string[] };
}

// ── the dialog's state ──────────────────────────────────────────────────────

/** What the Share dialog starts with. Owner decision: a team is shared whole,
 * everything but chat history, so pictures and starter notes start ticked and
 * the line under the notes box says so. (The API default for notes stays
 * off: callers opt in.) */
export const SHARE_DIALOG_DEFAULTS = { includePictures: true, includeMemory: true } as const;

/** The line under the starter-notes box. */
export function notesLine(includeMemory: boolean): string {
  return includeMemory ? t("teamShare.notesIncluded") : t("teamShare.notesExcluded");
}

/** What the dialog shows from the server's dry runs. */
export interface ShareView {
  /** The dry run of the current choice; null while it is refused (no counts, no Save). */
  preview: ShareResponse | null;
  /** Every skill name on the team's bots, one box each; null until the server first answers. */
  available: string[] | null;
  /** The boxes ticked until the person changes one (startingTicks). */
  included: string[] | null;
  error: string;
}

export const SHARE_VIEW_START: ShareView = { preview: null, available: null, included: null, error: "" };

/** A dry run answered. `all`: it asked for "all" (no box changed yet). */
export function shareAnswered(view: ShareView, result: ShareResponse, all: boolean): ShareView {
  return { preview: result, available: result.choices.skills, included: all ? startingTicks(result) : view.included, error: "" };
}

/** A dry run was refused. This choice cannot be saved: no counts and no Save
 * until it changes. The skill boxes stay, redrawn from the refusal when it
 * names the team's skills, so the choice can always be changed. */
export function shareRefused(view: ShareView, cause: unknown): ShareView {
  const body = cause && typeof cause === "object" && "body" in cause ? (cause as { body?: unknown }).body : undefined;
  return {
    ...view,
    preview: null,
    available: skillChoicesFrom(body) ?? view.available,
    error: cause instanceof Error ? cause.message : String(cause),
  };
}

/** POST /api/teams/export body (package format v2). */
export function shareRequestBody(choices: ShareChoices): Record<string, unknown> {
  const text = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  return {
    format: "package",
    version: 2,
    team: choices.team,
    name: text(choices.name),
    tagline: text(choices.tagline),
    summary: text(choices.summary),
    release: text(choices.release),
    notes: text(choices.notes),
    skills: choices.skills,
    includeMemory: choices.includeMemory,
    ...(choices.avatars && Object.keys(choices.avatars).length ? { avatars: choices.avatars } : {}),
    ...(choices.includeDefaultsPreset ? { includeDefaultsPreset: true, ...(choices.presetAvatar ? { presetAvatar: choices.presetAvatar } : {}) } : {}),
    ...(choices.dryRun ? { dryRun: true } : {}),
  };
}

export interface PictureSource {
  id: string;
  avatarUrl?: string | null;
  avatarCrop?: string;
}

export interface PictureTools {
  fetchBlob(url: string): Promise<Blob>;
  /** Downscale to fit PICTURE_EDGE; WebP at 0.85, else PNG. Null when it cannot be drawn. */
  shrink(blob: Blob): Promise<Blob | null>;
  toDataUrl(blob: Blob): Promise<string>;
}

/** The pictures the dialog offers the server, per bot id, and the ones it
 * could not include. Only bots that show a picture (not the mascot) count. */
export async function preparePictures(
  bots: readonly PictureSource[],
  tools: PictureTools = browserPictureTools,
): Promise<{ avatars: Record<string, string>; skipped: Array<{ botId: string; reason: ShareSkipReason }> }> {
  const avatars: Record<string, string> = {};
  const skipped: Array<{ botId: string; reason: ShareSkipReason }> = [];
  let budget = PICTURES_BASE64_BUDGET;
  for (const bot of bots) {
    if (!bot.avatarUrl || !bot.avatarCrop || bot.avatarCrop === "mascot") continue;
    if (budget <= 0) {
      skipped.push({ botId: bot.id, reason: "pictures_budget" });
      continue;
    }
    try {
      const small = await tools.shrink(await tools.fetchBlob(bot.avatarUrl));
      if (!small) {
        skipped.push({ botId: bot.id, reason: "picture_invalid" });
        continue;
      }
      if (small.size > PICTURE_MAX_BYTES) {
        skipped.push({ botId: bot.id, reason: "picture_too_large" });
        continue;
      }
      const dataUrl = await tools.toDataUrl(small);
      if (dataUrl.length > budget) {
        skipped.push({ botId: bot.id, reason: "pictures_budget" });
        budget = 0;
        continue;
      }
      avatars[bot.id] = dataUrl;
      budget -= dataUrl.length;
    } catch {
      skipped.push({ botId: bot.id, reason: "picture_invalid" });
    }
  }
  return { avatars, skipped };
}

const browserPictureTools: PictureTools = {
  async fetchBlob(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("picture unavailable");
    return response.blob();
  },
  async shrink(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, PICTURE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    const webp = await encode("image/webp", 0.85);
    // Browsers without a WebP encoder hand back PNG under toBlob's fallback.
    return webp?.type === "image/webp" ? webp : encode("image/png");
  },
  toDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("picture unreadable"));
      reader.readAsDataURL(blob);
    });
  },
};

const FIELD_WORDS: Record<string, LocaleKey> = {
  soul: "teamShare.field.soul",
  seed: "teamShare.field.notes",
  brief: "teamShare.field.brief",
  bulletin: "teamShare.field.bulletin",
  prompt: "teamShare.field.prompt",
  instructions: "teamShare.field.skill",
  skills: "teamShare.field.skill",
  mcp: "teamShare.field.address",
  appearance: "teamShare.field.picture",
};

/** "agents[scout].soul" → "Scout · standing instructions"; unknown shapes
 * stay as their path (still readable, never a value). */
export function describePart(part: string, document?: PackageDocument): string {
  const pkg = document?.package;
  // A preset's bot fields read like a bot's: presets[x].bot.soul → presets[x].soul.
  part = part.replace(/^(presets\[[^\]]+\])\.bot\./, "$1.");
  const match = /^(agents|rooms|routines|skills|connections|presets|playbooks)\[([^\]]+)\](?:\.([a-zA-Z]+)(?:\[([^\]]+)\])?)?/.exec(part);
  if (match) {
    const [, list, key, field, item] = match;
    const named = list === "agents" ? pkg?.agents.find((agent) => agent.key === key)?.name
      : list === "rooms" ? pkg?.rooms?.find((room) => room.key === key)?.name
      : list === "routines" ? pkg?.routines?.find((routine) => routine.key === key)?.name
      : list === "connections" ? pkg?.connections?.find((connection) => connection.key === key)?.label
      : list === "presets" ? pkg?.presets?.find((preset) => preset.key === key)?.name
      : undefined;
    // The defaults preset left out (empty) has no name in the file to show.
    const who = named ?? (list === "presets" ? t("teamShare.defaultsPreset") : key!);
    const words = field
      ? (FIELD_WORDS[field] ? t(FIELD_WORDS[field]) : field)
      : list === "connections" ? t("teamShare.field.connection") : list === "skills" ? t("teamShare.field.skill") : undefined;
    const topic = /\.seed\.memory\["([^"]+)"\]/.exec(part)?.[1] ?? item;
    return [who, words, topic].filter(Boolean).join(" · ");
  }
  if (part === "team.brief") return t("teamShare.field.brief");
  return part.replace(/^package\./, "");
}

/** A skip line: "Morgan · picture — picture is larger than 64 KB". */
export function describeSkip(skip: ShareSkip, document?: PackageDocument, botNames?: ReadonlyMap<string, string>): string {
  const reason = tFromServer(`teamShare.skip.${skip.reason}`, skip.reason) ?? skip.reason;
  const who = botNames?.get(skip.part) ?? describePart(skip.part, document);
  return `${who} — ${reason}`;
}

/** Save the document as the file Admin and other apps read. */
export function saveShareFile(filename: string, document: PackageDocument): void {
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    window.document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
