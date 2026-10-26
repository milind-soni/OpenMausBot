// When a person leaves a Team Cloud (an admin removes them, or they leave), what was theirs alone goes with them: their
// private chats with every bot (messages, notifications, the files only those chats used), their memory layers, their
// engine home (its transcripts), their "About you", their own connections, their own browsers, and every session and
// phone of theirs. Nothing of it is handed to an admin. The Admin tells this machine with a signed request
// (`POST /api/cloud/team/member-left`, cloud-signed.ts).
//
// Each conversation keeps its starter (thread-starters.json, a hash): what other records still name it (a decision's
// row, a usage trace) stays someone else's, so no admin ever reads it there either.
import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { memberAudience, type Audience } from "../audience.ts";
import { audienceHome } from "../engine-homes/layout.ts";
import { forgetBotMemoryJournal, journalFile } from "../memory-journal.ts";
import { deleteBotMemoryFiles } from "../message-db.ts";
import { personKey } from "../person-key.ts";

const ATTACHMENT = /\/api\/attachments\/([A-Za-z0-9][\w.-]{0,200})/g;
const PERSON = /^p_[\w-]{22}$/;

export interface TeamMemberLeftDeps {
  dataDir: string;
  store: {
    readonly bots: ReadonlyArray<{ id: string; avatarUrl?: string | null; tasks?: ReadonlyArray<{ threadId: string }> }>;
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
  /** The app's own deletion of a bot's conversations (routes/tasks.ts), with everything it lets go of. */
  deleteTasks(botId: string, threadIds: string[]): { deleted: string[] } | null;
  /** Conversations whose messages still name this text (message-db.ts threadsReferencing). */
  threadsReferencing(fragment: string): readonly string[];
  deleteAttachment(name: string): void;
  eraseBrowsers(audience: Audience): Promise<boolean>;
  /** Their own connections, keys and MCP sign-ins (team-connections.ts). */
  forgetConnections(person: string): void;
}

export type TeamMemberLeftResult = { chats: number; layers: number; sessions: number; files: number; browsers: boolean };

export function createTeamMemberLeft(deps: TeamMemberLeftDeps): (email: string) => Promise<TeamMemberLeftResult> {
  const workspaces = join(deps.dataDir, "workspaces");
  return async (email) => {
    const person = personKey({ id: "", email });
    if (!PERSON.test(person)) throw new Error("not a person key");
    // First, so nothing of theirs is opened, written or streamed while it goes.
    const sessions = deps.revokeSessions(email);
    const mine = new Set(deps.openedBy(person).filter((threadId) => deps.privateTo(threadId) === person));
    let chats = 0;
    const files = new Set<string>();
    for (const bot of deps.store.bots) {
      const threads = (bot.tasks ?? []).map((task) => task.threadId).filter((threadId) => mine.has(threadId));
      if (!threads.length) continue;
      for (const threadId of threads) {
        if (deps.busy(bot.id, threadId)) await deps.stop(bot.id, threadId).catch(() => {});
        for (const match of JSON.stringify(deps.store.messagesFor(threadId)).matchAll(ATTACHMENT)) files.add(match[1]!);
      }
      chats += deps.deleteTasks(bot.id, threads)?.deleted.length ?? 0;
    }
    // A file only their chats used goes too; one a bot's picture or another conversation uses stays.
    let removed = 0;
    for (const name of files) {
      const url = `/api/attachments/${name}`;
      if (name.includes("..") || deps.threadsReferencing(url).length || deps.store.bots.some((bot) => bot.avatarUrl === url)) continue;
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
    return { chats, layers, sessions, files: removed, browsers };
  };
}
