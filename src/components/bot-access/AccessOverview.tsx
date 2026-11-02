import { useCallback, useState } from "react";

import { atLeast, BOT_ACCESS_LEVELS, higherLevel, type BotAccess, type BotAccessLevel, type GroupMembers } from "../../../shared/bot-access";
import { botOwner } from "../../../shared/bot-owner";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { membersOf, useTeamGroups } from "@/state/team-groups";
import { useTeamPeople, type TeamPerson } from "@/state/team-people";
import { BotAvatar } from "../Avatar";
import { Select } from "../Select";
import { PersonFace } from "../TeamOwner";
import { accessOfBot, levelLabel, saveAccess, withPerson } from "./access";
import { PeopleGroups } from "./PeopleGroups";
import { UndoToast, useTeamName } from "./ShareBotButton";

type Change = { botId: string; before: BotAccess; after: BotAccess; text: string };

/** The team's bots a person shares: each person's own MausBot is theirs alone and stays out. */
export const sharedBots = (bots: readonly Bot[]): Bot[] =>
  bots.filter((bot) => !bot.hidden && !bot.defaultBot?.person).sort((a, b) => a.name.localeCompare(b.name));

/** The least a person has by the bot's sharing without an entry of their own: everyone's level, or a group's higher one. */
export function floorFor(access: BotAccess, email: string, members: GroupMembers = () => undefined): BotAccessLevel {
  let floor = access.everyone;
  for (const [id, level] of Object.entries(access.groups ?? {})) if (members(id)?.includes(email)) floor = higherLevel(floor, level);
  return floor;
}

/** What a person may do with the bot by its sharing: the higher of their floor and their own entry. */
export function cellLevel(access: BotAccess, email: string, members: GroupMembers = () => undefined): BotAccessLevel {
  const own = access.people[email];
  const floor = floorFor(access, email, members);
  return own && atLeast(own, floor) ? own : floor;
}

/** Settings → Bot access on a team, for its admins: every team bot down the side, each User across with the level they
 * have, and what everyone in the team gets. The same sharing the bot's Share dialog changes, applied at once with Undo. */
export function AccessOverview() {
  const { state } = useStore();
  const team = useTeamPeople();
  const teamName = useTeamName();
  const groups = useTeamGroups(Boolean(team));
  const members = membersOf(groups);
  const [change, setChange] = useState<Change | null>(null);
  const [error, setError] = useState("");
  const settled = useCallback(() => setChange(null), []);
  if (!team || !teamName) return null;
  const people = team.people.filter((person) => person.role === "member").sort((a, b) => a.name.localeCompare(b.name));
  const bots = sharedBots(state.bots);

  const apply = async (bot: Bot, after: BotAccess, text: string) => {
    setError("");
    const before = accessOfBot(bot);
    try {
      await saveAccess(bot.id, after);
      setChange({ botId: bot.id, before, after, text });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-3" data-access-overview>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("botAccess.overview.intro", { team: teamName })}</p>
      {bots.length === 0 ? <p className="text-[13px] text-ink-secondary">{t("botAccess.overview.noBots")}</p> : (
        <div className="max-w-full overflow-x-auto rounded-xl border border-hairline/40 bg-card">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-hairline/40 text-left text-ink-secondary">
                <th scope="col" className="sticky left-0 z-[1] bg-card px-3 py-2 font-medium">{t("botAccess.overview.bot")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("botAccess.everyone", { team: teamName })}</th>
                {people.map((person) => (
                  <th key={person.email} scope="col" className="px-3 py-2 font-medium">
                    <span className="flex items-center gap-1.5 whitespace-nowrap"><PersonFace person={person} size={18} />{person.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bots.map((bot) => <BotRow key={bot.id} bot={bot} people={people} groupMembers={members} teamName={teamName} apply={apply} />)}
            </tbody>
          </table>
        </div>
      )}
      {people.length === 0 && bots.length > 0 && <p className="text-[12px] text-ink-secondary">{t("botAccess.overview.noPeople")}</p>}
      <p className="text-[12px] text-ink-secondary">{t("botAccess.admins")}</p>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      {groups && <PeopleGroups team={team} groups={groups} />}
      {change && <UndoToast key={`${change.botId}:${change.text}:${JSON.stringify(change.after)}`} text={change.text}
        onUndo={() => saveAccess(change.botId, change.before)} onDone={settled} />}
    </div>
  );
}

function BotRow({ bot, people, groupMembers, teamName, apply }: {
  bot: Bot; people: TeamPerson[]; groupMembers: GroupMembers; teamName: string; apply: (bot: Bot, after: BotAccess, text: string) => Promise<void>;
}) {
  const access = accessOfBot(bot);
  const owner = botOwner(bot);
  return (
    <tr className="border-b border-hairline/30 last:border-b-0" data-access-row={bot.id}>
      <th scope="row" className="sticky left-0 z-[1] bg-card px-3 py-1.5 text-left font-normal">
        <span className="flex items-center gap-2 whitespace-nowrap text-ink"><BotAvatar bot={bot} size={20} />{bot.name}</span>
      </th>
      <td className="px-3 py-1.5">
        <Select variant="ghost" aria-label={t("botAccess.overview.setForEveryone", { bot: bot.name })} value={access.everyone}
          onChange={(event) => {
            const everyone = event.target.value as BotAccessLevel;
            void apply(bot, { ...access, everyone }, t("botAccess.overview.toastEveryone", { bot: bot.name, team: teamName, level: levelLabel(everyone) }));
          }}>
          {BOT_ACCESS_LEVELS.map((level) => <option key={level} value={level}>{level === "none" ? t("botAccess.onlyAdded") : levelLabel(level)}</option>)}
        </Select>
      </td>
      {people.map((person) => (
        <td key={person.email} className="px-3 py-1.5" data-access-cell={person.email}>
          {person.email === owner ? <span className="whitespace-nowrap px-2.5 text-ink-secondary">{t("botAccess.owner")}</span> : (
            <Select variant="ghost" aria-label={t("botAccess.overview.cell", { name: person.name, bot: bot.name })} value={cellLevel(access, person.email, groupMembers)}
              onChange={(event) => {
                const level = event.target.value as BotAccessLevel;
                void apply(bot, withPerson(access, person.email, level === "none" || level === floorFor(access, person.email, groupMembers) ? null : level),
                  t("botAccess.overview.toastPerson", { name: person.name, bot: bot.name, level: levelLabel(level) }));
              }}>
              {BOT_ACCESS_LEVELS.map((level) => <option key={level} value={level} disabled={!atLeast(level, floorFor(access, person.email, groupMembers))}>{levelLabel(level)}</option>)}
            </Select>
          )}
        </td>
      ))}
    </tr>
  );
}
