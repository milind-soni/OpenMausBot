import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AWAY_DAILY_MAX, AWAY_EMAILS_FILE, AWAY_EMAILS_PATH, AWAY_GAP_MS, AWAY_WINDOW_MS, awayKey, createTeamAway, TEAM_AWAY_ADMIN_PATH, teamAwaySignature, type AwayRequest, type TeamAway } from "./team-away.ts";
import { json } from "../harness/http.ts";
import { personKey } from "../person-key.ts";
import { PASS } from "../routes/table.ts";

const MAYA = "maya@example.com", BEN = "ben@example.com";
const maya = personKey({ id: "", email: MAYA });
const SECRET = "s".repeat(43), MACHINE = "cm-team-home";

const dirs: string[] = [], aways: TeamAway[] = [];
afterEach(() => { for (const away of aways.splice(0)) away.stop(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Answer = (request: AwayRequest) => Response | Promise<Response>;
const ok: Answer = (request) => Response.json({ v: 1, results: request.notices.map(({ id }) => ({ id, state: "sent" })) });

function world(options: { answer?: Answer; here?: Set<string>; members?: string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-team-away-"));
  dirs.push(dataDir);
  let clock = Date.UTC(2026, 10, 10, 9, 0, 0);
  const here = options.here ?? new Set<string>();
  const members = new Map((options.members ?? [MAYA, BEN]).map((email) => [personKey({ id: "", email }), { email }]));
  const timers: { run: () => void; at: number; unref(): void }[] = [];
  const requests: { body: AwayRequest; headers: Record<string, string>; url: string; raw: string }[] = [];
  const away = createTeamAway({
    here: (person) => here.has(person), member: (person) => members.get(person), language: (person) => (person === maya ? "de" : undefined),
    dataDir, adminOrigin: "https://cloud.example.test", machineId: MACHINE, secret: SECRET, now: () => clock,
    setTimer: (run, ms) => { const timer = { run, at: clock + ms, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer as never); if (index >= 0) timers.splice(index, 1); },
    fetchImpl: (async (url: string, init: RequestInit) => {
      const raw = String(init.body), body = JSON.parse(raw) as AwayRequest;
      requests.push({ body, headers: init.headers as Record<string, string>, url, raw });
      return (options.answer ?? ok)(body);
    }) as typeof fetch,
  });
  aways.push(away);
  /** Moves the clock and runs every timer that falls due, in order. */
  const advance = async (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      clock = Math.max(clock, next.at);
      next.run();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    clock = until;
  };
  const notices = () => requests.flatMap((request) => request.body.notices);
  return { away, dataDir, here, members, requests, notices, advance, setClock: (at: number) => { clock = at; }, clock: () => clock };
}

const mention = (person = maya, about = "inbox:line-1") => ({ person, about, item: { kind: "mention" as const, who: "Ben", place: "Sales" } });

describe("the away email a Team Cloud asks the Admin for", () => {
  it("sends exactly the names and a hash, signed, after the window", async () => {
    const { away, advance, requests, clock } = world();
    away.noticed(mention());
    await advance(AWAY_WINDOW_MS - 1);
    expect(requests).toHaveLength(0);
    await advance(1);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe(`https://cloud.example.test${TEAM_AWAY_ADMIN_PATH}`);
    expect(request!.body).toEqual({
      v: 1,
      notices: [{ id: expect.stringMatching(/^n_[\w-]{22}$/), to: MAYA, language: "de", items: [{ kind: "mention", key: awayKey("inbox:line-1"), who: "Ben", place: "Sales" }] }],
    });
    expect(Object.keys(request!.body.notices[0]!).sort()).toEqual(["id", "items", "language", "to"]);
    expect(awayKey("inbox:line-1")).toMatch(/^[0-9a-f]{64}$/);
    const headers = request!.headers;
    expect(headers["x-omb-cloud-machine"]).toBe(MACHINE);
    expect(headers["x-omb-cloud-timestamp"]).toBe(String(Math.floor(clock() / 1000)));
    expect(headers["x-omb-cloud-signature"]).toBe(`v1=${teamAwaySignature(SECRET, MACHINE, headers["x-omb-cloud-timestamp"]!, headers["x-omb-cloud-nonce"]!, request!.raw)}`);
  });

  it("signs the way the Admin checks (a fixed vector both repositories test)", () => {
    expect(teamAwaySignature("secret-of-the-home", "cm-acme", "1762765200", "nonce-0123456789abcdef", '{"v":1,"notices":[]}'))
      .toBe("wXx8Ty3f-Z1Ag0DrNs80GxPT4KwAZ6RoIzrRF139vAI");
  });

  it("puts what happens within the window in one email, the question first", async () => {
    const { away, advance, notices } = world();
    away.noticed(mention());
    await advance(60_000);
    away.noticed({ person: maya, about: "ask:t1:r1", item: { kind: "waiting", who: "Sales" } });
    await advance(60_000);
    away.noticed({ person: maya, about: "done:t2:l1", conversation: "t2", item: { kind: "finished", who: "Scout", place: "Q3 launch" } });
    await advance(AWAY_WINDOW_MS);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.items.map((item) => item.kind)).toEqual(["waiting", "mention", "finished"]);
  });

  it("leaves finished work out when a question or a mention from that conversation is already in the email", async () => {
    const { away, advance, notices } = world();
    away.noticed({ person: maya, about: "ask:t1:r1", thread: "t1", item: { kind: "waiting", who: "Scout" } });
    away.noticed({ person: maya, about: "done:t1:l1", conversation: "t1", item: { kind: "finished", who: "Scout" } });
    away.noticed({ person: maya, about: "done:t2:l1", conversation: "t2", item: { kind: "finished", who: "Sales" } });
    await advance(AWAY_WINDOW_MS);
    expect(notices()[0]!.items.map((item) => [item.kind, item.who])).toEqual([["waiting", "Scout"], ["finished", "Sales"]]);
  });

  it("keeps a question that arrived late in the window for the next email", async () => {
    const { away, advance, notices } = world();
    away.noticed(mention());
    await advance(AWAY_WINDOW_MS - 60_000);
    away.noticed({ person: maya, about: "ask:t1:r1", item: { kind: "waiting", private: true } });
    await advance(60_000);
    expect(notices().map((notice) => notice.items.map((item) => item.kind))).toEqual([["mention"]]);
    await advance(AWAY_GAP_MS);
    expect(notices().map((notice) => notice.items.map((item) => item.kind))).toEqual([["mention"], ["waiting"]]);
  });

  it("sends nothing to someone who is here, or who came back before it went", async () => {
    const { away, advance, here, requests } = world();
    here.add(maya);
    away.noticed(mention());
    expect(away.pendingFor(maya)).toEqual([]);
    here.delete(maya);
    away.noticed(mention(maya, "inbox:line-2"));
    here.add(maya);
    await advance(AWAY_WINDOW_MS);
    expect(requests).toHaveLength(0);
  });

  it("drops what was answered or seen before it went", async () => {
    const { away, advance, notices } = world();
    let open = true;
    away.noticed({ ...mention(), still: () => open });
    away.noticed({ person: maya, about: "ask:t1:r1", item: { kind: "waiting", private: true }, still: () => true });
    open = false;
    await advance(AWAY_WINDOW_MS);
    expect(notices()[0]!.items.map((item) => item.kind)).toEqual(["waiting"]);
  });

  it("never asks about the same thing twice", async () => {
    const { away, advance, notices } = world();
    away.noticed(mention());
    away.noticed(mention());
    await advance(AWAY_WINDOW_MS);
    away.noticed(mention());
    await advance(AWAY_GAP_MS + AWAY_WINDOW_MS);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.items).toHaveLength(1);
  });

  it("tells of finished work once per conversation for a stretch away, and again after they came back", async () => {
    const { away, advance, notices, here } = world();
    const done = (line: string) => ({ person: maya, about: `done:t1:${line}`, conversation: "t1", item: { kind: "finished" as const, who: "Scout" } });
    away.noticed(done("l1"));
    away.noticed(done("l2"));
    await advance(AWAY_WINDOW_MS);
    away.noticed(done("l3"));
    await advance(AWAY_GAP_MS + AWAY_WINDOW_MS);
    expect(notices()).toHaveLength(1);
    here.add(maya);
    away.noticed(done("l4"));
    here.delete(maya);
    away.noticed(done("l5"));
    await advance(AWAY_WINDOW_MS);
    expect(notices()).toHaveLength(2);
  });

  it("waits the gap between two emails and stops at the daily cap", async () => {
    const { away, advance, notices } = world();
    for (let index = 0; index < AWAY_DAILY_MAX + 2; index++) {
      away.noticed(mention(maya, `inbox:line-${index}`));
      await advance(AWAY_GAP_MS + AWAY_WINDOW_MS);
    }
    expect(notices()).toHaveLength(AWAY_DAILY_MAX);
  });

  it("asks nothing for someone who left or was never in", async () => {
    const { away, advance, requests } = world({ members: [BEN] });
    away.noticed(mention(maya));
    await advance(AWAY_WINDOW_MS);
    expect(requests).toHaveLength(0);
  });

  it("tries a failed send again as the same email, and drops it when an older Admin doesn't know the route", async () => {
    let calls = 0;
    const { away, advance, notices } = world({ answer: (request) => (++calls === 1 ? new Response("down", { status: 503 }) : ok(request)) });
    away.noticed(mention());
    await advance(AWAY_WINDOW_MS + 60_000);
    expect(notices()).toHaveLength(2);
    expect(notices()[1]!.id).toBe(notices()[0]!.id);

    const older = world({ answer: () => Response.json({ error: "Not found." }, { status: 404 }) });
    older.away.noticed(mention());
    await older.advance(AWAY_WINDOW_MS);
    older.away.noticed(mention(maya, "inbox:line-9"));
    await older.advance(AWAY_GAP_MS + AWAY_WINDOW_MS);
    expect(older.requests).toHaveLength(1);
  });
});

describe("the person's own switch", () => {
  const session = (email: string) => ({ id: "s1", email }) as never;
  async function call(away: TeamAway, method: string, email: string | null, body?: unknown) {
    const answer: { status?: number; body?: unknown } = {};
    const res = { setHeader() {}, writeHead(status: number) { answer.status = status; }, end(text: string) { answer.body = JSON.parse(text); }, headersSent: false } as never;
    const route = away.routes(() => (email ? session(email) : null));
    const out = await route({ req: {} as never, res, url: new URL(`http://x${AWAY_EMAILS_PATH}`), path: AWAY_EMAILS_PATH, method, auth: {} as never, json, readBody: (async () => body) as never });
    return out === PASS ? null : answer;
  }

  it("is on by default; off stops every email and reaches the Admin", async () => {
    const { away, advance, requests, dataDir } = world();
    expect(await call(away, "GET", MAYA)).toEqual({ status: 200, body: { on: true } });
    expect(await call(away, "PUT", MAYA, { on: false })).toEqual({ status: 200, body: { on: false } });
    away.noticed(mention());
    await advance(AWAY_WINDOW_MS);
    const synced = requests.filter((request) => request.body.prefs);
    expect(synced.map((request) => request.body)).toEqual([{ v: 1, notices: [], prefs: [{ to: MAYA, on: false }] }]);
    expect(requests.flatMap((request) => request.body.notices)).toEqual([]);
    expect(JSON.parse(readFileSync(join(dataDir, "people", maya, AWAY_EMAILS_FILE), "utf8"))).toEqual({ version: 1, on: false, synced: true });
    expect(await call(away, "PUT", MAYA, { on: true })).toEqual({ status: 200, body: { on: true } });
    await advance(5_000);
    expect(existsSync(join(dataDir, "people", maya, AWAY_EMAILS_FILE))).toBe(false);
  });

  it("follows a stop link: the Admin's off turns the switch off here", async () => {
    const { away, advance } = world({ answer: (request) => Response.json({ v: 1, results: request.notices.map(({ id }) => ({ id, state: "off" })), off: [MAYA] }) });
    away.noticed(mention());
    await advance(AWAY_WINDOW_MS);
    expect(await call(away, "GET", MAYA)).toEqual({ status: 200, body: { on: false } });
    expect(await call(away, "GET", BEN)).toEqual({ status: 200, body: { on: true } });
  });

  it("is refused without a team sign-in, and takes only true or false", async () => {
    const { away } = world();
    expect((await call(away, "GET", null))?.status).toBe(403);
    expect((await call(away, "PUT", MAYA, { on: "no" }))?.status).toBe(400);
  });
});
