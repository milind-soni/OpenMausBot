// GET /api/cloud-send/manifest: everything of the person's this server holds that a move carries, by id with a
// fingerprint per kind, on this computer and on their Cloud alike, so the desktop can check that a move carried it all.
// Read only, never a secret: credentials are named here and checked by fingerprint (cloud-send-verify.ts).
import { attachmentNames, type ChatStore } from "./cloud-chat-merge.ts";
import { listBotFiles, type BotFile } from "./cloud-send-files.ts";
import { chatHeads, conversationSettings } from "./cloud-send-chats.ts";
import { automationSwitches, routineRunIds, type MoveKindsDeps } from "./cloud-send-kinds.ts";
import { journalIds, memoryFiles, memoryLines, teamsHere } from "./cloud-send-memory.ts";
import type { CloudSendSummary } from "./cloud-send.ts";
import { factIdentity } from "./memory-entries.ts";
import { hashMemoryText } from "./memory-store.ts";
import { learnedState } from "./profile-learned.ts";
import type { BotRecord } from "./store.ts";
import type { TeamMemory } from "./team-memory.ts";

export interface ManifestConversation { threadId: string; bot?: string; room?: string; rows: number; newest: string; settings: Record<string, unknown> }

export interface CloudSendManifest {
  v: 1;
  appVersion: string;
  /** Bots, skills, logins, 1Password, settings and what only a move carries, as a move compares them (cloud-send.ts). */
  items: CloudSendSummary["items"];
  /** Each memory file of the bots a move carries, with its pieces' identities (cloud-send-memory.ts). */
  memory: Array<{ bot: string; path: string; hash: string; lines: string[] }>;
  /** Each bot's latest memory journal rows, by id. */
  journal: Array<{ bot: string; ids: string[] }>;
  /** What bots learned about the person, and what the person removed of it, by identity. */
  learned: string[];
  forgotten: string[];
  teams: Array<{ section: string; context: string[] | null; memory: string[] }>;
  rooms: Array<{ id: string; name: string; members: string[]; threads: string[] }>;
  /** "mcp:<name>", "key:<provider>", "composio" or "highlevel". */
  connections: string[];
  conversations: ManifestConversation[];
  /** The stored attachments the conversations' rows name. */
  attachments: string[];
  files: BotFile[];
  /** Each automation and whether it is on: the switch turns on there what was on here. */
  automations: Array<{ key: string; on: boolean }>;
  /** The routines' finished runs, by id with their routine's. */
  runs: Array<{ id: string; routine: string }>;
}

export interface ManifestSources {
  summary(): CloudSendSummary;
  store: ChatStore & { bots: BotRecord[] };
  dataDir: string;
  connections(): Promise<ReadonlyArray<{ id: string }>>;
  /** Each conversation's stored rows and its newest. */
  heads(): Map<string, { lastId: string; rows: number }>;
  kinds?: MoveKindsDeps;
  teamMemory?: Pick<TeamMemory, "list">;
  /** A move of this one bot into a team: what it carries only (its summary is already kept to it). */
  bot?: string;
}

function memoryOf(botId: string): CloudSendManifest["memory"] {
  return memoryFiles(botId).map((file) => ({ bot: botId, path: file.path, hash: hashMemoryText(file.text), lines: memoryLines(file.text) }));
}

export async function cloudSendManifest(sources: ManifestSources): Promise<CloudSendManifest> {
  const summary = sources.summary();
  const { store } = sources;
  const sent = [...new Set(summary.items.filter((item) => item.kind === "bot" && item.id).map((item) => item.id!))];
  const only = sources.bot;
  const rooms = only === undefined ? store.groups.filter((room) => !room.dm) : [];
  const counts = sources.heads();
  const conversations: ManifestConversation[] = chatHeads(only === undefined ? store.bots : store.bots.filter((bot) => bot.id === only), rooms).map((head) => ({
    threadId: head.threadId, ...(head.bot ? { bot: head.bot } : { room: head.room }), rows: counts.get(head.threadId)?.rows ?? 0, newest: head.lastId,
    settings: conversationSettings(store, head),
  }));
  const attachments = new Set<string>();
  for (const { threadId } of conversations) for (const row of store.messagesFor(threadId)) for (const name of attachmentNames(row, sources.dataDir)) attachments.add(name);
  if (only !== undefined) {
    return { v: 1, appVersion: summary.appVersion, items: summary.items, memory: [], journal: [], learned: [], forgotten: [], teams: [], rooms: [], connections: [],
      conversations, attachments: [...attachments].sort(), files: await listBotFiles(sources.dataDir, sent),
      automations: sources.kinds ? automationSwitches(sources.kinds, only) : [], runs: sources.kinds ? routineRunIds(sources.kinds, only) : [] };
  }
  return {
    v: 1,
    appVersion: summary.appVersion,
    items: summary.items,
    memory: sent.flatMap(memoryOf),
    journal: sent.map((bot) => ({ bot, ids: journalIds(bot) })).filter((entry) => entry.ids.length),
    learned: [...new Set(learnedState().learned.map((fact) => factIdentity(fact.text)).filter(Boolean))].sort(),
    forgotten: [...new Set(learnedState().removed)].sort(),
    teams: sources.teamMemory ? teamsHere(sources.teamMemory).map((team) => ({ section: team.section, context: team.context === null ? null : memoryLines(team.context),
      memory: team.memory.map((entry) => entry.key ?? `${entry.kind}:${entry.name.toLowerCase()}`).sort() })) : [],
    rooms: rooms.map((room) => ({ id: room.id, name: room.name, members: [...room.memberIds].sort(),
      threads: room.tasks?.length ? room.tasks.map((task) => task.threadId) : [room.threadId] })),
    connections: (await sources.connections()).map((item) => item.id).sort(),
    conversations,
    attachments: [...attachments].sort(),
    files: await listBotFiles(sources.dataDir, sent),
    automations: sources.kinds ? automationSwitches(sources.kinds) : [],
    runs: sources.kinds ? routineRunIds(sources.kinds) : [],
  };
}
