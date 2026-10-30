import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ATTACHMENTS_DIR } from "../attachments.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createTeamPeople } from "../team-people.ts";
import { PASS } from "./table.ts";
import { createTeamOwnerRoutes, TEAM_PEOPLE_PATH } from "./team-owners.ts";

const TEAM = { id: "team-acme-1", name: "Acme" } as never;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ADA = "ada@acme.test", BOB = "bob@acme.test";

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s-bob", tokenHash: "0".repeat(64), label: "Desktop", scopes: ["client"], createdAt: 1_000, lastSeenAt: 1_000, expiresAt: 9_000,
  email: BOB, teamRole: "member", membershipAuthority: "team", ...over,
});
const asSession = (record: SessionRecord): RequestAuth => ({ kind: "session", scopes: record.scopes, session: record, via: "cookie" }) as unknown as RequestAuth;
const BOB_SESSION = asSession(session());

function world() {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  writeFileSync(join(ATTACHMENTS_DIR, "ada-1.png"), PNG);
  writeFileSync(join(ATTACHMENTS_DIR, "ada-2.png"), Buffer.concat([PNG, Buffer.from([0])]));
  const people = createTeamPeople(mkdtempSync(join(tmpdir(), "omb-team-pictures-")));
  people.seen(ADA, "owner");
  people.seen(BOB, "member");
  const profiles: Record<string, { name?: string; avatarUrl?: string; aboutMe?: string }> = {
    [ADA]: { name: "Ada Lovelace", avatarUrl: "/api/attachments/ada-1.png", aboutMe: "Ada likes tea." },
    [BOB]: { name: "Bob" },
  };
  const route = createTeamOwnerRoutes({ team: TEAM, people, store: { bots: [], bot: () => undefined, patchBot: () => undefined } as never,
    profileOf: (email) => profiles[email] ?? {}, sees: () => true, publicBot: (bot) => bot });
  const call = async (auth: RequestAuth, url: string, headers: Record<string, string> = {}) => {
    const parsed = new URL(`http://x${url}`);
    const answer: { status?: number; headers?: Record<string, string>; body?: unknown; bytes?: Buffer } = {};
    const res = {
      writeHead(status: number, sent: Record<string, string>) { answer.status = status; answer.headers = sent; },
      end(bytes?: Buffer) { answer.bytes = bytes; },
    } as unknown as ServerResponse;
    const json = ((_res: ServerResponse, status: number, body: unknown) => { answer.status = status; answer.body = body; }) as never;
    const out = await route({ req: { headers } as IncomingMessage, res, url: parsed, path: parsed.pathname, method: "GET", auth, json, readBody: (async () => ({})) as never });
    return { out, ...answer };
  };
  const listed = async (auth: RequestAuth) => ((await call(auth, TEAM_PEOPLE_PATH)).body as { people: Array<Record<string, unknown>> }).people;
  return { people, profiles, call, listed };
}

describe("teammates' pictures on a Team Cloud", () => {
  it("lists each member's picture for a member and serves its bytes to them", async () => {
    const { call, listed } = world();
    const people = await listed(BOB_SESSION);
    expect(people).toEqual([
      { email: ADA, name: "Ada Lovelace", role: "owner", pictureUrl: expect.stringMatching(new RegExp(`^/api/team/people/${personKey({ id: "", email: ADA })}/picture\\?v=[\\w-]{16}$`)) },
      { email: BOB, name: "Bob", role: "member", you: true },
    ]);
    expect(JSON.stringify(people), "never the upload's own address, nor About you").not.toMatch(/ada-1|attachments|likes tea/);
    const served = await call(BOB_SESSION, String(people[0]!.pictureUrl));
    expect(served.status).toBe(200);
    expect(served.bytes).toEqual(PNG);
    expect(served.headers).toMatchObject({ "content-type": "image/png", "cache-control": "private, no-cache", "x-content-type-options": "nosniff" });
    const again = await call(BOB_SESSION, String(people[0]!.pictureUrl), { "if-none-match": served.headers!.etag! });
    expect(again.status).toBe(304);
  });

  it("gives a changed picture a new address", async () => {
    const { listed, profiles, call } = world();
    const before = (await listed(BOB_SESSION))[0]!.pictureUrl as string;
    profiles[ADA]!.avatarUrl = "/api/attachments/ada-2.png";
    const after = (await listed(BOB_SESSION))[0]!.pictureUrl as string;
    expect(after).not.toBe(before);
    expect(after.split("?")[0]).toBe(before.split("?")[0]);
    const served = await call(BOB_SESSION, after, { "if-none-match": `"${new URLSearchParams(before.split("?")[1]).get("v")}"` });
    expect(served.status, "the old copy is not reused").toBe(200);
    expect(served.bytes?.byteLength).toBe(PNG.byteLength + 1);
    profiles[ADA]!.avatarUrl = "";
    expect((await listed(BOB_SESSION))[0]).not.toHaveProperty("pictureUrl");
    expect((await call(BOB_SESSION, after)).status).toBe(404);
  });

  it("refuses anyone who isn't a member of this team, and serves no one else's picture", async () => {
    const { call, listed, people } = world();
    const url = String((await listed(BOB_SESSION))[0]!.pictureUrl);
    const strangers: Array<[string, RequestAuth]> = [
      ["a loopback caller", { kind: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth],
      ["a session the Admin never signed", asSession(session({ membershipAuthority: undefined, teamRole: undefined, scopes: ["admin", "client"] }))],
    ];
    for (const [who, auth] of strangers) {
      const refused = await call(auth, url);
      expect(refused.status, who).toBe(403);
      expect(refused.bytes, who).toBeUndefined();
      expect((await listed(auth)).some((person) => "pictureUrl" in person), who).toBe(false);
    }
    expect((await call(BOB_SESSION, `${TEAM_PEOPLE_PATH}/${personKey({ id: "", email: "cleo@else.test" })}/picture`)).status, "not a member here").toBe(404);
    people.left(ADA);
    expect((await call(BOB_SESSION, url)).status, "a member who left").toBe(404);
  });

  it("is nothing off a team", async () => {
    const route = createTeamOwnerRoutes({ team: null, people: null, store: {} as never, sees: () => true, publicBot: (bot) => bot });
    const answers: number[] = [];
    const path = `${TEAM_PEOPLE_PATH}/${personKey({ id: "", email: ADA })}/picture`;
    await route({ req: { headers: {} } as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://x${path}`), path, method: "GET", auth: BOB_SESSION,
      json: ((_res: ServerResponse, status: number) => { answers.push(status); }) as never, readBody: (async () => ({})) as never });
    expect(answers).toEqual([404]);
    expect(await route({ req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL("http://x/api/team/people/x/picture"), path: "/api/team/people/x/picture", method: "GET",
      auth: BOB_SESSION, json: (() => {}) as never, readBody: (async () => ({})) as never })).toBe(PASS);
  });
});
