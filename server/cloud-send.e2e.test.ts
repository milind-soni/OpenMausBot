// The move's transport, end to end: two real servers (this computer's and a Cloud home) with main's own wiring between them
// (scripts/testing/cloud-send-fixture.ts). Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CloudSendNotice } from "../electron/cloud-send.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

// Obvious fakes only.
const TOKEN = `ops_fake-send-${randomBytes(12).toString("hex")}`;
const PASSWORD = `fake-send-Passw0rd-${randomBytes(6).toString("hex")}`;
const DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
let fx: CloudSendFixture;

beforeAll(async () => { fx = await launchCloudSendFixture({ onePasswordToken: TOKEN }); }, hostTimeout(60_000));
afterAll(async () => { await fx?.close(); });

it("when My Cloud refuses this computer's 1Password token, the move says what failed and why, in words for this computer, and everything else arrives", async () => {
  const refusing = await launchCloudSendFixture({ onePasswordToken: TOKEN, cloudOnePasswordToken: `ops_fake-other-${randomBytes(8).toString("hex")}` });
  try {
    const { local, onCloud } = refusing;
    const ember = (await local("POST", "/api/bots", { name: "Ember", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
    await local("PATCH", `/api/bots/${ember.id}`, { soul: "You are Ember." });
    expect((await local("POST", "/api/logins", { site: "accounts.example.test", username: "alice", password: PASSWORD, bots: [ember.id] })).status).toBe(201);
    expect((await local("POST", "/api/logins/1password", { token: TOKEN })).status).toBe(200);
    await refusing.move();
    const notice = await refusing.call<CloudSendNotice>("cloud-send:notice", "cloud");
    const why = "My Cloud's 1Password did not accept this computer's token: it may have been revoked, expired, or lost access to its vault. Connect 1Password again in this computer's Settings → Logins, and it goes to My Cloud by itself.";
    expect(notice.last).toMatchObject({ failed: 1, reasons: [{ what: { bots: [], skills: 0, logins: 0, onePassword: true, settings: 0, chats: false }, error: why }] });
    expect(notice.last?.error).toBeUndefined();
    expect(JSON.stringify(notice)).not.toContain("example.test");
    // Everything else arrived, the login included.
    expect((await onCloud("GET", "/api/logins")).body.logins).toEqual([expect.objectContaining({ site: "example.test", username: "alice", bots: [ember.id] })]);
    expect((await onCloud("GET", "/api/logins")).body.onePassword).toEqual({ connected: false });
    for (const where of [...refusing.answers, refusing.logs()]) for (const value of [TOKEN, PASSWORD]) expect(where).not.toContain(value);
  } finally { await refusing.close(); }
}, hostTimeout(120_000));

it("My Cloud keeps an attachment a sent row names under its own name, once, and says which it lacks", async () => {
  const name = `${randomBytes(8).toString("hex")}.png`;
  const post = (body: Uint8Array) => fetch(`${fx.cloudBase}/api/cloud-send/chats/attachment/${name}`, { method: "POST", body,
    headers: { ...fx.edge, authorization: `Bearer ${fx.owner}`, "content-type": "application/octet-stream" } });
  expect((await fx.onCloud("POST", "/api/cloud-send/chats/attachments", { names: [name, "../escape.png"] })).body).toEqual({ missing: [name] });
  expect((await post(DOT)).status).toBe(201);
  expect((await post(Buffer.from("something else"))).status, "one already here is the same upload").toBe(200);
  expect((await fx.onCloud("POST", "/api/cloud-send/chats/attachments", { names: [name] })).body).toEqual({ missing: [] });
  expect(Buffer.from(await (await fetch(`${fx.cloudBase}/api/attachments/${name}`, { headers: { ...fx.edge, authorization: `Bearer ${fx.owner}` } })).arrayBuffer())).toEqual(DOT);
  expect((await fetch(`${fx.cloudBase}/api/cloud-send/chats/attachment/..%2Fescape.png`, { method: "POST", body: DOT, headers: { ...fx.edge, authorization: `Bearer ${fx.owner}` } })).status).toBe(404);
});

/** A conversation as a server holds it: every row, paged back with `before` as the chat view pages, and the path from
 * the server's own leaf, which is what its bot reads. */
async function history(side: CloudSendFixture["local"], threadId: string) {
  const rows: Array<{ id: string; parentId?: string | null; kind: string }> = [];
  let leaf: string | null = null;
  for (let before: string | null = null, more = true; more;) {
    const page: { messages: typeof rows; activeLeafId: string | null; hasMore?: boolean } = (await side("GET", `/api/threads/${threadId}/messages?limit=500${before ? `&before=${before}` : ""}`)).body;
    rows.unshift(...page.messages);
    leaf = page.activeLeafId;
    more = page.hasMore === true;
    before = page.messages[0]?.id ?? null;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: string[] = [];
  for (let row = leaf ? byId.get(leaf) : undefined; row; row = row.parentId ? byId.get(row.parentId) : undefined) path.unshift(row.id);
  return { stored: rows.length, leaf, path, summaries: rows.filter((row) => row.kind === "compaction").length };
}

describe("a long conversation, carried in pages by the move", () => {
  let heavy: CloudSendFixture;
  beforeAll(async () => { heavy = await launchCloudSendFixture({ onePasswordToken: TOKEN, toolCalls: 150 }); }, hostTimeout(60_000));
  afterAll(async () => { await heavy?.close(); });
  const turn = async (bot: { id: string; threadId: string }, text: string) => {
    const before = (await history(heavy.local, bot.threadId)).stored;
    expect((await heavy.local("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
    for (let tries = 0; tries < 600; tries++) {
      const idle = (await heavy.local("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
      if (idle && (await history(heavy.local, bot.threadId)).stored > before + 2) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const newBot = async (name: string) => (await heavy.local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
  const sendAll = () => heavy.move();
  const sameOnBoth = async (bot: { threadId: string }) => {
    const [here, there] = [await history(heavy.local, bot.threadId), await history(heavy.onCloud, bot.threadId)];
    expect({ path: there.path.length, leaf: there.leaf, summaries: there.summaries }).toEqual({ path: here.path.length, leaf: here.leaf, summaries: here.summaries });
    expect(there.path).toEqual(here.path);
    return here;
  };

  it("a new bot's conversation of three pages and more arrives whole with the move", async () => {
    const archie = await newBot("Archie");
    for (let i = 0; i < 5; i++) await turn(archie, `Step ${i}: check the next server.`);
    expect((await history(heavy.local, archie.threadId)).stored).toBeGreaterThan(2 * 300);
    const first = await heavy.move();
    expect([first.reason, first.result.failed]).toEqual(["move", []]);
    expect(heavy.chatRequests.flat().filter((entry) => entry.threadId === archie.threadId).length).toBeGreaterThanOrEqual(3);
    await sameOnBoth(archie);
  }, hostTimeout(240_000));

  it("a later pass of two pages and more goes on from the earlier one", async () => {
    const bea = await newBot("Bea");
    await turn(bea, "First look.");
    expect((await sendAll()).result.failed).toEqual([]);
    await sameOnBoth(bea);
    const sent = heavy.chatRequests.length;
    for (let i = 0; i < 2; i++) await turn(bea, `Step ${i}: go on.`);
    expect((await sendAll()).result.failed).toEqual([]);
    expect(heavy.chatRequests.slice(sent).flat().filter((entry) => entry.threadId === bea.threadId).length).toBeGreaterThanOrEqual(2);
    await sameOnBoth(bea);
  }, hostTimeout(240_000));

  it("a room goes with its chats: My Cloud makes it under the same ids, and a thread of three pages and more arrives whole", async () => {
    // Ro has nothing but its greeting: a bot in a room still goes, since the room's chats need it.
    const ro = await newBot("Ro");
    const room = (await heavy.local("POST", "/api/groups", { name: "Launch", memberIds: [ro.id], setup: { bulletin: "Ship on Friday.", defaultResponder: { kind: "mentions" } } })).body.group as { id: string; threadId: string };
    for (let i = 0; i < 2 * 300 + 10; i++) {
      expect((await heavy.local("POST", `/api/groups/${room.id}/messages`, { text: `Note ${i} for the launch.`, threadId: room.threadId })).status).toBeLessThan(300);
    }
    expect((await history(heavy.local, room.threadId)).stored).toBeGreaterThan(2 * 300);
    expect((await sendAll()).result.failed).toEqual([]);
    expect((await heavy.onCloud("GET", "/api/bots?messages=0")).body.groups.find((entry: { id: string }) => entry.id === room.id))
      .toMatchObject({ id: room.id, threadId: room.threadId, name: "Launch", memberIds: [ro.id], bulletin: "Ship on Friday." });
    await sameOnBoth(room);
  }, hostTimeout(240_000));

  it("a context summary that ends a pass reaches My Cloud, and what follows it in the next pass shows after it", async () => {
    const cleo = await newBot("Cleo");
    await turn(cleo, "Read the report.");
    expect((await sendAll()).result.failed).toEqual([]);
    expect((await heavy.local("POST", `/api/bots/${cleo.id}/compact`, { threadId: cleo.threadId })).status).toBe(202);
    for (let tries = 0; (await history(heavy.local, cleo.threadId)).summaries < 1 && tries < 300; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
    const summarized = await history(heavy.local, cleo.threadId);
    expect(summarized.summaries).toBe(1);
    expect(summarized.path.at(-1)).toBe(summarized.leaf);
    expect((await sendAll()).result.failed).toEqual([]);
    await turn(cleo, "Now the next one.");
    expect((await sendAll()).result.failed).toEqual([]);
    expect((await sameOnBoth(cleo)).summaries).toBe(1);
  }, hostTimeout(240_000));
});
