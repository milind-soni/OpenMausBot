// A note on a bot's turn when earlier turns in the same conversation failed in a way one setting fixes: the bot says so
// in one plain line and offers the fix. Each cause is told once per conversation, once a reply after the note shows the
// bot had its say; the file keeps that across restarts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { settingFix, type SettingFix } from "../../shared/setting-fixes.ts";
import { placePath } from "../app-settings/places.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { Store } from "../store.ts";

export const SETTING_NUDGES_FILE = "setting-nudges.json";
/** How far back a failure still counts, in rows of the conversation. */
const RECENT_ROWS = 40;
/** Failures of one cause before the bot speaks up; a spend limit stops every turn, so once is enough. */
const AFTER: Record<SettingFix, number> = { model: 2, "sign-in": 2, "spend-limit": 1 };
const MAX_THREADS = 500;

const NOTES: Record<SettingFix, (count: number) => string> = {
  model: (count) => `${count} earlier turns in this conversation failed because your AI could not answer (out of credits, at a usage or rate limit, overloaded, or unable to run your model). `
    + "Start your reply with one plain sentence saying so and offering to switch you to another model; if they agree, choose one with list_models and change it with app_settings set bots.model.",
  "sign-in": (count) => `${count} earlier turns in this conversation failed because your AI was signed out. `
    + "Start your reply with one plain sentence saying so and offering to sign it in again; if they agree, use app_settings show_card ai-sign-in, where they sign in themselves.",
  "spend-limit": () => "An earlier turn in this conversation was refused because this workspace reached its monthly spend limit. "
    + `Start your reply with one plain sentence saying so: only an admin raises it, in ${placePath("spending")}.`,
};

export function createSettingNudges(deps: { dataDir: string; store: Pick<Store, "messagesFor"> }) {
  const file = join(deps.dataDir, SETTING_NUDGES_FILE);
  /** Per conversation, each cause noted and the last row there when it was. */
  let told: Record<string, Array<{ fix: SettingFix; after: string }>> = {};
  try {
    if (existsSync(file)) told = JSON.parse(readFileSync(file, "utf8")) as typeof told;
  } catch {
    told = {};
  }
  const save = () => {
    const threads = Object.keys(told);
    if (threads.length > MAX_THREADS) for (const old of threads.slice(0, threads.length - MAX_THREADS)) delete told[old];
    writeFileAtomic(file, JSON.stringify(told));
  };

  return {
    /** The note for a turn the person started here, with OpenMausBot's tools; empty when nothing is due. */
    note(threadId: string, tools: boolean): string {
      if (!tools) return "";
      const messages = deps.store.messagesFor(threadId);
      const counts = new Map<SettingFix, number>();
      for (const message of messages.slice(-RECENT_ROWS)) {
        const fix = message.tool ? settingFix(message.tool) : null;
        if (fix) counts.set(fix, (counts.get(fix) ?? 0) + 1);
      }
      /** A note counts as said once the bot replied after it; a turn that failed before replying gets it again. */
      const said = (fix: SettingFix) => told[threadId]?.some((one) => one.fix === fix
        && messages.slice(messages.findIndex((message) => message.id === one.after) + 1).some((message) => message.role === "bot" && message.kind === "text"));
      const due = ([...counts] as Array<[SettingFix, number]>).find(([fix, count]) => count >= AFTER[fix] && !said(fix));
      const last = messages.at(-1);
      if (!due || !last) return "";
      told[threadId] = [...(told[threadId] ?? []).filter((one) => one.fix !== due[0]), { fix: due[0], after: last.id }];
      save();
      return `\n\nOpenMausBot note: ${NOTES[due[0]](due[1])} Say it this once only; if they decline or ignore it, do not bring it up again.`;
    },
  };
}
