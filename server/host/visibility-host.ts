// Who sees what on this server (bot-visibility.ts): each session's viewer and its VisibleSet (cached until the next bot,
// room or conversation change), the one check every request naming a bot, conversation, room, routine or file passes, and
// the per-conversation filter a list uses. On a Team Cloud an admin is a viewer with a person too: every bot and room, but
// only their own private chats (audience.ts).
import { audienceEquals, narrowestAudience, roomFeeds, routineRunVisible, routineVisible, SEES_EVERYTHING, VisibleSet, type PathSubject, type ThreadAudiences, type ThreadOwner, type Viewer } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";

export interface VisibilityHostDeps {
  /** index.ts's store, made after this host. */
  store(): Pick<Store, "bots" | "groups" | "bot" | "group" | "botByThread" | "groupByThread" | "patchGroup">;
  routines(): Pick<RoutineManager, "listRoutines" | "listRuns"> | null;
  /** A Team Cloud: an admin session is a person too. */
  team: boolean;
  audiencesFor(viewer: Viewer): ThreadAudiences | undefined;
  threadsReferencing(name: string): readonly string[];
}

export function createVisibilityHost(deps: VisibilityHostDeps) {
  const store = { get bots() { return deps.store().bots; }, get groups() { return deps.store().groups; }, bot: (id: string) => deps.store().bot(id),
    group: (id: string) => deps.store().group(id), botByThread: (id: string) => deps.store().botByThread(id), groupByThread: (id: string) => deps.store().groupByThread(id) };
  function viewerFor(auth: RequestAuth): Viewer {
    if (auth.kind === "loopback" || (auth.scopes.includes("admin") && !deps.team)) return SEES_EVERYTHING;
    if (auth.scopes.includes("admin")) return { kind: "all", email: auth.session.email ?? "" };
    return { kind: "member", ...(auth.session.email ? { email: auth.session.email } : {}) };
  }

  const threadOwners = new Map<string, ThreadOwner | null>();
  const visibleSets = new Map<string, VisibleSet>();
  function threadOwner(threadId: string): ThreadOwner | undefined {
    let owner = threadOwners.get(threadId);
    if (owner === undefined) {
      const bot = store.botByThread(threadId);
      const group = bot ? undefined : store.groupByThread(threadId);
      owner = bot ? { bot: bot.id } : group ? { group: group.id } : null;
      if (threadOwners.size >= 20_000) threadOwners.clear();
      threadOwners.set(threadId, owner);
    }
    return owner ?? undefined;
  }
  function visibleTo(viewer: Viewer): VisibleSet {
    const key = viewer.kind === "all" ? (viewer.email === undefined ? "*" : `admin:${viewer.email.trim().toLowerCase()}`) : `member:${viewer.email?.trim().toLowerCase() ?? ""}`;
    let set = visibleSets.get(key);
    if (!set) {
      set = new VisibleSet(store.bots, store.groups, viewer, threadOwner, deps.audiencesFor(viewer));
      if (visibleSets.size >= 1_000) visibleSets.clear();
      visibleSets.set(key, set);
    }
    return set;
  }
  /** Cached until the next bot, room or thread change (store.onChange). */
  function forgetVisibility(): void {
    threadOwners.clear();
    visibleSets.clear();
  }
  /** Whether a list row about this conversation may go to this session: on a Team Cloud someone else's private chat never. */
  const threadShown = (auth: RequestAuth) => {
    const visible = visibleTo(viewerFor(auth));
    return (threadId: string) => !visible.hides(threadId);
  };

  const attachmentThreads = new Map<string, { at: number; threads: readonly string[] }>();
  function threadsUsingAttachment(name: string): readonly string[] {
    const cached = attachmentThreads.get(name);
    if (cached && Date.now() - cached.at < 60_000) return cached.threads;
    const threads = deps.threadsReferencing(name);
    if (attachmentThreads.size >= 2_000) attachmentThreads.clear();
    attachmentThreads.set(name, { at: Date.now(), threads });
    return threads;
  }

  /** The one visibility check every member request naming a subject passes through (a team's admin's too). */
  function subjectVisible(subject: PathSubject, visible: VisibleSet): boolean {
    switch (subject.kind) {
      case "bot":
        return !store.bot(subject.id) || visible.bot(subject.id);
      case "thread":
        return !threadOwner(subject.id) || visible.thread(subject.id);
      case "group":
        return !store.group(subject.id) || visible.group(subject.id);
      case "routine": {
        const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === subject.id);
        return !routine || routineVisible(routine, visible);
      }
      case "routine-run": {
        const run = deps.routines()?.listRuns().find((candidate) => candidate.id === subject.id);
        return !run || routineRunVisible(run, visible);
      }
      case "attachment":
        return visible.attachment(subject.name, threadsUsingAttachment);
    }
  }

  /** A member may schedule a routine only for a bot or room they can see. */
  function hiddenRoutineTarget(body: unknown, visible: VisibleSet): string | null {
    if (visible.everything || !body || typeof body !== "object") return null;
    const { botId, groupId } = body as { botId?: unknown; groupId?: unknown };
    if (typeof botId === "string" && store.bot(botId) && !visible.bot(botId)) return "no such bot";
    if (typeof groupId === "string" && store.group(groupId) && !visible.group(groupId)) return "no such channel";
    return null;
  }

  function roomMemberAudiences(group: GroupRecord): unknown[] {
    return group.memberIds.flatMap((id) => {
      const member = store.bot(id);
      return member ? [member.visibility] : [];
    });
  }
  function roomFeedsBot(group: GroupRecord, bot: Pick<BotRecord, "visibility">): boolean {
    return roomFeeds([...roomMemberAudiences(group), group.audienceFloor], bot.visibility);
  }
  /** A room's floor stays at the narrowest audience it ever had, set before a restricted bot can leave; only an admin's
   * explicit reset widens it. */
  function settleRoomFloor(group: GroupRecord): void {
    if (group.dm) return;
    const next = narrowestAudience([group.audienceFloor, ...roomMemberAudiences(group)]);
    if (audienceEquals(next, group.audienceFloor)) return;
    deps.store().patchGroup(group.id, { audienceFloor: next === "everyone" ? undefined : next });
  }

  return { viewerFor, threadOwner, visibleTo, forgetVisibility, threadShown, subjectVisible, hiddenRoutineTarget, roomFeedsBot, roomMemberAudiences, settleRoomFloor };
}
