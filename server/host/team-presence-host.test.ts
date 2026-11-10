import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Audience } from "../audience.ts";
import type { Viewer } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createTeamPeople } from "../team-people.ts";
import type { PresenceClock } from "../team-presence.ts";
import { createTeamPresenceHost, type PresenceStream } from "./team-presence-host.ts";

const ADA = "ada@acme.test", BEN = "ben@acme.test";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Timers run when the test says, not on their own. */
function manualClock() {
  let now = 1_000;
  const timers: Array<{ at: number; run: () => void; done: boolean }> = [];
  const clock: PresenceClock = { now: () => now, later: (run, ms) => { const timer = { at: now + ms, run, done: false }; timers.push(timer); return { cancel: () => { timer.done = true; } }; } };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) if (!timer.done && timer.at <= now) { timer.done = true; timer.run(); }
  };
  return { clock, advance };
}

const session = (email: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({ id: `s-${email}`, tokenHash: "x".repeat(64), label: "", scopes: ["client"], createdAt: 0, lastSeenAt: 0, expiresAt: Infinity,
  email, membershipAuthority: "team", teamRole: "member", ...extra });

/** A team with a bot's shared chat, Ada's private chat with it, Ada's own MausBot, a group chat with it and one Ben may
 * not read. */
function setup(team = true) {
  const dir = mkdtempSync(join(tmpdir(), "omb-presence-"));
  dirs.push(dir);
  const people = team ? createTeamPeople(dir) : null;
  people?.seen(ADA, "member");
  people?.seen(BEN, "admin");
  const audiences: Record<string, Audience> = { shared: "team", "ada-private": "member:p_ada", "ada-own": "team", room: "room:g1", "room-own": "room:g2", hidden: "team" };
  const bots: Record<string, { defaultBot?: { person?: string } }> = { scout: {}, mausbot: { defaultBot: { person: ADA } } };
  const threadBots: Record<string, string> = { shared: "scout", "ada-private": "scout", "ada-own": "mausbot", hidden: "scout" };
  const groups: Record<string, { memberIds: string[] }> = { room: { memberIds: ["scout"] }, "room-own": { memberIds: ["scout", "mausbot"] } };
  const sent: Array<{ to: string; frame: Record<string, unknown> }> = [];
  /** An open event stream whose writes land in `sent`. */
  const stream = (name: string, person?: SessionRecord): PresenceStream & { name: string } => ({ name, person, backpressured: false, close: () => {},
    res: { writableLength: 0, once: () => {}, write: (frame: string) => { sent.push({ to: name, frame: JSON.parse(frame.replace(/^data: /, "")) as Record<string, unknown> }); return true; } } });
  const streams = [stream(ADA, session(ADA)), stream(BEN, session(BEN, { teamRole: "admin", scopes: ["admin", "client"] })),
    stream("move-in", session("mover@acme.test", { moveIn: "b1" })), stream("server")];
  const broadcasts: Array<Record<string, unknown>> = [];
  const { clock, advance } = manualClock();
  const host = createTeamPresenceHost<PresenceStream & { name: string }>({
    people,
    broadcast: (payload) => broadcasts.push(payload),
    audienceOf: (threadId) => audiences[threadId] ?? "team",
    store: () => ({ botByThread: (threadId: string) => (threadBots[threadId] ? bots[threadBots[threadId]!] : null), groupByThread: (threadId: string) => groups[threadId], bot: (id: string) => bots[id] ?? null }) as never,
    // Ben (an admin) sees every bot but not "hidden"'s chat in this test; everyone sees their own.
    visibleTo: (viewer: Viewer) => ({ thread: (threadId: string) => !(threadId === "hidden" && viewer.email === BEN) }),
    clock,
  });
  const post = async (email: string | null, body: unknown, extra: Partial<SessionRecord> = {}) => {
    const answers: Array<[number, unknown]> = [];
    const auth: RequestAuth = email ? { kind: "session", session: session(email, extra), via: "bearer", scopes: ["client"] } as RequestAuth : { kind: "loopback", scopes: ["admin", "client"] };
    await host.routes({ req: {} as never, res: {} as never, url: new URL("http://x/api/presence/here"), path: "/api/presence/here", method: "POST", auth,
      json: ((_res: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never, readBody: (async () => body) as never });
    return answers[0];
  };
  return { host, people, streams, sent, broadcasts, post, advance };
}

describe("the presence host", () => {
  it("counts team sessions' streams only, and tells every team stream", () => {
    const { host, streams, sent } = setup();
    for (const one of streams) host.streams.add(one);
    const arrivals = sent.filter((one) => one.frame.kind === "team.presence");
    // Each arrival reaches the team streams open by then: Ada's only her own, Ben's both.
    expect(arrivals.map((one) => [one.frame.email, one.to])).toEqual([[ADA, ADA], [BEN, ADA], [BEN, BEN]]);
    expect(host.of!(ADA)).toEqual({ here: true });
    expect(host.of!("mover@acme.test")).toMatchObject({ here: false });
    expect([...host.streams].map((one) => one.name)).toEqual([ADA, BEN, "move-in", "server"]);
  });

  it("starts a person's grace when their stream leaves the set, once", () => {
    const { host, streams, advance } = setup();
    host.streams.add(streams[0]!);
    expect(host.streams.delete(streams[0]!)).toBe(true);
    expect(host.streams.delete(streams[0]!)).toBe(false);
    host.streams.add(streams[0]!);
    advance(60_000);
    expect(host.of!(ADA).here, "the second delete did not count").toBe(true);
    host.streams.delete(streams[0]!);
    advance(60_000);
    expect(host.of!(ADA).here).toBe(false);
  });

  it("shows a person only in a conversation more than one person reads, and only to those who read it", async () => {
    const { host, streams, sent, post, advance } = setup();
    for (const one of streams) host.streams.add(one);
    sent.length = 0;
    for (const threadId of ["ada-private", "ada-own", "room-own", "hidden"]) {
      expect(await post(ADA, { tab: "t1", threadId })).toEqual([200, { ok: true }]);
      expect(await post(BEN, { tab: "t1", threadId })).toEqual([200, { ok: true }]);
      advance(1_000);
    }
    expect(sent.filter((one) => one.frame.kind === "thread.presence").map((one) => [one.to, one.frame.threadId, one.frame.people])).toEqual([[ADA, "hidden", [ADA]]]);
    sent.length = 0;
    await post(ADA, { tab: "t1", threadId: "shared" });
    await post(BEN, { tab: "t1", threadId: "shared" });
    advance(1_000);
    expect(sent.map((one) => [one.to, one.frame])).toEqual([
      [ADA, { kind: "thread.presence", threadId: "shared", people: [ADA, BEN] }],
      [BEN, { kind: "thread.presence", threadId: "shared", people: [ADA, BEN] }],
    ]);
    await post(ADA, { tab: "t1", threadId: "room" });
    advance(1_000);
    expect(sent.filter((one) => one.frame.threadId === "room").map((one) => one.to)).toEqual([ADA]);
    expect(JSON.stringify(sent)).not.toMatch(/ada-private|ada-own|room-own/);
  });

  it("refuses a request without a tab, and counts nothing for the server or a move-in sign-in", async () => {
    const { host, post } = setup();
    expect((await post(ADA, { threadId: "shared" }))?.[0]).toBe(400);
    expect(await post(null, { tab: "t1", threadId: "shared" })).toEqual([200, { ok: true }]);
    expect(await post("mover@acme.test", { tab: "t1", threadId: "shared" }, { moveIn: "b1" })).toEqual([200, { ok: true }]);
    expect(host.of!("mover@acme.test").here).toBe(false);
  });

  it("does nothing off a team", async () => {
    const { host, streams, sent, post } = setup(false);
    for (const one of streams) host.streams.add(one);
    expect(sent).toEqual([]);
    expect(host.of).toBeUndefined();
    expect((await post(ADA, { tab: "t1", threadId: "shared" }))?.[0]).toBe(404);
  });

  it("tells every app when someone joins, changes role or leaves, once, and forgets who left", () => {
    const { host, people, broadcasts, streams, advance } = setup();
    host.streams.add(streams[0]!);
    expect(host.of!(ADA).here).toBe(true);
    people!.seen("cy@acme.test", "member");
    people!.seen(ADA, "admin");
    people!.left(ADA);
    expect(host.of!(ADA).here).toBe(false);
    expect(broadcasts).toEqual([]);
    advance(1_000);
    expect(broadcasts).toEqual([{ kind: "team.people" }]);
    people!.seen(BEN, "admin");
    advance(1_000);
    expect(broadcasts).toHaveLength(1);
  });
});
