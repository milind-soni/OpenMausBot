// When a person leaves a Team Cloud (an admin removes them, or they leave), what was theirs alone goes with them: their
// own MausBot with its chats and notes, their private chats with every bot (messages, notifications, the files only
// those chats used, and the files they uploaded and never sent), the routines that live in those chats, their memory
// layers, their
// engine home (its transcripts), their "About you", their own connections, their own browsers, and every session and
// phone of theirs. Nothing of it is handed to an admin. A routine they wrote for a shared place keeps running, as the
// routine of whoever looks after its bot now (the Admins when nobody does), and admin activity says it was handed over.
// The Admin tells this machine with a signed request (`POST /api/cloud/team/member-left`, cloud-signed.ts).
//
// Each conversation keeps its starter (thread-starters.json, a hash): what other records still name it (a decision's
// row, a usage trace) stays someone else's, so no admin ever reads it there either.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { defaultBotPerson, type DefaultBotFields } from "../../shared/default-bot.ts";
import type { AdminActionRow } from "../admin-activity.ts";
import { memberAudience, type Audience } from "../audience.ts";
import { forgetDefaultBot } from "../default-bot.ts";
import { audienceHome } from "../engine-homes/layout.ts";
import { forgetBotMemoryJournal, journalFile } from "../memory-journal.ts";
import { deleteBotMemoryFiles } from "../message-db.ts";
import { personKey } from "../person-key.ts";
import { memberUploads } from "./member-uploads.ts";

/** A file in attachments/, by its URL or by its path (as JSON escapes it) a sent document's tag carries. */
const ATTACHMENT = /attachments(?:\/|\\)+([A-Za-z0-9][\w.-]{0,200})/g;
const PERSON = /^p_[\w-]{22}$/;

export interface TeamMemberLeftDeps {
  dataDir: string;
  store: {
    readonly bots: ReadonlyArray<{ id: string; avatarUrl?: string | null; tasks?: ReadonlyArray<{ threadId: string }> } & DefaultBotFields>;
    messagesFor(threadId: string): readonly unknown[];
  };
  /** The conversations a person opened (thread-starters.json). */
  openedBy(person: string): string[];
  /** The person a conversation is private to (audience.ts), else null. */
  privateTo(threadId: string): string | null;
  /** Ends every session and open pairing code of this address; how many sessions ended. */
  revokeSessions(email: string): number;
  busy(botId: string, threadId: string): boolean;
  stop(botId: string, threadId: string): Promise<void>;
  /** Stops every turn of a bot: its chats, its routine run and the room turn it is in. */
  stopBot(botId: string): Promise<void>;
  /** The app's own deletion of a bot's conversations (routes/tasks.ts), with everything it lets go of. */
  deleteTasks(botId: string, threadIds: string[]): { deleted: string[] } | null;
  /** The app's own deletion of a bot (its chats, notes and folder), MausBot included; false when it could not. */
  deleteBot(botId: string): Promise<boolean>;
  /** Conversations whose messages still name this text (message-db.ts threadsReferencing). */
  threadsReferencing(fragment: string): readonly string[];
  deleteAttachment(name: string): void;
  eraseBrowsers(audience: Audience): Promise<boolean>;
  /** Their own connections, keys and MCP sign-ins (team-connections.ts). */
  forgetConnections(person: string): void;
  /** Every routine: `home` is the person whose private chat it lives in (routine-home.ts), `writer` who last wrote it,
   * `files` the attachments/ names it carries. */
  routines(): ReadonlyArray<{ id: string; name: string; botId: string; home: string | null; writer: string | undefined; files: readonly string[] }>;
  deleteRoutine(id: string): void;
  /** The routine runs as `to`'s from now on (a person key), or nobody's, whose asks go to the Admins (null); it stops
   * reporting into a chat of `left`, the person who left. */
  handRoutine(id: string, left: string, to: string | null): void;
  /** Who looks after the bot (an address), else null. */
  ownerOf(botId: string): string | null;
  /** One row of the team's admin activity. */
  record(row: Omit<AdminActionRow, "at" | "actor">): void;
}

export type TeamMemberLeftResult = { chats: number; layers: number; sessions: number; files: number; browsers: boolean; bots: number; botsKept: number; routines: number; routinesHandedOver: number };

