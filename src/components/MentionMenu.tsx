import type { RefObject } from "react";
import { Bug, Users } from "lucide-react";
import type { Bot } from "@/state/store";
import type { TeamPerson } from "@/state/team-people";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { normalizeState } from "@/lib/mascot";
import { mentionRowDescription } from "@/lib/mentions";
import { BotAvatar } from "./Avatar";
import { ComposerMenuRow } from "./ComposerMenuRow";
import type { MenuMotion } from "./MenuMotion";
import { PersonFace } from "./TeamOwner";
import { DEVS_TAG } from "../../shared/devs-mention";

/** One row of the @ list: a bot, a teammate on a Team Cloud, a whole team, everyone, or the MausBot team (@devs). */
export type MentionChoice = { id: string; name: string; bot?: Bot; person?: TeamPerson; team?: { count: number }; all?: { count: number }; devs?: true };

/** The last row of every @ list: a message that tags it is a bug report the app sends to the MausBot team. */
export const DEVS_CHOICE: MentionChoice = { id: "__devs__", name: DEVS_TAG, devs: true };

/** The @ list's rows for a Team Cloud's teammates, after the bots. */
export function teammateChoices(people: readonly TeamPerson[]): MentionChoice[] {
  return people.map((person) => ({ id: `person:${person.email}`, name: person.name, person }));
}

/** The composer's @ list, shared by every composer that tags bots. */
export function MentionMenu({ listRef, motion, choices, highlight, everyoneCount, onPick, onHighlight, className }: {
  listRef: RefObject<HTMLDivElement | null>;
  motion: MenuMotion;
  choices: MentionChoice[];
  highlight: number;
  everyoneCount: number;
  onPick: (choice: MentionChoice) => void;
  onHighlight: (index: number) => void;
  className?: string;
}) {
  if (!motion.shown) return null;
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("composer.mention.aria")}
      className={cn("absolute bottom-full start-2 z-20 mb-2 max-h-72 w-72 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-raised shadow-lg", motion.className, className)} {...motion.exitProps}
    >
      {choices.map((choice, i) => {
        const description = choice.person ? "" : choice.devs ? t("composer.mention.devsDesc") : mentionRowDescription(choice.bot ? { kind: "bot", title: choice.bot.title }
          : choice.team ? { kind: "team", count: choice.team.count }
            : choice.all ? { kind: "all", count: choice.all.count } : { kind: "everyone", count: everyoneCount });
        return (
          <ComposerMenuRow
            key={choice.id}
            id={`composer-mention-${choice.id}`}
            data-mention-index={i}
            role="option"
            aria-selected={i === highlight}
            onClick={() => onPick(choice)}
            onMouseEnter={() => onHighlight(i)}
            selected={i === highlight}
            icon={choice.bot ? (
              <BotAvatar
                bot={choice.bot}
                state={normalizeState(choice.bot.mascotExpression) ?? "happy"}
                size={24}
                animated={i === highlight}
              />
            ) : choice.person ? <PersonFace person={choice.person} size={24} /> : choice.devs ? (
              <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                <Bug size={14} aria-hidden="true" />
              </span>
            ) : (
              <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                <Users size={14} aria-hidden="true" />
              </span>
            )}
            name={choice.name}
            description={description || undefined}
            kind={choice.bot ? t("composer.mention.agent") : choice.person ? t("composer.mention.person") : choice.devs ? t("composer.mention.devs") : choice.team ? t("composer.mention.team") : t("composer.mention.channel")}
          />
        );
      })}
    </div>
  );
}
