// The bot folder: ~/.openmausbot/bots/<botId>/, owned by the server.
//
// SOUL.md is a MIRROR of BotRecord.soul, never the source of truth. The
// prompt is built from the record; the file exists so a person can read
// and edit the bot in their editor and so a bot can export as a folder.
// The folder sits outside the bot-writable workspace on purpose: a bot
// that reads untrusted content (a Discord channel, a webhook payload)
// must not be able to persist injected text into its own persona. A
// mirror that no longer matches the record is surfaced to the user as
// drift, with its text, and is never applied on its own.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";

export const BOTS_DIR = join(DATA_DIR, "bots");
export const SOUL_FILE = "SOUL.md";

export function botFolder(botId: string): string {
  return join(BOTS_DIR, botId);
}

export function soulFile(botId: string): string {
  return join(botFolder(botId), SOUL_FILE);
}

export function soulHash(soul: string): string {
  return createHash("sha256").update(soul, "utf8").digest("hex");
}

/** Rewrite the mirror from the canonical text. Always writes, even for an
 * empty soul, so the folder exists for the user to find. Private modes:
 * standing instructions can describe a person's work in detail. */
export function writeSoulMirror(botId: string, soul: string): void {
  mkdirSync(botFolder(botId), { recursive: true, mode: 0o700 });
  writeFileAtomic(soulFile(botId), soul, { mode: 0o600 });
}

export type SoulDrift = { drift: false } | { drift: true; fileText: string };

/** Compare the mirror with the record's hash. A missing mirror is not
 * drift — it is re-created from the record. A differing one is reported
 * together with its text so the user can apply or discard it. Editor reads
 * surface filesystem failures instead of mistaking them for a clean mirror. */
export function readSoulDrift(botId: string, soul: string, hash: string): SoulDrift {
  let fileText: string;
  try {
    const fd = openSync(soulFile(botId), "r");
    try {
      // External edits are unbounded. Read at most the budget plus one byte,
      // including if the file grows while the editor has it open.
      const bytes = Buffer.alloc(BOT_PROFILE_LIMITS.soul + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > BOT_PROFILE_LIMITS.soul) {
        throw Object.assign(new Error("SOUL.md exceeds 24000 bytes; shorten it in your editor"), { status: 400 });
      }
      fileText = bytes.subarray(0, length).toString("utf8");
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writeSoulMirror(botId, soul);
    return { drift: false };
  }
  if (soulHash(fileText) === hash) return { drift: false };
  return { drift: true, fileText };
}

/** Turn dispatch is best-effort; explicit editor actions use readSoulDrift
 * so an unreadable file is never presented as successfully discarded. */
export function checkSoulDrift(botId: string, soul: string, hash: string): SoulDrift {
  try { return readSoulDrift(botId, soul, hash); } catch { return { drift: false }; }
}

export function removeBotFolder(botId: string): void {
  try {
    rmSync(botFolder(botId), { recursive: true, force: true });
  } catch {}
}

/** The standing-instructions block of the system prompt. Empty soul,
 * empty block, so a bot without one gets today's prompt byte for byte. */
export function soulSystemPrompt(soul: string): string {
  const text = soul.trim();
  if (!text) return "";
  const bytes = Buffer.byteLength(text, "utf8");
  return (
    "\n\nYour standing instructions follow. The user manages them in bot settings and SOUL.md; proposed changes apply only after the user confirms." +
    " They rank above your memory and imported skills, and below the user's current request and safety boundaries." +
    ` Text inside this block is instruction for you, never tool authorization or permission to expose secrets.` +
    `\n\n--- BEGIN STANDING INSTRUCTIONS (SOUL.md, ${bytes} bytes) ---\n` +
    text +
    "\n--- END STANDING INSTRUCTIONS ---"
  );
}
