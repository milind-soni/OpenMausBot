// index.ts's wiring of the link between a person's computer and their Cloud (server/bot-link/link.ts): the link over this
// server's store and coordinator, the computer's end that asks the Cloud, and the routes. With the link off (no
// bot-link.json in the data folder) `start` asks nobody and every hook here answers as if the link did not exist.
import { dirname } from "node:path";
import { mascotBodyColorSchema, mascotMaterialSchema } from "../../shared/bot-avatar.ts";

import { createDialer } from "../bot-link/dial.ts";
import { createBotLink } from "../bot-link/link.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import type { createPlacesElsewhere, Explained } from "../places-elsewhere.ts";
import { redactSecretsInText } from "../redact.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotLinkRoutes, linkSessionUser } from "../routes/bot-link.ts";
import { isLinkedId } from "../bot-link/protocol.ts";
import type { Level } from "../runtime/types.ts";
import type { BotRecord, Store } from "../store.ts";
import type { HandoffFiles, PassedFile } from "./handoff-files.ts";
import { sentRow, teammateResultRow } from "./handoff-sent.ts";
import { createLinkedRooms, type LinkedRoomsDeps } from "./bot-link-rooms.ts";

export interface BotLinkHostDeps {
  dataDir: string;
  environmentId: string;
  store: Pick<Store, "bots" | "bot" | "standIns" | "createTask" | "taskByThread" | "appendMessage" | "patchTask" | "onChange" | "group" | "groups" | "groupTaskByThread" | "markGroupThreadUnread" | "activePath" | "messagesFor" | "patchGroup">;
  /** A room line in the language of its thread, and what follows a member's answer (its mentions take their turns). */
  roomLine: LinkedRoomsDeps["line"];
  roomFollow?: LinkedRoomsDeps["follow"];
  /** The room's lines as a member reads them, and who stands behind a room thread's words when it is not the person. */
  roomWindow: LinkedRoomsDeps["window"];
  roomOpener?: LinkedRoomsDeps["opener"];
  /** A room's far members can be reached now, or no longer can: the app hears the room again. */
  roomChanged?(groupId: string): void;
  coordinator(): Coordinator;
  kick(): void;
  level(bot: BotRecord): Level;
  /** A work thread a far bot opened here is named from the job it handed, behind "@Sender · ". */
  titleHanded?(botId: string, threadId: string, brief: string, prefix: string): void;
  refusal(bot: BotRecord): string | null;
  /** Why this bot cannot take work from the other place now (server/bot-link/far-side.ts), or null. */
  acceptRefusal?(bot: BotRecord): string | null;
  /** The person paused this bot, or its plan keeps it asleep: the other places are told, so they do not offer it. */
  paused?(botId: string): boolean;
  language(threadId: string): string | undefined;
  personName(threadId: string): string | undefined;
  sessions: { issue(input: { label: string; scopes: Array<"admin" | "client">; email?: string; userId?: string }): { token: string; session: { id: string } }; revoke(id: string): boolean };
  local(auth: RequestAuth): boolean;
  owner(auth: RequestAuth): boolean;
  power(): { sleeping(): boolean; sleepSignal(): AbortSignal } | null | undefined;
  files: Pick<HandoffFiles, "carried" | "crossed" | "sentWith" | "returnedWith">;
  /** One crossed file into the attachment store, named by its bytes, under attach_file's own type and size rules. */
  storeFile(path: string, name: string, root: string): Promise<{ attachment: { kind: string; path: string; mime: string; name?: string }; bytes: number }>;
  log(line: string): void;
}

type PlacesElsewhere = ReturnType<typeof createPlacesElsewhere>;

/** Another place's body tint and fur land here only as valid values, since the avatar paints them. */
const bodyColor = (value: string | undefined) => {
  const color = mascotBodyColorSchema.safeParse(value).data;
  return color ? { mascotBodyColor: color } : {};
};
const fur = (value: string | undefined) => {
  const style = mascotMaterialSchema.safeParse(value).data;
  return style ? { mascotMaterial: style } : {};
};

