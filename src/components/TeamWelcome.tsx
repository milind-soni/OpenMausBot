import { useEffect, useRef } from "react";
import { Lock } from "lucide-react";
import { WindowDragStrip } from "@/components/DesktopCapabilities";
import { PRIMARY, QUIET } from "@/components/cloud-welcome/parts";
import { PersonFace } from "@/components/TeamOwner";
import { markTeamPrivateChatsLineSaid } from "@/components/TeamPrivateChatsLine";
import { BotAvatar } from "@/components/Avatar";
import { t } from "@/lib/i18n";
import { finishTeamWelcome, markTeamWelcomeShown, teamWelcomeView, WELCOME_USE_MS } from "@/lib/team-welcome";
import { useShowThreads } from "@/lib/thread-preferences";
import { api, openBot, useStore } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";

/**
 * An invited person's first screen in a team, once: the team by its name and who invited them, who else is in it, the bots shared with
 * them, the one privacy rule, and one thing to do, a chat with a bot. Seen is kept on the team's Cloud for this person alone
 * (PUT /api/me/welcome), so it shows once whichever device they open first, in the app or a browser.
 */
export function TeamWelcome({ team, invitedBy }: { team: { id: string; name: string }; invitedBy: string | null }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const people = useTeamPeople();
  const view = teamWelcomeView({ invitedBy, people: people?.people ?? [], bots: state.bots });
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    action.current?.focus({ preventScroll: true });
    markTeamPrivateChatsLineSaid(team.id);
    markTeamWelcomeShown();
  }, [team.id]);
  // Reading this page is using the team, as any screen is: while it is in front of them, the session hears from them.
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") void api("/api/me", { timeoutMs: 10_000, background: true }).catch(() => {}); }, WELCOME_USE_MS);
    return () => clearInterval(timer);
  }, []);
  const done = () => { void finishTeamWelcome(team.id); };
  const start = () => {
    done();
    dispatch({ type: "showChat" });
    const bot = state.bots.find((candidate) => candidate.id === view.first?.id);
    if (bot) openBot(dispatch, bot, showThreads);
  };
  const inviter = view.inviter ? view.inviter.name.trim() || view.inviter.email : null;
  return <main data-team-welcome className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
    <WindowDragStrip />
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-5 pb-12 pt-10 max-md:pt-14">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-ink [text-wrap:balance]">{t("teamWelcome.title", { team: team.name })}</h1>
        <p data-team-welcome-invited className="text-[14px] leading-relaxed text-ink-secondary">
          {inviter ? t("teamWelcome.invited", { person: inviter, team: team.name }) : t("teamWelcome.invitedNobody", { team: team.name })}
        </p>
      </header>
      {view.people.length > 0 && <section aria-labelledby="team-welcome-people" className="flex flex-col gap-2">
        <h2 id="team-welcome-people" className="text-[13px] font-medium text-ink-secondary">{t("teamWelcome.people", { team: team.name })}</h2>
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          {view.people.map((person) => <li key={person.email} data-team-welcome-person={person.email} className="flex min-w-0 items-center gap-2 text-[14px] text-ink">
            <PersonFace person={{ ...person, name: person.name.trim() || person.email }} size={24} /><span className="truncate">{person.name.trim() || person.email}</span>
          </li>)}
          {view.morePeople > 0 && <li className="text-[14px] text-ink-secondary">{t("teamWelcome.more", { count: view.morePeople })}</li>}
        </ul>
      </section>}
      <section aria-labelledby="team-welcome-bots" className="flex flex-col gap-2">
        <h2 id="team-welcome-bots" className="text-[13px] font-medium text-ink-secondary">{t("teamWelcome.bots")}</h2>
        {view.bots.length ? <ul className="flex flex-col gap-2">
          {view.bots.map((bot) => {
            const full = state.bots.find((candidate) => candidate.id === bot.id);
            return <li key={bot.id} data-team-welcome-bot={bot.id} className="flex min-w-0 items-start gap-3 rounded-xl border border-hairline/50 bg-card/50 p-3">
              {full && <BotAvatar bot={full} size={28} />}
              <span className="min-w-0"><span className="block truncate text-[14px] font-medium text-ink">{bot.name}</span>
                {bot.line && <span className="block truncate text-[13px] text-ink-secondary">{bot.line}</span>}</span>
            </li>;
          })}
          {view.moreBots > 0 && <li className="text-[13px] text-ink-secondary">{t("teamWelcome.moreBots", { count: view.moreBots })}</li>}
        </ul> : <p className="text-[14px] text-ink-secondary">{t("teamWelcome.noBots", { team: team.name })}</p>}
      </section>
      <p data-team-private-chats className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-secondary">
        <Lock size={14} aria-hidden="true" className="mt-0.5 shrink-0" />{t("team.privateChats", { team: team.name })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {view.first ? <button ref={action} type="button" className={PRIMARY} onClick={start}>{t("teamWelcome.start", { bot: view.first.name })}</button>
          : <button ref={action} type="button" className={PRIMARY} onClick={done}>{t("teamWelcome.look")}</button>}
        {view.first && <button type="button" className={QUIET} onClick={done}>{t("teamWelcome.later")}</button>}
      </div>
    </div>
  </main>;
}
