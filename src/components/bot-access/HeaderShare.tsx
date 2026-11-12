import { Users } from "lucide-react";

import { botOwner } from "../../../shared/bot-owner";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "../elevated";
import { accessOfBot, canShare } from "./access";
import { PeopleStack } from "./PeopleStack";
import { ShareBotButton, useTeamName } from "./ShareBotButton";

const FACE = 24;
const FACES = 3;

/** Who a team bot is shared with, as far as this person's copy of it says: the people added (only someone who can
 * edit the bot is sent them), everyone in the team, only people added (to someone added, who is told no more), or
 * nobody. */
export type SharedWith = { kind: "people"; entries: string[] } | { kind: "everyone" } | { kind: "added" } | null;

export function sharedWith(bot: Pick<Bot, "access" | "visibility" | "yourAccess" | "onlyPeopleAdded" | "createdBy" | "reportsTo" | "defaultBot">): SharedWith {
  if (bot.defaultBot?.person) return null;
  if (!canShare(bot)) return bot.yourAccess === "view" || bot.yourAccess === "chat" ? (bot.onlyPeopleAdded ? { kind: "added" } : { kind: "everyone" }) : null;
  const access = accessOfBot(bot);
  if (access.everyone !== "none") return { kind: "everyone" };
  const owner = botOwner(bot);
  const entries = Object.keys(access.people).filter((entry) => entry !== owner);
  return entries.length ? { kind: "people", entries } : null;
}

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const NARROW_ONLY = "hidden @max-[30rem]/chathead:flex";
const WIDE_ONLY = "flex @max-[30rem]/chathead:hidden";

/** At the top right of a team bot's chat header: who it is shared with, then Share. Each mark opens the Share dialog.
 * On a narrow header the faces fold into one count and that mark stands in for Share, so the bot's name keeps its room. */
export function HeaderShare({ bot }: { bot: Bot }) {
  const teamName = useTeamName();
  const team = useTeamPeople();
  if (!teamName || bot.defaultBot?.person) return null;
  const shared = sharedWith(bot);
  const marker = (label: string, tone: string, open: () => void) => (
    <button type="button" aria-haspopup="dialog" data-shared-with-marker={shared?.kind} title={label} aria-label={label} onClick={open}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full", tone, FOCUS)} style={{ width: FACE, height: FACE }}>
      <Users size={13} aria-hidden="true" />
    </button>
  );
  return (
    <span data-header-share={shared?.kind ?? "private"} className="flex shrink-0 items-center gap-1.5">
      <ShareBotButton bot={bot} className={cn("size-8 items-center justify-center rounded-full text-ink-secondary hover:text-ink", ELEVATED_FLOAT, ELEVATED_HOVER, shared ? WIDE_ONLY : "flex")}
        leading={(open) => shared?.kind === "everyone" ? marker(t("teamSettings.everyone", { team: teamName }), "bg-accent/15 text-accent", open)
          : shared?.kind === "added" ? marker(t("botAccess.onlyAdded"), "bg-ink/[0.08] text-ink-secondary", open)
          : shared?.kind === "people" ? <>
            <span className={WIDE_ONLY}><PeopleStack entries={shared.entries} team={team} size={FACE} shown={FACES} ring="ring-app" overlap="-space-x-1.5" onOpen={open} /></span>
            <span className={NARROW_ONLY}><PeopleStack entries={shared.entries} team={team} size={FACE} shown={shared.entries.length === 1 ? 1 : 0} ring="ring-app" onOpen={open} /></span>
          </> : null} />
    </span>
  );
}
