// A real Team Cloud with three people: a teammate's name and picture are visible to everyone in the team, served to its
// signed-in members only, and About you stays each person's own.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ADA = { email: "ada@acme.test", role: "owner" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0])]);
const PICTURE_URL = /^\/api\/team\/people\/p_[\w-]{22}\/picture\?v=[\w-]{16}$/;

let fx: CloudSendFixture, team: CloudTeamFixture;
let ada = "", bob = "", cleo = "";

type Person = { email: string; name: string; role: string; you?: true; pictureUrl?: string };
const people = async (token: string) => {
  const listed = await team.as(token, "GET", "/api/team/people");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.people as Person[];
};
const personOf = async (token: string, email: string) => (await people(token)).find((person) => person.email === email);
const upload = async (token: string, bytes: Buffer) => {
  const saved = await team.as(token, "POST", "/api/attachments", new Uint8Array(bytes), { "content-type": "image/png" });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  return `/api/attachments/${String(saved.body.path).replaceAll("\\", "/").split("/").pop()}`;
};
const picture = (url: string, token?: string) =>
  fetch(`${team.base}${url}`, { headers: { ...fx.edge, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-pictures-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
  team = fx.team!;
  ada = (await team.pair(ADA)).token!;
  bob = (await team.pair(BOB)).token!;
  cleo = (await team.pair(CLEO)).token!;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
}, hostTimeout(60_000));

it("shows every member a teammate's picture, served to the team's members only", async () => {
  const avatarUrl = await upload(ada, PNG);
  expect((await team.as(ada, "PUT", "/api/me", { name: "Ada Lovelace", avatarUrl, aboutMe: "Ada likes tea." })).status).toBe(200);

  const listed = await people(bob);
  const adas = listed.find((person) => person.email === ADA.email)!;
  expect(adas).toMatchObject({ name: "Ada Lovelace", role: "owner", pictureUrl: expect.stringMatching(PICTURE_URL) });
  expect(listed.find((person) => person.email === BOB.email), "no picture: the app shows his initial").not.toHaveProperty("pictureUrl");
  expect(JSON.stringify(listed), "never the upload's own address, nor About you").not.toContain(avatarUrl);
  expect(JSON.stringify(listed)).not.toContain("likes tea");

  for (const [who, token] of [["Bob, a User", bob], ["Cleo, a User", cleo], ["Ada herself", ada]] as const) {
    const served = await picture(adas.pictureUrl!, token);
    expect(served.status, who).toBe(200);
    expect(served.headers.get("content-type"), who).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()), who).toEqual(PNG);
  }
  for (const [who, token] of [["signed out", undefined], ["a made-up token", "omb_not-a-session"]] as const) {
    const refused = await picture(adas.pictureUrl!, token);
    expect(refused.status, who).toBe(403);
    expect(refused.headers.get("content-type"), who).not.toBe("image/png");
  }
  // Off the team: My Cloud has no team, so no member's picture, whatever its owner's session may do.
  expect((await fx.onCloud("GET", adas.pictureUrl!)).status).toBe(404);
  expect((await fx.onCloud("GET", "/api/team/people")).status).toBe(400);
}, hostTimeout(60_000));

it("gives a changed picture a new address, and drops it when it is removed", async () => {
  const before = (await personOf(bob, ADA.email))!.pictureUrl!;
  expect((await team.as(ada, "PUT", "/api/me", { avatarUrl: await upload(ada, OTHER_PNG) })).status).toBe(200);
  const after = (await personOf(bob, ADA.email))!.pictureUrl!;
  expect(after).toMatch(PICTURE_URL);
  expect(after).not.toBe(before);
  const served = await picture(after, bob);
  expect(Buffer.from(await served.arrayBuffer())).toEqual(OTHER_PNG);
  expect((await team.as(ada, "PUT", "/api/me", { avatarUrl: "" })).status).toBe(200);
  expect(await personOf(bob, ADA.email)).not.toHaveProperty("pictureUrl");
  expect((await picture(after, bob)).status).toBe(404);
}, hostTimeout(60_000));

it("keeps About you private, and serves nothing of a member who left", async () => {
  expect((await team.as(cleo, "PUT", "/api/me", { name: "Cleo", avatarUrl: await upload(cleo, PNG), aboutMe: "Cleo is moving to Lisbon." })).status).toBe(200);
  const cleos = (await personOf(bob, CLEO.email))!.pictureUrl!;
  expect((await picture(cleos, bob)).status).toBe(200);
  for (const route of ["/api/me", "/api/config", "/api/team/people"]) {
    const seen = JSON.stringify((await team.as(bob, "GET", route)).body);
    expect(seen, route).not.toContain("Lisbon");
    expect(seen, route).not.toContain("likes tea");
  }
  expect((await team.as(cleo, "GET", "/api/me")).body.aboutMe).toBe("Cleo is moving to Lisbon.");

  expect((await team.signed("POST", "/api/cloud/team/member-left", { email: CLEO.email })).status).toBe(200);
  expect((await picture(cleos, cleo)).status, "her own session ended").toBe(401);
  expect((await picture(cleos, bob)).status, "nobody's to see any more").toBe(404);
  expect(await personOf(bob, CLEO.email)).toBeUndefined();
}, hostTimeout(60_000));
