// What a move asks of a big workspace's server: 100 bots and thousands of conversations with attachments. Its check reads
// conversations straight from messages.db, never parsing one through the store (which keeps every conversation it parsed
// in memory for ten minutes, more than a 2 GB Cloud holds), and its answers are the ones a full read gives.
import { beforeAll, describe, expect, it } from "vitest";

import { activePath, attachmentNames } from "./cloud-chat-merge.ts";
import { chatIds, stampHeld, verifyChats } from "./cloud-send-chats.ts";
import { cloudSendManifest } from "./cloud-send-manifest.ts";
import { attachmentNamesOf, linkedPath, threadLinks } from "./cloud-send-rows.ts";
import { DATA_DIR } from "./config.ts";
import { deleteThread, threadHeads } from "./message-db.ts";
import { Store, type Message } from "./store.ts";

const BOTS = 100, TASKS = 20, ROWS = 12;

/** The store, with every read of a whole conversation through it counted. */
function counted(store: Store) {
  const reads = { messagesFor: 0 };
  const wrapped = new Proxy(store, {
    get(target, key, receiver) {
      if (key === "messagesFor") return (threadId: string) => { reads.messagesFor++; return target.messagesFor(threadId); };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: wrapped, reads };
}

/** 100 bots with 20 conversations each, 12 rows to a conversation, every fourth line with a stored attachment; a few rows
 * stored without a parent, as an old app stored them. */
function bigWorkspace() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
  const threads: string[] = [];
  let at = 1_000, attachment = 0;
  for (let b = 0; b < BOTS; b++) {
    const bot = store.createBot({ name: `Bot ${b}` }, { seedMessages: false });
    const conversations = [bot.threadId, ...Array.from({ length: TASKS - 1 }, (_, i) => store.createTask(bot.id, `Task ${i}`, false)!.threadId)];
    for (const threadId of conversations) {
      const rows: Message[] = [];
      for (let r = 0; r < ROWS; r++) {
        const id = `${threadId}-m${r}`;
        const named = r % 4 === 0 ? { attachments: [{ path: `${DATA_DIR}/attachments/${String(attachment++).padStart(8, "0")}-big.png`, name: "shot.png", mimeType: "image/png" }] } : {};
        const legacy = b === 7 && r > 0;
        rows.push({ id, at: at++, role: r % 2 ? "bot" : "user", kind: "text", text: `line ${r}`, ...(legacy ? {} : { parentId: r ? `${threadId}-m${r - 1}` : null }), ...named } as Message);
      }
      store.importTranscript(threadId, rows, rows.at(-1)!.id);
      threads.push(threadId);
    }
  }
  return { store, threads };
}

describe("a move's check of a big workspace", () => {
  let base: Store, threads: string[];
  beforeAll(() => { ({ store: base, threads } = bigWorkspace()); }, 120_000);

  it("lists the attachments only from rows that name one, as reading every row does", () => {
    const full = new Set<string>();
    for (const threadId of threads) for (const row of base.messagesFor(threadId)) for (const name of attachmentNames(row, DATA_DIR)) full.add(name);
    expect(full.size).toBe(BOTS * TASKS * (ROWS / 4));
    expect(attachmentNamesOf(new Set(threads), DATA_DIR)).toEqual(full);
    expect(attachmentNamesOf(new Set(threads.slice(0, 1)), DATA_DIR).size).toBe(ROWS / 4);
  });

  it("reads a conversation's ids and path as the store does, rows stored without a parent included", () => {
    for (const threadId of [threads[0]!, threads[7 * TASKS]!, threads[7 * TASKS + 3]!]) {
      const links = threadLinks(threadId)!;
      expect(links.ids).toEqual(base.messagesFor(threadId).map((row) => row.id));
      expect(linkedPath(links)).toEqual(activePath(base.messagesFor(threadId), base.activeLeaf(threadId)).map((row) => row.id));
    }
  });

  it("answers My Cloud's manifest without the attachments and files the check never needs, and reads no conversation through the store", async () => {
    const { store, reads } = counted(base);
    const manifest = await cloudSendManifest({ summary: () => ({ v: 1, appVersion: "0", items: [] }), store, dataDir: DATA_DIR, connections: async () => [], heads: threadHeads,
      attachments: false, files: false });
    expect(manifest.conversations).toHaveLength(BOTS * TASKS);
    expect(manifest.attachments).toBeUndefined();
    expect(manifest.files).toBeUndefined();
    const whole = await cloudSendManifest({ summary: () => ({ v: 1, appVersion: "0", items: [] }), store, dataDir: DATA_DIR, connections: async () => [], heads: threadHeads });
    expect(whole.attachments).toHaveLength(BOTS * TASKS * (ROWS / 4));
    expect(reads.messagesFor, "not one conversation parsed and kept by the store").toBe(0);
  });

  it("checks 200 conversations in one request without parsing any through the store, and finds what is missing", () => {
    const { store, reads } = counted(base);
    const asked = threads.slice(0, 200).map((threadId) => {
      const ids = chatIds({ store, dataDir: DATA_DIR }, threadId, 0)!;
      return { threadId, ids: threadId === threads[5] ? [...ids.ids, "gone-1"] : ids.ids, path: { after: null, ids: ids.path, last: true } };
    });
    const answers = verifyChats(store, asked);
    expect(reads.messagesFor).toBe(0);
    expect(answers.filter((entry) => entry.missing.length)).toEqual([expect.objectContaining({ threadId: threads[5], missing: ["gone-1"] })]);
    expect(answers.every((entry) => entry.path?.holds === true && entry.path.length === ROWS)).toBe(true);
    expect(answers[0]!.unstamped, "the owner's own lines that do not carry the owner yet").toBe(ROWS / 2);
  });

  it("stamps the owner's lines it holds reading only those rows, and a conversation it lacks is skipped", () => {
    const { store, reads } = counted(base);
    const threadId = threads[1]!;
    const { stamped } = stampHeld(store, [{ threadId, ids: threadLinks(threadId)!.ids }, { threadId: "t-nobody", ids: ["x"] }], { person: "p_owner", name: "Ada" });
    expect(stamped).toBe(ROWS / 2);
    expect(verifyChats(store, [{ threadId, ids: threadLinks(threadId)!.ids }])[0]!.unstamped).toBe(0);
    expect(reads.messagesFor, "only to patch the rows it stamped").toBeLessThanOrEqual(ROWS / 2);
  });

  it("a conversation messages.db has no row of reads as the store holds it", () => {
    const threadId = threads.at(-1)!;
    deleteThread(threadId);
    expect(threadLinks(threadId)).toBeNull();
    expect(verifyChats(base, [{ threadId, ids: ["a"] }])[0]!.missing).toEqual(["a"]);
  });
});
