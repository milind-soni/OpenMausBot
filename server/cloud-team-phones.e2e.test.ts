// A real Team Cloud (OMB_CLOUD_ROLE=team): the phones its members paired with "Open on your phone" are listed beside the
// code, each as its device and its member. A member sees and removes their own; the team's admins see and remove every
// member's. Removing a phone ends its session, its open stream too. Nothing here runs a turn.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const MEMBER_A = { email: "ada@acme.test", role: "member" as const };
const MEMBER_C = { email: "cleo@acme.test", role: "member" as const };

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", ada = "", cleo = "";
const phones: Record<"ada" | "cleo" | "ben", { token: string; id: string }> = {} as never;

type Listed = { id: string; label: string; email: string; lastSeenAt: number; expiresAt: number };
const listed = async (token: string) => {
  const answer = await team.as(token, "GET", "/api/team/phones");
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return { rows: (answer.body.phones as Listed[]).map((phone) => `${phone.label} · ${phone.email}`), phones: answer.body.phones as Listed[], current: answer.body.current as string | null };
};

/** What the phone app does with the code's link: redeems it at /api/auth/pair under its own name (Session.pair). */
async function pairPhone(made: { code: string }, label: string): Promise<{ token: string; id: string }> {
  const redeemed = await fetch(`${team.base}/api/auth/pair`, { method: "POST", headers: { ...fx.edge, "content-type": "application/json" }, body: JSON.stringify({ code: made.code, label }) });
  expect(redeemed.status).toBe(200);
  const token = (await redeemed.json() as { token: string }).token;
  const session = await team.as(token, "GET", "/api/auth/session");
  return { token, id: session.body.id as string };
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-phones-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(MEMBER_A)).token!;
  cleo = (await team.pair(MEMBER_C)).token!;
  const code = async (token: string, path = "/api/team/phone-pairing") => {
    const made = await team.as(token, "POST", path, {});
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    return made.body as { code: string };
  };
  phones.ada = await pairPhone(await code(ada), "Ada's iPhone");
  phones.cleo = await pairPhone(await code(cleo), "Cleo's Pixel");
  phones.ben = await pairPhone(await code(admin, "/api/auth/pairing"), "Ben's iPhone");
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
}, hostTimeout(60_000));

it("lists a member's own phone for her, as its device and her address, and nobody else's", async () => {
  const mine = await listed(ada);
  expect(mine.rows).toEqual(["Ada's iPhone · ada@acme.test"]);
  expect(mine.phones[0]!.id).toBe(phones.ada.id);
  expect(mine.phones[0]!.expiresAt).toBeGreaterThan(Date.now());
  expect((await listed(cleo)).rows).toEqual(["Cleo's Pixel · cleo@acme.test"]);
  // Her phone sees itself, marked as the one asking.
  const fromPhone = await listed(phones.ada.token);
  expect(fromPhone.rows).toEqual(["Ada's iPhone · ada@acme.test"]);
  expect(fromPhone.current).toBe(phones.ada.id);
  // The app windows that open the team (the Admin's signed pairings) are not phones.
  expect(mine.rows.join()).not.toContain("OpenMausBot app");
}, hostTimeout(60_000));

it("lists every member's phone for the team's admins and its owner", async () => {
  const everyone = ["Ada's iPhone · ada@acme.test", "Ben's iPhone · ben@acme.test", "Cleo's Pixel · cleo@acme.test"];
  expect((await listed(admin)).rows).toEqual(everyone);
  expect((await listed(owner)).rows).toEqual(everyone);
}, hostTimeout(60_000));

it("lets a member remove only her own phone, and the removed phone is signed out at once", async () => {
  expect((await team.as(ada, "DELETE", `/api/team/phones/${phones.cleo.id}`)).status, "Ada removing Cleo's phone").toBe(404);
  expect((await team.as(phones.cleo.token, "GET", "/api/auth/session")).status, "Cleo's phone still works").toBe(200);
  // A member's own sign-ins that are not phones are not hers to end here: the desktop's session is unknown to the route.
  const desktop = (await team.as(cleo, "GET", "/api/auth/session")).body.id as string;
  expect((await team.as(cleo, "DELETE", `/api/team/phones/${desktop}`)).status).toBe(404);
  expect((await team.as(cleo, "GET", "/api/auth/session")).status).toBe(200);

  expect((await team.as(cleo, "DELETE", `/api/team/phones/${phones.cleo.id}`)).status).toBe(200);
  expect((await team.as(phones.cleo.token, "GET", "/api/auth/session")).status, "Cleo's removed phone").toBe(401);
  expect((await listed(cleo)).rows).toEqual([]);
  expect((await team.as(cleo, "GET", "/api/auth/session")).status, "her app is still signed in").toBe(200);
}, hostTimeout(60_000));

it("lets an admin remove a member's phone: its session ends, its open stream closes, the member's app stays", async () => {
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${phones.ada.token}`, accept: "text/event-stream" } });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  await reader.read();
  const ended = (async () => { for (;;) if ((await reader.read()).done) return true; })().catch(() => true);

  expect((await team.as(admin, "DELETE", `/api/team/phones/${phones.ada.id}`)).status).toBe(200);
  expect(await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve(false), 10_000))]), "the phone's open stream").toBe(true);
  expect((await team.as(phones.ada.token, "GET", "/api/auth/session")).status, "Ada's removed phone").toBe(401);
  expect((await team.as(phones.ada.token, "GET", "/api/bots")).status).toBe(401);
  expect((await team.as(ada, "GET", "/api/auth/session")).status, "Ada's app is still signed in").toBe(200);
  expect((await listed(ada)).rows).toEqual([]);
  expect((await listed(admin)).rows).toEqual(["Ben's iPhone · ben@acme.test"]);
  expect((await team.as(admin, "DELETE", `/api/team/phones/${phones.ada.id}`)).status, "gone already").toBe(404);
}, hostTimeout(60_000));

it("is a Team Cloud's only: My Cloud answers as before", async () => {
  expect((await fx.onCloud("GET", "/api/team/phones")).status).toBe(404);
  expect((await fx.onCloud("DELETE", `/api/team/phones/${phones.ben.id}`)).status).toBe(404);
}, hostTimeout(30_000));