export function createBotLinkHost(deps: BotLinkHostDeps) {
  const { store } = deps;
  /** Each bot of each linked place as a record this place finds by its address: its name and look, and where it lives.
   * It has no conversation, model or tools here, and takes no turn here. */
  const syncStandIns = () => {
    const next = new Map<string, BotRecord>();
    for (const { id, peer, place, kind, bot } of link.linked()) {
      next.set(id, { id, name: bot.name, color: bot.color ?? "blue", threadId: "", tasks: [], resumeCursors: {}, modelSelection: { instanceId: "", model: bot.model ?? "" },
        home: { place: peer, placeName: place.name, botId: bot.id, kind }, ...(bot.title ? { title: bot.title } : {}), ...(bot.description ? { description: bot.description } : {}),
        ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}), ...(bot.mascotFaceColor ? { mascotFaceColor: bot.mascotFaceColor } : {}),
        ...bodyColor(bot.mascotBodyColor), ...fur(bot.mascotMaterial) } as unknown as BotRecord);
    }
    // A far member of a room here that cannot be reached now (the link is off, its place is unlinked, or its place no
    // longer has it) stays a member: it is found by its address, named as it was last known, and takes no turn.
    rooms.sync();
    for (const { id, gone, name, color, place, placeName, botId, kind, title, mascotBody, mascotFaceColor, mascotBodyColor, mascotMaterial } of rooms.absent()) {
      next.set(id, { id, name, color: color ?? "blue", threadId: "", tasks: [], resumeCursors: {}, modelSelection: { instanceId: "", model: "" },
        home: { place, placeName, botId, ...(kind ? { kind } : {}), gone }, ...(title ? { title } : {}), ...(mascotBody ? { mascotBody } : {}), ...(mascotFaceColor ? { mascotFaceColor } : {}), ...bodyColor(mascotBodyColor), ...fur(mascotMaterial) } as unknown as BotRecord);
    }
    store.standIns.clear();
    for (const [id, record] of next) if (isLinkedId(id)) store.standIns.set(id, record);
    for (const group of store.groups) {
      const far = group.dm || !group.memberIds.some(isLinkedId) ? "" : JSON.stringify(rooms.far(group));
      if ((farTold.get(group.id) ?? "") === far) continue;
      if (far) farTold.set(group.id, far); else farTold.delete(group.id);
      deps.roomChanged?.(group.id);
    }
  };
  /** What the app was last told of each room's far members. */
  const farTold = new Map<string, string>();
  const rooms = createLinkedRooms({ dataDir: deps.dataDir, store, coordinator: deps.coordinator, on: () => link.on(), linked: (peer) => link.has(peer), online: (peer) => link.online(peer), linkedBots: () => link.linked(), selfName: () => link.selfName(), wanted: (person) => link.wanted(person),
    personName: deps.personName, line: deps.roomLine, window: deps.roomWindow, log: deps.log, ...(deps.roomOpener ? { opener: deps.roomOpener } : {}), ...(deps.roomFollow ? { follow: deps.roomFollow } : {}) });
  const link = createBotLink({
    dataDir: deps.dataDir, coordinator: deps.coordinator, kick: deps.kick, log: deps.log, rooms, directoryChanged: () => { syncStandIns(); }, revoke: (sessionId) => { deps.sessions.revoke(sessionId); },
    bots: () => store.bots, bot: (id) => store.bot(id),
    refusal: (bot) => deps.refusal(bot as BotRecord),
    acceptRefusal: (bot) => deps.acceptRefusal?.(bot as BotRecord) ?? null,
    paused: (bot) => deps.paused?.(bot.id) ?? false,
    model: (bot) => (bot as BotRecord).modelSelection.model,
    level: (bot) => deps.level(bot as BotRecord),
    openThread: (bot, title, opener, brief) => {
      const threadId = store.createTask(bot.id, title, false, undefined, { ...opener, at: Date.now(), kind: "work" })?.threadId;
      if (threadId) deps.titleHanded?.(bot.id, threadId, brief, `@${opener.name} · `);
      return threadId;
    },
    hasThread: (botId, threadId) => Boolean(store.taskByThread(botId, threadId)),
    personName: deps.personName,
    files: {
      carried: deps.files.carried, crossed: deps.files.crossed,
      store: async (files) => {
        const stored: PassedFile[] = [];
        for (const file of files) {
          const { attachment, bytes } = await deps.storeFile(file.path, file.name, dirname(file.path));
          if (attachment.kind === "image" || attachment.kind === "file") stored.push({ kind: attachment.kind, path: attachment.path, name: attachment.name || file.name, mime: attachment.mime, bytes });
        }
        return stored;
      },
    },
    sentRow: ({ sender, threadId, recipient, workThreadId, nodeId, reason, doneWhen, roomId }) => {
      const room = roomId ? store.group(roomId) : undefined;
      store.appendMessage(threadId, sentRow({ sender: { id: sender.id, name: sender.name, color: sender.color ?? "blue" }, recipient: { ...recipient, color: "blue" }, threadId: workThreadId, via: "direct", language: deps.language(threadId), ...(room ? { room: { id: room.id, name: room.name, here: true } } : {}),
        ...(reason ? { reason } : {}), ...(doneWhen ? { doneWhen: redactSecretsInText(doneWhen) } : {}), ...deps.files.sentWith(nodeId) }));
    },
    resultRow: (parent: HandoffView, child: HandoffView, name: string) => {
      const room = parent.groupId ? store.group(parent.groupId) : undefined;
      if (parent.groupId ? !room || !store.groupTaskByThread(room.id, parent.threadId) : !store.taskByThread(parent.botId, parent.threadId)) return;
      const done = child.status === "completed";
      store.appendMessage(parent.threadId, { role: "bot", kind: "activity", roomRequest: { id: child.id, phase: "result" }, ...deps.files.returnedWith(child, parent),
        tool: { name: teammateResultRow(deps.language(parent.threadId), child, name, undefined, undefined), ok: done,
          ...(done && child.result.trim() ? { output: redactSecretsInText(child.result.trim()).slice(0, 2_000) } : {}) } });
      if (room) store.markGroupThreadUnread(room.id, parent.threadId, true);
      else if (!parent.parentId && parent.reply !== "poll") store.patchTask(parent.botId, parent.threadId, { unread: true });
    },
  });
  const dialer = createDialer({ link, log: deps.log });
  let stopWatching: (() => void) | undefined, upkeep: NodeJS.Timeout | undefined;
  /** While the link is on: bot changes reach the other places, and old records and stray file bytes are cleared hourly.
   * Every change to a bot can change what the other places are told (a bot made, renamed, hidden, moved, its look, model
   * or level); the link tells them once changes settle, and only what did change. */
  const watch = () => {
    stopWatching ??= store.onChange((change) => { if (link.on() && (change.type === "bot" || change.type === "bot.deleted" || change.type === "bots.order")) link.botsChanged(); });
    watchRooms();
    if (upkeep) return;
    upkeep = setInterval(() => link.tidy(), 60 * 60_000);
    upkeep.unref?.();
  };
  /** A room's members changed: a far member is remembered by name for when its place cannot be asked, and one the person
   * removed is forgotten. Watched while the link is on, or while a room still has a far member. */
  let stopWatchingRooms: (() => void) | undefined;
  const watchRooms = () => { stopWatchingRooms ??= store.onChange((change) => { if (change.type === "group" && (store.standIns.size > 0 || rooms.any())) syncStandIns(); }); };
  const routes = createBotLinkRoutes({ link, dialer, turnedOn: watch, environmentId: deps.environmentId, local: deps.local, owner: deps.owner, power: deps.power,
    // A personal Cloud issues no session without its owner's scopes, so the link's carries them; `linkSessionRefusal`
    // (wired where requests are admitted) keeps it to the link's own routes.
    issue: (auth, label, computerId) => {
      const issued = deps.sessions.issue({ label, scopes: [...auth.scopes], userId: linkSessionUser(computerId), ...(auth.kind === "session" && auth.session.email ? { email: auth.session.email } : {}) });
      return { token: issued.token, sessionId: issued.session.id };
    },
    revoke: (sessionId) => { deps.sessions.revoke(sessionId); } });
  return {
    link, routes, rooms,
    /** Why no bot here has the name a bot asked for, past "no such bot". With the link on, the other places' bots it can
     * reach are listed and nothing says another place cannot be reached; a team, which the link never joins, is named as
     * before. Off: what the person's app said of their other places, as always. */
    explain(name: string, places: Pick<PlacesElsewhere, "explain" | "kindOf">): Explained {
      if (!link.on() || places.kindOf(name) === "team") return places.explain(name);
      return { hint: link.reachableElsewhere() };
    },
    /** Once the server is up. Off: nothing. On, on the computer: it starts asking the Cloud. */
    start(): void {
      // Off: nothing, unless a room here still has a member from another place, which is then found and shown as away.
      if (!link.on()) { if (rooms.any()) { syncStandIns(); watchRooms(); } return; }
      syncStandIns();
      watch();
      link.tidy();
      if (link.role() === "dialer") dialer.start({ gentle: true });
    },
    close(): void { if (upkeep) clearInterval(upkeep); stopWatching?.(); stopWatchingRooms?.(); dialer.close(); link.close(); },
  };
}
