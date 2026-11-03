import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Search } from "lucide-react";

import { sharedLevel, type BotAccess } from "../../../shared/bot-access";
import { botOwner } from "../../../shared/bot-owner";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { ownerOf, useTeamPeople, type TeamPeople, type TeamPerson } from "@/state/team-people";
import { BotAvatar } from "../Avatar";
import { PersonFace } from "../TeamOwner";
import { accessOfBot, nameOf, personOf, saveAccess, withPerson } from "./access";
import { UndoToast, useTeamName } from "./ShareBotButton";
import { ShareBotDialog } from "./ShareBotDialog";
import { EntryFace } from "./ShareControls";

type Change = { botId: string; before: BotAccess; after: BotAccess; text: string };
type Listing = "bot" | "person";

const STACK_SHOWN = 4;
const ROW = "flex w-full min-w-0 items-center gap-3 px-3 py-2 text-start";
const LIST = "flex flex-col divide-y divide-hairline/30 overflow-hidden rounded-xl border border-hairline/40 bg-card";

/** The team's bots a person shares: each person's own MausBot is theirs alone and stays out. */
export const sharedBots = (bots: readonly Bot[]): Bot[] =>
  bots.filter((bot) => !bot.hidden && !bot.defaultBot?.person).sort((a, b) => a.name.localeCompare(b.name));

const hasAccess = (bot: Bot, email: string): boolean => botOwner(bot) === email || sharedLevel(accessOfBot(bot), email) !== "none";

const ownerLine = (bot: Bot, team: TeamPeople): string => {
  const owner = ownerOf(bot, team);
  return owner ? t("lookedAfter.line", { name: owner.name }) : t("lookedAfter.nobody");
};

const includes = (wanted: string, ...parts: Array<string | undefined>): boolean => parts.some((part) => part?.toLowerCase().includes(wanted));

/** Settings → Bot access on a team, for its admins: the team's bots, or its people, each opening what can change there.
 * A person's stored level stays as it is; the page shows who is added and lets them be removed. */
