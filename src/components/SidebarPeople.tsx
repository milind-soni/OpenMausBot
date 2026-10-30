// On a Team Cloud: the team's people, with their pictures. Your own row opens your inbox, your chat with your Chief where
// everything sent to you arrives, with the inbox's list beside it, and counts the asks waiting on you there. Anyone
// else's puts @their name in the composer, which reaches their inbox once sent.
import { botOwner } from "../../shared/bot-owner";
import { openAsksOf } from "@/lib/bot-unread";
import { cn } from "@/lib/cn";
import { leadComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { openBot, openThread, useStore, type AppState, type Bot } from "@/state/store";
import { openInbox } from "@/state/inbox";
import { useTeamPeople, type TeamPerson } from "@/state/team-people";
import { PersonFace } from "./TeamOwner";

/** The bot that is this person's inbox: their own Chief, else their own MausBot. */
export function inboxBotOf(bots: readonly Bot[], email: string | undefined): Bot | undefined {
  if (!email) return undefined;
  const own = (bot: Bot) => !bot.hidden && botOwner(bot) === email;
  return bots.find((bot) => bot.chiefOfStaff && own(bot)) ?? bots.find((bot) => Boolean(bot.defaultBot?.person) && own(bot));
}

/** The composer on screen: the open room's or bot's conversation. */
function openComposer(state: Pick<AppState, "activeView" | "selectedId" | "groups" | "bots">): string | null {
  if (state.activeView !== "chat") return null;
  const group = state.groups.find((one) => one.id === state.selectedId);
  if (group) return `group:${group.id}:${group.threadId}`;
  const bot = state.bots.find((one) => one.id === state.selectedId);
  return bot ? `bot:${bot.id}:${bot.threadId}` : null;
}

const focusComposer = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea')?.focus());

export function SidebarPeople({ compact }: { compact: boolean }) {
  const team = useTeamPeople();
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  if (!team || team.people.length < 2) return null;
  const me = team.me;
  const people = [...team.people].sort((a, b) => Number(Boolean(b.you)) - Number(Boolean(a.you)) || a.name.localeCompare(b.name));
  const inbox = inboxBotOf(state.bots, me?.email);
  const inboxThread = inbox?.tasks?.find((task) => task.inbox)?.threadId;
  const waiting = inbox ? openAsksOf(inbox) : 0;
  const open = (person: TeamPerson) => {
    if (person.you) {
      if (inbox) openBot(dispatch, inbox, showThreads);
      if (inboxThread) openInbox({ tab: waiting ? "needs-you" : undefined });
      return;
    }
    const tag = `@${person.name} `;
    const draft = openComposer(state);
    if (draft) leadComposerDraft(draft, tag);
    else if (inbox && inboxThread) {
      leadComposerDraft(`bot:${inbox.id}:${inboxThread}`, tag);
      openThread(dispatch, { botId: inbox.id, threadId: inboxThread }, state, showThreads);
    } else if (inbox) openBot(dispatch, inbox, showThreads);
    focusComposer();
  };
  return (
    <section aria-label={t("sidebar.people.title")} data-sidebar-people className={cn(compact ? "px-1" : "px-2 pb-1")}>
      {!compact && <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-ink-tertiary">{t("sidebar.people.title")}</div>}
      <ul className={cn("flex", compact ? "flex-col items-center gap-1" : "flex-col")}>
        {people.map((person) => {
          const label = !person.you ? t("sidebar.people.mention", { name: person.name })
            : waiting ? t("sidebar.people.yourInboxWaiting", { count: waiting }) : t("sidebar.people.yourInbox");
          return (
            <li key={person.email}>
              <button type="button" onClick={() => open(person)} aria-label={label} title={label} data-person={person.email}
                className={cn("relative flex w-full min-w-0 items-center gap-2 rounded-lg text-left text-[13px] text-ink hover:bg-raised/60", compact ? "p-1" : "px-2 py-1")}>
                <PersonFace person={person} size={compact ? 22 : 18} />
                {!compact && <span className="min-w-0 flex-1 truncate">{person.you ? t("sidebar.people.you", { name: person.name }) : person.name}</span>}
                {person.you && waiting > 0 && (
                  <span aria-hidden="true" data-inbox-waiting={waiting}
                    className={cn("rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular-nums text-panel", compact && "absolute -right-0.5 -top-0.5 px-1 text-[10px]")}>{waiting}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
