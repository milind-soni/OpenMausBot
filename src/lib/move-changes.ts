// The move step's lines in words (shared/move-changes.ts decides which apply).
import type { MoveChangeLine, MoveFacts } from "../../shared/move-changes.ts";
import { listOf } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";

/** At most this many names in one line; the rest are counted. */
const NAMES_SHOWN = 3;

/** "Ada, Bo and 2 more", in the reader's language. */
export function namedList(names: readonly string[]): string {
  if (names.length <= NAMES_SHOWN) return listOf([...names]);
  return listOf([...names.slice(0, NAMES_SHOWN), t("cloudSend.changes.moreNames", { count: names.length - NAMES_SHOWN })]);
}

export function moveChangeText(line: MoveChangeLine, facts: Pick<MoveFacts, "folders">): string {
  switch (line.kind) {
    case "teammates":
      // With "This computer and My Cloud together" on, the line claims nothing about hand-offs either way.
      if (line.names.length === 1) return t(line.reach ? "cloudSend.changes.teammatesHereOne" : "cloudSend.changes.teammatesOne", { names: line.names[0]! });
      return t(line.reach ? "cloudSend.changes.teammatesHere" : "cloudSend.changes.teammates", { names: namedList(line.names) });
    case "folder": {
      const many = facts.folders > 1;
      // The home folder itself, as a person calls it.
      const folder = line.folder === "~" && !many ? t("cloudSend.changes.homeFolder") : line.folder;
      const params: Record<string, string | number> = many ? { folder, count: facts.folders } : { folder };
      if (line.reach === "paused") return t(many ? "cloudSend.changes.foldersPaused" : "cloudSend.changes.folderPaused", params);
      if (line.reach === "lent") return t(many ? "cloudSend.changes.foldersLent" : "cloudSend.changes.folderLent", params);
      return t(many ? "cloudSend.changes.foldersHere" : "cloudSend.changes.folderHere", params);
    }
    case "engine":
      return t("cloudSend.changes.engine", { engine: line.engine });
    case "commands":
      return line.tools.length ? t("cloudSend.changes.commandsTools", { tools: namedList(line.tools) }) : t("cloudSend.changes.commands");
    case "skills":
      return t(line.skills.length === 1 ? "cloudSend.changes.skillsOne" : "cloudSend.changes.skills", { skills: namedList(line.skills), folders: namedList(line.hidden) });
  }
}

/** This is this computer's own page and it has bots of its own: the Cloud's offer then says a bot lives in one place.
 * The starter every place has, bots that moved away and the other place's bots listed here don't count. */
export function hasBotsHere(input: { bots: ReadonlyArray<{ defaultBot?: unknown; movedTo?: unknown; home?: unknown; hidden?: boolean }>; cloudHome: boolean; desktop: boolean; remote: boolean }): boolean {
  return input.desktop && !input.remote && !input.cloudHome && (input.bots ?? []).some((bot) => !bot.defaultBot && !bot.movedTo && !bot.home && !bot.hidden);
}
