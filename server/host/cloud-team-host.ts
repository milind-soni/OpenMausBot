// A Team Cloud's side of the audience rule (server/audience.ts, docs/team-cloud.md): which conversation is whose, which
// memory layer a turn reads and writes, whose "About you" a turn gets, and what a member session is told. On any server
// that is not a Team Cloud every answer here is the plain one (the bot's own memory, the server's profile), so a My Cloud
// and a desktop behave exactly as before.
import type { ThreadAudiences } from "../bot-visibility.ts";
import { type Audience, baseBotId, layerAudience, layerId, mayRead, memberAudience, audienceMember, threadAudienceFrom } from "../audience.ts";
import type { CloudTeam, TeamRole } from "../cloud-team.ts";
import { createPeopleAbout, type PeopleAbout } from "../people-about.ts";
import { personKey } from "../person-key.ts";
import { ensureWorkspace, loadMemory, workspaceDir } from "../workspace.ts";

export interface CloudTeamHostDeps {
  team: CloudTeam | null;
  dataDir: string;
  store: { groupByThread(threadId: string): { id: string } | undefined };
  starters: { get(threadId: string): string | undefined };
  /** Keys that name no person (nobody, outside). */
  markers: ReadonlySet<string>;
  language?: () => string | undefined;
}

export interface TeamSessionInfo { id: string; name: string; role: TeamRole }

export function createCloudTeamHost(deps: CloudTeamHostDeps) {
  const team = deps.team;
  const people: PeopleAbout = createPeopleAbout(deps.dataDir);
  const audienceOf = (threadId: string): Audience =>
    threadAudienceFrom({ room: deps.store.groupByThread(threadId)?.id, starter: deps.starters.get(threadId), markers: deps.markers });
  /** The layer a turn in this conversation writes into: the bot's own folder off a team or for the team's conversations,
   * a sibling folder for a room's or a member's. The folder exists before the turn starts, so the box can bind it. */
  const layer = (botId: string, threadId: string): string => {
    if (!team) return botId;
    const id = layerId(botId, audienceOf(threadId));
    if (id !== botId) ensureWorkspace(id, deps.language?.());
    return id;
  };
  return {
    team,
    audienceOf,
    layer,
    /** What a turn in this conversation reads: its own layer and the team's (the bot's own folder). */
    memoryIds(botId: string, threadId: string): string[] {
      const own = layer(botId, threadId);
      return own === botId ? [botId] : [own, botId];
    },
    /** The folders a turn's box must put back besides the bot's own: its layer, when it has one. */
    layerDirs(botId: string, threadId: string): string[] {
      const own = layer(botId, threadId);
      return own === botId ? [] : [workspaceDir(own)];
    },
    /** Captured facts about the person, into that person's own "About you"; nothing for the team's or a room's layer. */
    learnAbout(layerOrBotId: string, plan: (current: string) => { next: string; count: number } | null): number {
      const person = team ? audienceMember(layerAudience(layerOrBotId)) : null;
      if (!person) return 0;
      const planned = plan(people.read(person));
      if (!planned) return 0;
      people.write(person, planned.next);
      return planned.count;
    },
    /** Whether a turn in `threadId` may read `other` (the read rule). Off a team: everything, as before. */
    readableFrom(threadId: string): (other: string) => boolean {
      if (!team) return () => true;
      const turn = audienceOf(threadId);
      return (other) => mayRead(audienceOf(other), turn);
    },
    /** The team's notes, read-only, for a turn that writes elsewhere (a room's or a member's layer). */
    sharedNotesPrompt(botId: string, threadId: string): string {
      if (!team || layer(botId, threadId) === botId) return "";
      const shared = loadMemory(botId);
      if (!shared) return "";
      return `\n\n${team.name}'s shared notes with you (read-only here; what you save in this conversation stays with it):\n${shared.text}`;
    },
    /** "About the user" for a turn: on a team only a member's own, in their own conversations; the server's profile otherwise. */
    profileFor<T extends { aboutMe?: string }>(threadId: string, serverProfile: T | undefined): { aboutMe?: string } | undefined {
      if (!team) return serverProfile;
      const person = audienceMember(audienceOf(threadId));
      return person ? { aboutMe: people.read(person) } : undefined;
    },
    /** The person whose "About you" a layer's captured facts belong to; null for the team's and a room's. */
    aboutPerson(layerOrBotId: string): string | null {
      return team ? audienceMember(layerAudience(layerOrBotId)) : null;
    },
    /** A turn's captured facts are the member's own when the conversation is theirs. */
    ownTurn(threadId: string): boolean {
      return team !== null && audienceMember(audienceOf(threadId)) !== null;
    },
    people,
    baseBotId,
    /** How a member session sees conversations: with each one's audience and the member's own key. */
    audiencesFor(viewer: { kind: "all" } | { kind: "member"; email?: string }): ThreadAudiences | undefined {
      if (!team || viewer.kind !== "member") return undefined;
      return { of: audienceOf, person: viewer.email ? personKey({ id: "", email: viewer.email }) : null };
    },
    /** Whose browser a conversation's turns use: on a team its audience's (the member's, the group chat's or the team's),
     * the bot's own elsewhere. */
    browserAudience(threadId: string): Audience {
      return team ? audienceOf(threadId) : "team";
    },
    /** Whose browser a person's live view of a bot shows: the conversation's when they name one they see, their own
     * when they name none, and null when they name one hidden from them. The bot's own off a team. */
    viewerBrowserAudience(input: { threadId: string | null; sees(threadId: string): boolean; person: string | null }): Audience | null {
      if (!team) return "team";
      if (input.threadId !== null) return input.sees(input.threadId) ? audienceOf(input.threadId) : null;
      return input.person ? memberAudience(input.person) : "team";
    },
    /** A session's team, for the app: the team's name and the person's role. */
    sessionInfo(session: { teamRole?: TeamRole }): TeamSessionInfo | null {
      return team && session.teamRole ? { id: team.id, name: team.name, role: session.teamRole } : null;
    },
    memberAudience,
  };
}

export type CloudTeamHost = ReturnType<typeof createCloudTeamHost>;
