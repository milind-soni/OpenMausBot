import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { personKey } from "../person-key.ts";
import { createUploadOwners } from "./member-uploads.ts";
import { createTeamMemberLeft, type TeamMemberLeftDeps } from "./team-member-left.ts";

const BOB = "bob@acme.test";
const bob = personKey({ id: "", email: BOB });
const name = (n: number) => `0000000${n}-0000-4000-8000-000000000000.txt`;

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-member-left-"));
  const attachments = join(dataDir, "attachments");
  mkdirSync(attachments, { recursive: true });
  const messages = new Map<string, unknown[]>();
  const bots = [
    { id: "scout", tasks: [{ threadId: "scout-main" }, { threadId: "bob-private" }] },
    { id: "bobs-mausbot", defaultBot: { person: BOB }, tasks: [{ threadId: "mausbot-main" }, { threadId: "mausbot-second" }] },
  ];
  const deleted: string[] = [];
  const deletedBots: string[] = [];
  const working = new Set<string>();
  const routines: Array<{ id: string; name: string; botId: string; home: string | null; writer: string | undefined; files: string[] }> = [];
  const handed: Array<[string, string, string | null]> = [];
  const rows: unknown[] = [];
  const deps: TeamMemberLeftDeps = {
    dataDir,
    store: { get bots() { return bots; }, messagesFor: (threadId) => messages.get(threadId) ?? [] },
    openedBy: () => ["bob-private"],
    privateTo: (threadId) => threadId === "bob-private" ? bob : null,
    revokeSessions: () => 1,
    busy: () => false,
    stop: async () => {},
    stopBot: async (botId) => { working.delete(botId); },
    deleteTasks: (_botId, threadIds) => {
      for (const threadId of threadIds) messages.delete(threadId);
      return { deleted: threadIds };
    },
    deleteBot: async (botId) => {
      if (working.has(botId)) return false;
      const index = bots.findIndex((bot) => bot.id === botId);
      for (const task of bots[index]!.tasks) messages.delete(task.threadId);
      bots.splice(index, 1);
      deletedBots.push(botId);
      return true;
    },
    threadsReferencing: (fragment) => [...messages].filter(([, list]) => JSON.stringify(list).includes(fragment)).map(([threadId]) => threadId),
    deleteAttachment: (file) => deleted.push(file),
    eraseBrowsers: async () => true,
    forgetConnections: () => {},
    routines: () => routines,
    deleteRoutine: (id) => { routines.splice(routines.findIndex((routine) => routine.id === id), 1); },
    handRoutine: (id, left, to) => { handed.push([id, left, to]); },
    forgetOnBots: () => 0,
    ownerOf: (botId) => (botId === "scout" ? "olive@acme.test" : botId === "ledger" ? BOB : null),
    record: (row) => { rows.push(row); },
  };
  const file = (n: number) => { writeFileSync(join(attachments, name(n)), "x"); return name(n); };
  return { dataDir, attachments, messages, bots, deleted, deletedBots, working, deps, file, routines, handed, rows };
}

describe("createTeamMemberLeft", () => {
  it("deletes the routines in their private chats with the files only those used, and hands the shared ones they wrote over", async () => {
    const fx = fixture();
    const own = fx.file(1), shared = fx.file(2);
    fx.routines.push(
      { id: "kumquat", name: "Kumquat", botId: "scout", home: bob, writer: undefined, files: [own] },
      { id: "standup", name: "Standup", botId: "scout", home: null, writer: bob, files: [shared] },
      { id: "tally", name: "Tally", botId: "ledger", home: null, writer: bob, files: [] },
      { id: "theirs", name: "Theirs", botId: "scout", home: null, writer: "p_someone_else_entirely", files: [] },
    );
    const result = await createTeamMemberLeft({ ...fx.deps, openedBy: () => [] })(BOB);
    expect(fx.routines.map((routine) => routine.id)).toEqual(["standup", "tally", "theirs"]);
    expect(fx.handed).toEqual([["standup", bob, personKey({ id: "", email: "olive@acme.test" })], ["tally", bob, null]]);
    expect(fx.rows).toEqual([
      { category: "bot", action: "routine.handover", target: { kind: "routine", id: "standup", name: "Standup" }, after: { owner: "olive@acme.test" } },
      { category: "bot", action: "routine.handover", target: { kind: "routine", id: "tally", name: "Tally" }, after: { owner: null } },
      { category: "people", action: "member.left", target: { kind: "person", name: BOB }, after: { botsHandedBack: 0, routinesHandedOver: 2 } },
    ]);
    expect(fx.deleted).toEqual([own]);
    expect(result).toMatchObject({ routines: 1, routinesHandedOver: 2 });
  });

  it("deletes the departing member's own MausBot with its chats, and counts them", async () => {
    const fx = fixture();
    fx.messages.set("mausbot-main", [{ role: "user", text: "LC-L2-MAIN-9081" }]);
    const result = await createTeamMemberLeft(fx.deps)(BOB);
    expect(fx.deletedBots).toEqual(["bobs-mausbot"]);
    expect(fx.bots.map((bot) => bot.id)).toEqual(["scout"]);
    expect(result).toMatchObject({ chats: 3, bots: 1 });
  });

  it("stops the departing member's MausBot at work (a routine, a room turn) before deleting it", async () => {
    const fx = fixture();
    fx.working.add("bobs-mausbot");
    const result = await createTeamMemberLeft(fx.deps)(BOB);
    expect(fx.deletedBots).toEqual(["bobs-mausbot"]);
    expect(result).toMatchObject({ bots: 1, botsKept: 0 });
  });

  it("reports a MausBot it could not delete", async () => {
    const fx = fixture();
    const result = await createTeamMemberLeft({ ...fx.deps, deleteBot: async () => false })(BOB);
    expect(result).toMatchObject({ bots: 0, botsKept: 1 });
  });

  it("deletes a sent file its chat names by its full path, and keeps one another chat still uses", async () => {
    const fx = fixture();
    const sent = fx.file(1), shared = fx.file(2);
    fx.messages.set("bob-private", [{ role: "user", text: `<attached-file path="${join(fx.attachments, sent)}" name="a.txt"/> and ${join(fx.attachments, shared)}` }]);
    fx.messages.set("scout-main", [{ role: "user", text: `<attached-file path="${join(fx.attachments, shared)}"/>` }]);
    const result = await createTeamMemberLeft(fx.deps)(BOB);
    expect(fx.deleted).toEqual([sent]);
    expect(result.files).toBe(1);
  });

  it("deletes a file the member uploaded and never sent", async () => {
    const fx = fixture();
    const unsent = fx.file(3), used = fx.file(4);
    const owners = createUploadOwners(fx.dataDir);
    owners.note(bob, unsent, bob);
    owners.note(bob, used, bob);
    fx.messages.set("scout-main", [{ role: "user", text: `![x](/api/attachments/${used})` }]);
    const result = await createTeamMemberLeft(fx.deps)(BOB);
    expect(fx.deleted).toEqual([unsent]);
    expect(result.files).toBe(1);
    expect(existsSync(join(fx.dataDir, "people", bob))).toBe(false);
  });
});
