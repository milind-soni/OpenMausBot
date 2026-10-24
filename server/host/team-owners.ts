// A Team Cloud's bot owners, wired for the server: the people a bot can report to, whose a bot's asks are, what a
// notification or Chief notice reaches, and each person's brief. Off a team every answer here is the unrouted one.
import { botOwner } from "../../shared/bot-owner.ts";
import type { Notification } from "../../shared/notification.ts";
import type { NeedsYouItem } from "../../shared/today.ts";
import { ASK_NOTIFICATIONS, createAskRouting, type AskViewer } from "../ask-routing.ts";
import type { Audience } from "../audience.ts";
import { setCreatedBy } from "../bot-owners.ts";
import type { CloudTeam } from "../cloud-team.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { BotRecord, Store } from "../store.ts";
import { createTeamPeople } from "../team-people.ts";
import type { TodayViewer } from "../today.ts";
import { createTeamBriefs, type TeamBriefDeps, type TeamBriefs } from "./team-briefs.ts";

export type { AskViewer } from "../ask-routing.ts";

export interface TeamOwnersDeps {
  team: CloudTeam | null;
  dataDir: string;
  sessions: Pick<SessionRegistry, "list" | "onSessionIssued">;
  store(): Pick<Store, "bots" | "bot" | "patchBot">;
  audienceOf(threadId: string): Audience;
  starters: { get(threadId: string): string | undefined; set(threadId: string, person: string): void };
}

type BriefDeps = Pick<TeamBriefDeps, "store" | "runs" | "threadBusy" | "notify"> & {
  needsYou(asks: NonNullable<TodayViewer["asks"]>): NeedsYouItem[];
};

const keyOf = (email: string) => personKey({ id: "", email });

export function createTeamOwners(deps: TeamOwnersDeps) {
  const team = deps.team;
  const people = team ? createTeamPeople(deps.dataDir) : null;
  if (people) {
    for (const session of deps.sessions.list()) if (session.email && session.teamRole) people.seen(session.email, session.teamRole);
    deps.sessions.onSessionIssued((session) => {
      if (session.membershipAuthority === "team" && session.email && session.teamRole) people.seen(session.email, session.teamRole);
    });
  }
  const routing = createAskRouting({ team: Boolean(team), audienceOf: deps.audienceOf, bot: (botId) => deps.store().bot(botId) ?? undefined, personKeyOf: keyOf,
    gone: (email) => people?.gone(email) ?? false });
  /** Whose a session's asks are: its person's, and an Admin's too when nobody owns the bot. */
  const viewer = (auth: RequestAuth): AskViewer => ({
    person: auth.kind === "session" && auth.session.email ? personKey(auth.session) : null,
    admin: auth.kind === "loopback" || auth.scopes.includes("admin"),
  });
  let briefs: TeamBriefs | null = null;

  return {
    people,
    routing,
    viewer,
    /** Whether a stream frame reaches this person: a notification of an ask only the person it is for. */
    reaches: (ask: AskViewer, payload: Record<string, unknown>): boolean =>
      payload.kind !== "notify" || routing.notificationReaches(ask, (payload.notification ?? {}) as Record<string, unknown>),
    /** Each person's brief, once the routines, the turn state and notify exist. */
    startBriefs(brief: BriefDeps): void {
      if (!team) return;
      briefs = createTeamBriefs({
        ...brief, dataDir: deps.dataDir, personKeyOf: keyOf, askedPerson: routing.askedPerson, language: () => team.language,
        needsYou: (person) => brief.needsYou((botId, threadId) => routing.askedPerson(botId, threadId) === person),
        startedBy: (threadId) => deps.starters.get(threadId), open: (threadId, person) => deps.starters.set(threadId, person),
      });
    },
    /** A notification went out: the brief of the person it was routed to catches up. */
    notified(notification: Notification): void {
      if (briefs && (ASK_NOTIFICATIONS.has(notification.kind) || notification.kind === "done")) briefs.soon(routing.askedPerson(notification.botId, notification.threadId));
    },
    /** A member opened the app: their own brief; undefined off a team. */
    presence: team ? (auth: RequestAuth, language?: string) => briefs?.active(viewer(auth).person, language) ?? { returned: false } : undefined,
    /** What the Chief notices are told about owners; undefined off a team. */
    noticeRouting: team ? {
      askedPerson: routing.askedPerson,
      personOf: (chief: BotRecord) => { const owner = botOwner(chief); return owner ? keyOf(owner) : null; },
      startedBy: (threadId: string) => deps.starters.get(threadId),
      open: (threadId: string, person: string) => deps.starters.set(threadId, person),
    } : undefined,
    /** Today's and Needs you's question: is this ask the session's person's? Undefined off a team. */
    asks: team ? (auth: RequestAuth, botId: string | undefined, threadId: string) => routing.asks(viewer(auth), botId, threadId) : undefined,
    /** The Admin said this member left: what reported to them goes to the Admins. */
    left(email: string): void {
      people?.left(email);
    },
    /** Bots moved in before owners were recorded report to whoever moved them. */
    backfill(moveIns: Record<string, { email?: string }>): void {
      for (const [botId, move] of Object.entries(moveIns)) if (move.email) setCreatedBy(deps.store(), botId, move.email);
    },
  };
}

export type TeamOwners = ReturnType<typeof createTeamOwners>;