export function createTeamMemberLeft(deps: TeamMemberLeftDeps): (email: string) => Promise<TeamMemberLeftResult> {
  const workspaces = join(deps.dataDir, "workspaces");
  const attachments = join(deps.dataDir, "attachments");
  return async (email) => {
    const person = personKey({ id: "", email });
    if (!PERSON.test(person)) throw new Error("not a person key");
    // First, so nothing of theirs is opened, written or streamed while it goes.
    const sessions = deps.revokeSessions(email);
    const address = email.trim().toLowerCase();
    // Before their chats go: which routine lives in one is read from those chats.
    const everyRoutine = deps.routines();
    const ownRoutines = everyRoutine.filter((routine) => routine.home === person);
    const written = everyRoutine.filter((routine) => routine.home === null && routine.writer === person);
    for (const routine of written) {
      const owner = deps.ownerOf(routine.botId);
      const to = owner && owner !== address ? owner : null;
      deps.handRoutine(routine.id, person, to === null ? null : personKey({ id: "", email: to }));
      deps.record({ category: "bot", action: "routine.handover", target: { kind: "routine", id: routine.id, name: routine.name }, after: { owner: to } });
    }
    for (const routine of ownRoutines) deps.deleteRoutine(routine.id);
    const mine = new Set(deps.openedBy(person).filter((threadId) => deps.privateTo(threadId) === person));
    let chats = 0;
    const files = new Set<string>([...memberUploads(deps.dataDir, person), ...ownRoutines.flatMap((routine) => routine.files)]);
    const noteFiles = (threadId: string) => {
      for (const match of JSON.stringify(deps.store.messagesFor(threadId)).matchAll(ATTACHMENT)) files.add(match[1]!);
    };
    let bots = 0;
    let botsKept = 0;
    for (const bot of deps.store.bots.filter((candidate) => candidate.defaultBot && defaultBotPerson(candidate) === address)) {
      const threads = (bot.tasks ?? []).map((task) => task.threadId);
      threads.forEach(noteFiles);
      await deps.stopBot(bot.id).catch(() => {});
      if (!(await deps.deleteBot(bot.id).catch(() => false))) {
        botsKept++;
        continue;
      }
      bots++;
      chats += threads.length;
    }
    forgetDefaultBot(deps.dataDir, address);
    for (const bot of deps.store.bots) {
      const threads = (bot.tasks ?? []).map((task) => task.threadId).filter((threadId) => mine.has(threadId));
      if (!threads.length) continue;
      for (const threadId of threads) {
        if (deps.busy(bot.id, threadId)) await deps.stop(bot.id, threadId).catch(() => {});
        noteFiles(threadId);
      }
      chats += deps.deleteTasks(bot.id, threads)?.deleted.length ?? 0;
    }
    // A file only their chats or private routines used, or that they never sent, goes too; one a bot's picture, another
    // conversation or a routine that stays uses stays.
    const routineFiles = new Set(deps.routines().flatMap((routine) => routine.files));
    let removed = 0;
    for (const name of files) {
      const url = `/api/attachments/${name}`;
      if (name.includes("..") || !existsSync(join(attachments, name)) || routineFiles.has(name) || deps.threadsReferencing(name).length || deps.store.bots.some((bot) => bot.avatarUrl === url)) continue;
      deps.deleteAttachment(basename(name));
      removed++;
    }
    let layers = 0;
    let entries: string[] = [];
    try { entries = readdirSync(workspaces); } catch {}
    for (const layer of entries.filter((entry) => entry.endsWith(`--member-${person}`))) {
      rmSync(join(workspaces, layer), { recursive: true, force: true });
      rmSync(journalFile(layer), { force: true });
      deleteBotMemoryFiles(layer);
      forgetBotMemoryJournal(layer);
      layers++;
    }
    rmSync(join(deps.dataDir, "people", person), { recursive: true, force: true });
    rmSync(audienceHome(deps.dataDir, memberAudience(person)), { recursive: true, force: true });
    deps.forgetConnections(person);
    const browsers = await deps.eraseBrowsers(memberAudience(person)).catch(() => false);
    return { chats, layers, sessions, files: removed, browsers, bots, botsKept, routines: ownRoutines.length, routinesHandedOver: written.length };
  };
}