export function AccessOverview() {
  const { state } = useStore();
  const team = useTeamPeople();
  const teamName = useTeamName();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [listing, setListing] = useState<Listing>("bot");
  const [query, setQuery] = useState("");
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [personEmail, setPersonEmail] = useState<string | null>(null);
  const cameFrom = useRef<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const [error, setError] = useState("");
  const settled = useCallback(() => setChange(null), []);
  useEffect(() => {
    if (personEmail || !cameFrom.current) return;
    [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-access-person]") ?? [])].find((row) => row.dataset.accessPerson === cameFrom.current)?.focus();
    cameFrom.current = null;
  }, [personEmail]);
  if (!team || !teamName) return null;
  const members = team.people.filter((person) => person.role === "member").sort((a, b) => a.name.localeCompare(b.name));
  const bots = sharedBots(state.bots);
  const sharing = sharingId ? bots.find((bot) => bot.id === sharingId) : undefined;
  const person = personEmail ? members.find((member) => member.email === personEmail) : undefined;
  const wanted = query.trim().toLowerCase();

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
    <div ref={rootRef} className="flex min-w-0 flex-col gap-3" data-access-overview>
      {person ? (
        <PersonBots person={person} bots={bots.filter((bot) => hasAccess(bot, person.email))} team={team} teamName={teamName} apply={apply}
          onBack={() => { cameFrom.current = person.email; setPersonEmail(null); }} />
      ) : <>
        <p className="ps-4 text-[13px] leading-relaxed text-ink-secondary">{t("botAccess.overview.introUse", { team: teamName })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
            <input type="search" value={query} data-access-search aria-label={t(listing === "bot" ? "botAccess.overview.searchBots" : "botAccess.overview.searchPeople")}
              placeholder={t(listing === "bot" ? "botAccess.overview.searchBots" : "botAccess.overview.searchPeople")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }}
              className="w-full rounded-lg border border-hairline/50 bg-transparent py-1.5 pe-2.5 ps-8 text-[13px] text-ink placeholder:text-ink-secondary focus:border-focus focus:outline-none" />
          </div>
          <div role="group" aria-label={t("botAccess.overview.listBy")} className="flex shrink-0 rounded-full bg-raised/70 p-0.5">
            {(["bot", "person"] as const).map((entry) => (
              <button key={entry} type="button" aria-pressed={listing === entry} data-access-listing={entry} onClick={() => { setListing(entry); setQuery(""); }}
                className={cn("rounded-full px-3 py-1 text-[13px] leading-[18px]", listing === entry ? "bg-menu font-medium text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>
                {t(entry === "bot" ? "botAccess.overview.byBot" : "botAccess.overview.byPerson")}
              </button>
            ))}
          </div>
        </div>
        {listing === "bot"
          ? <BotList bots={bots.filter((bot) => !wanted || includes(wanted, bot.name, ownerOf(bot, team)?.name, botOwner(bot) ?? undefined))} anyBots={bots.length > 0} team={team} onOpen={setSharingId} />
          : <PeopleList people={members.filter((member) => !wanted || includes(wanted, member.name, member.email))} anyPeople={members.length > 0} bots={bots} onOpen={setPersonEmail} />}
        <p className="ps-4 text-[12px] text-ink-secondary">{t("botAccess.admins")}</p>
      </>}
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      {sharing && <ShareBotDialog bot={sharing} teamName={teamName} onClose={() => setSharingId(null)}
        onChanged={(next) => setChange({ botId: sharing.id, ...next })} />}
      {change && <UndoToast key={`${change.botId}:${change.text}:${JSON.stringify(change.after)}`} text={change.text}
        onUndo={() => saveAccess(change.botId, change.before)} onDone={settled} />}
    </div>
  );
}

function BotList({ bots, anyBots, team, onOpen }: { bots: Bot[]; anyBots: boolean; team: TeamPeople; onOpen: (id: string) => void }) {
  if (!anyBots) return <p className="text-[13px] text-ink-secondary">{t("botAccess.overview.noBots")}</p>;
  if (!bots.length) return <p className="text-[13px] text-ink-secondary">{t("botAccess.overview.noBotMatch")}</p>;
  return (
    <ul className={LIST}>
      {bots.map((bot) => {
        const access = accessOfBot(bot);
        const owner = botOwner(bot);
        return (
          <li key={bot.id} className="min-w-0">
            <button type="button" aria-haspopup="dialog" data-access-row={bot.id} onClick={() => onOpen(bot.id)} className={cn(ROW, "hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06] focus-visible:outline-none")}>
              <BotAvatar bot={bot} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-[18px] text-ink">{bot.name}</span>
                <span className="block truncate text-[12px] leading-4 text-ink-secondary">{ownerLine(bot, team)}</span>
              </span>
              <span className="min-w-0 max-w-[40%] truncate text-[13px] text-ink-secondary" data-access-summary>{access.everyone === "none" ? t("botAccess.onlyAdded") : t("botAccess.overview.everyoneUses")}</span>
              <PeopleStack entries={Object.keys(access.people).filter((entry) => entry !== owner)} team={team} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PeopleStack({ entries, team }: { entries: string[]; team: TeamPeople }) {
  if (!entries.length) return null;
  const names = entries.map((entry) => nameOf(entry, team)).join(", ");
  const beyond = entries.length - STACK_SHOWN;
  return (
    <span role="img" aria-label={names} title={names} data-access-stack={entries.length} className="flex shrink-0 -space-x-0.5 rtl:space-x-reverse">
      {entries.slice(0, STACK_SHOWN).map((entry) => (
        <span key={entry} className="flex rounded-full ring-2 ring-card"><EntryFace person={personOf(entry, team)} size={22} /></span>
      ))}
      {beyond > 0 && <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-card px-1 text-[11px] font-medium text-ink-secondary ring-2 ring-card">+{beyond}</span>}
    </span>
  );
}

function PeopleList({ people, anyPeople, bots, onOpen }: { people: TeamPerson[]; anyPeople: boolean; bots: Bot[]; onOpen: (email: string) => void }) {
  if (!anyPeople) return <p className="text-[13px] text-ink-secondary">{t("botAccess.overview.noPeople")}</p>;
  if (!people.length) return <p className="text-[13px] text-ink-secondary">{t("botAccess.noMatch")}</p>;
  return (
    <ul className={LIST}>
      {people.map((person) => {
        const count = bots.filter((bot) => hasAccess(bot, person.email)).length;
        return (
          <li key={person.email} className="min-w-0">
            <button type="button" data-access-person={person.email} onClick={() => onOpen(person.email)} className={cn(ROW, "hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06] focus-visible:outline-none")}>
              <PersonFace person={person} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-[18px] text-ink">{person.name}</span>
                <span className="block truncate text-[12px] leading-4 text-ink-secondary">{person.email}</span>
              </span>
              <span className="shrink-0 text-[13px] text-ink-secondary">{count === 1 ? t("botAccess.overview.botCount.one") : t("botAccess.overview.botCount.other", { count })}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PersonBots({ person, bots, team, teamName, apply, onBack }: {
  person: TeamPerson; bots: Bot[]; team: TeamPeople; teamName: string;
  apply: (bot: Bot, after: BotAccess, text: string) => Promise<void>; onBack: () => void;
}) {
  return (
    <>
      <div>
        <button type="button" autoFocus data-access-back onClick={onBack} className="-ms-2 flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
          <ChevronLeft size={14} aria-hidden="true" className="rtl:-scale-x-100" />{t("botAccess.overview.allPeople")}
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-3 px-3">
        <PersonFace person={person} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium leading-[18px] text-ink">{person.name}</span>
          <span className="block truncate text-[12px] leading-4 text-ink-secondary">{person.email}</span>
        </span>
      </div>
      {bots.length === 0 ? <p className="px-3 text-[13px] text-ink-secondary">{t("botAccess.overview.noBotsForPerson", { name: person.name })}</p> : (
        <ul className={LIST}>
          {bots.map((bot) => <PersonBotRow key={bot.id} bot={bot} person={person} team={team} teamName={teamName} apply={apply} />)}
        </ul>
      )}
    </>
  );
}

function PersonBotRow({ bot, person, team, teamName, apply }: {
  bot: Bot; person: TeamPerson; team: TeamPeople; teamName: string; apply: (bot: Bot, after: BotAccess, text: string) => Promise<void>;
}) {
  const access = accessOfBot(bot);
  const owns = botOwner(bot) === person.email;
  const own = access.people[person.email];
  const level = sharedLevel(access, person.email);
  return (
    <li className={ROW} data-access-person-bot={bot.id}>
      <BotAvatar bot={bot} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] leading-[18px] text-ink">{bot.name}</span>
        <span className="block truncate text-[12px] leading-4 text-ink-secondary">{!own && !owns && level === access.everyone ? t("botAccess.everyoneUse", { team: teamName }) : ownerLine(bot, team)}</span>
      </span>
      <span className="min-w-0 shrink-0 text-[13px] text-ink-secondary">
        {owns ? <span className="px-2">{t("lookedAfter.badge")}</span> : own ? (
          <button type="button" data-access-remove={bot.id} aria-label={t("botAccess.overview.removeFrom", { name: person.name, bot: bot.name })}
            onClick={() => void apply(bot, withPerson(access, person.email, null), t("botAccess.overview.toastRemoved", { name: person.name, bot: bot.name }))}
            className="rounded-md px-2 py-1 hover:bg-ink/[0.06] hover:text-ink">{t("botAccess.remove")}</button>
        ) : null}
      </span>
    </li>
  );
}
