// Who is here on a Team Cloud, wired for the server (docs/team-cloud.md "Who is here"): the server's set of open event
// streams lives here, and each team session's stream in it counts its person here (team-presence.ts). POST
// /api/presence/here says which conversation a window shows, and the frames go out on the streams themselves, outside
// the replay buffer: presence is now or never.
// Security: the one rule is `reads`. A conversation counts only when more than one person can read it (a bot's shared
// chat, a group chat) and the person can; anything else, a private chat above all, is taken as "no conversation", so
// nobody, an admin included, learns that it is open, which bot it is with or that it exists.
import { ownerEmail } from "../../shared/bot-owner.ts";
import { PRESENCE_HERE_PATH, type PersonPresence, type PresenceFrame } from "../../shared/team-presence.ts";
import { audienceMember, type Audience } from "../audience.ts";
import type { VisibleSet, Viewer } from "../bot-visibility.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { SessionRecord } from "../sessions.ts";
import { deliverSseFrame, type SseFanoutClient } from "../sse-fanout.ts";
import type { Store } from "../store.ts";
import type { TeamPeople } from "../team-people.ts";
import { createTeamPresence, realClock, type PresenceClock, type PresenceEvent } from "../team-presence.ts";

export interface PresenceStream extends SseFanoutClient {
  person?: Pick<SessionRecord, "email" | "membershipAuthority" | "moveIn">;
}

export interface TeamPresenceHostDeps {
  /** Null off a team: then nothing here does anything. */
  people: TeamPeople | null;
  /** A frame every team stream gets, replayed to one that reconnects (`team.people`). */
  broadcast(payload: Record<string, unknown>): void;
  audienceOf(threadId: string): Audience;
  /** A conversation its person shared with one other person (host/conversation-shares.ts): read by those two. */
  sharedWithOne?(threadId: string): boolean;
  store(): Pick<Store, "botByThread" | "groupByThread" | "bot">;
  visibleTo(viewer: Viewer): Pick<VisibleSet, "thread">;
  clock?: PresenceClock;
  /** OMB_TEAM_PRESENCE_GRACE_MS when not given (tests shorten it). */
  graceMs?: number;
}

const TAB = /^[\w-]{1,64}$/;
const THREAD_ID = /^[\w-]{1,100}$/;
const PEOPLE_GAP_MS = 1_000;

/** The person a team session speaks for; null for anything else (the server itself, a move-in sign-in). */
function teamPerson(session: PresenceStream["person"] | undefined): string | null {
  return session?.membershipAuthority === "team" && session.email && !session.moveIn ? ownerEmail(session.email) : null;
}

const frameOf = (frame: PresenceFrame) => `data: ${JSON.stringify(frame)}\n\n`;

/** Sends a presence frame, cutting loose a stream that cannot take it, as every other frame does. */
function send(stream: SseFanoutClient, frame: string): void {
  if (deliverSseFrame(stream, "presence", frame) === "disconnected") stream.close();
}

/** `streams` is the server's set of open event streams: adding one counts its person here, deleting it starts their
 * grace. */
export function createTeamPresenceHost<Stream extends PresenceStream>(deps: TeamPresenceHostDeps) {
  const { people } = deps;

  /** More than one person can read it: never a conversation that is someone's own, nor one with someone's own bot. */
  function shared(threadId: string): boolean {
    if (audienceMember(deps.audienceOf(threadId)) !== null && !deps.sharedWithOne?.(threadId)) return false;
    const store = deps.store();
    const group = store.groupByThread(threadId);
    const bots = group ? group.memberIds.map((id) => store.bot(id)) : [store.botByThread(threadId)];
    return bots.length > 0 && bots.every((bot) => !!bot && !bot.defaultBot?.person);
  }
  function reads(email: string, threadId: string): boolean {
    const role = people?.list().find((person) => person.email === email)?.role;
    if (!role || !shared(threadId)) return false;
    return deps.visibleTo(role === "member" ? { kind: "member", email } : { kind: "all", email }).thread(threadId);
  }

  function sendTo(emails: ReadonlySet<string> | null, frame: PresenceFrame): void {
    const text = frameOf(frame);
    for (const stream of streams) {
      const email = teamPerson(stream.person);
      if (email !== null && (emails === null || emails.has(email))) send(stream, text);
    }
  }
  function emit(event: PresenceEvent): void {
    switch (event.type) {
      case "person":
        return sendTo(null, { kind: "team.presence", email: event.email, here: event.here });
      case "thread":
        return sendTo(new Set(event.people), { kind: "thread.presence", threadId: event.threadId, people: event.people });
    }
  }

  const clock = deps.clock ?? realClock;
  const presence = people ? createTeamPresence({ reads, emit, clock, graceMs: deps.graceMs ?? (Number(process.env.OMB_TEAM_PRESENCE_GRACE_MS) || undefined) }) : null;
  let peopleTimer: { cancel(): void } | undefined;
  people?.onChange((email, change) => {
    if (change === "left") presence?.forget(email);
    peopleTimer ??= clock.later(() => { peopleTimer = undefined; deps.broadcast({ kind: "team.people" }); }, PEOPLE_GAP_MS);
  });

  const routes: RouteHandler = async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== PRESENCE_HERE_PATH) return PASS;
    if (method !== "POST") return json(res, 405, { error: "POST only" });
    if (!presence) return json(res, 404, { error: "not found" });
    const body: unknown = await readBody(req, 4096);
    const given = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const threadId = typeof given.threadId === "string" && THREAD_ID.test(given.threadId) ? given.threadId : null;
    if (typeof given.tab !== "string" || !TAB.test(given.tab)) return json(res, 400, { error: "Send this window's tab id." });
    const email = auth.kind === "session" ? teamPerson(auth.session) : null;
    if (email !== null && auth.kind === "session") presence.window(email, `${auth.session.id}:${given.tab}`, threadId);
    return json(res, 200, { ok: true });
  };

  const streams = new (class extends Set<Stream> {
    override add(stream: Stream): this {
      super.add(stream);
      const email = teamPerson(stream.person);
      if (email !== null) presence?.streamOpened(email);
      return this;
    }
    override delete(stream: Stream): boolean {
      if (!super.delete(stream)) return false;
      const email = teamPerson(stream.person);
      if (email !== null) presence?.streamClosed(email);
      return true;
    }
  })();

  return {
    routes,
    streams,
    /** What the people list says of someone: whether they are here now. Undefined off a team. */
    of: presence ? (email: string): PersonPresence => ({ here: presence.here(email) }) : undefined,
    /** Whether this person has the conversation open in a window now. */
    looking(email: string, threadId: string): boolean {
      return presence?.viewers(threadId).includes(email) === true;
    },
    close(): void {
      presence?.close();
      peopleTimer?.cancel();
    },
  };
}

export type TeamPresenceHost = ReturnType<typeof createTeamPresenceHost>;
