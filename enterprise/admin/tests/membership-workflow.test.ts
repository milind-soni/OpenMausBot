import { afterEach, beforeEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PortalStore, digest } from "../server/store.ts";
import { launchFixture } from "./fixture.ts";

let fixture: Awaited<ReturnType<typeof launchFixture>>;
type Client = ReturnType<typeof fixture.client>;
let operator: Client;
beforeEach(async () => {
  fixture = await launchFixture(); operator = fixture.client();
  await operator.login("operator@example.test");
  expect((await operator.request("/api/workspaces", "POST", { slug: "alpha", name: "Alpha" })).status).toBe(201);
});
afterEach(async () => { await fixture.close(); });

async function join(workspace: string, email: string, role: "admin" | "member", inviter = operator) {
  const invited = await inviter.request(`/api/workspaces/${workspace}/invitations`, "POST", { email, role });
  expect(invited.status, await invited.clone().text()).toBe(201);
  const { invitation } = await invited.json();
  const client = fixture.client(); await client.login(email);
  expect((await client.request(`/api/invitations/${invitation.id}/accept`, "POST", {})).status).toBe(200);
  return client;
}

async function begin(client: Client, workspace = "alpha") {
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
  const response = await client.request(`/api/workspaces/${workspace}/connect`, "POST", { state, challenge: digest(verifier) });
  expect(response.status).toBe(200);
  const { url } = await response.json();
  return { workspace, verifier, code: new URL(url).searchParams.get("code") };
}

async function grant(client: Client, workspace = "alpha") {
  const response = await fixture.client().request("/api/handoff/consume", "POST", await begin(client, workspace));
  expect(response.status).toBe(200);
  return { workspace, grant: (await response.json()).grant as string };
}
const check = (proof: { workspace: string; grant: string }) => fixture.client().request("/api/handoff/check", "POST", proof);

it("shares one workspace with multiple people while preserving independent client access and live revocation", async () => {
  expect((await operator.request("/api/workspaces", "POST", { slug: "beta", name: "Beta" })).status).toBe(201);
  const alice = await join("alpha", "alice@example.test", "admin");
  const bob = await join("alpha", "bob@example.test", "admin", alice);
  const carol = await join("alpha", "carol@example.test", "member", bob);
  const dana = await join("beta", "dana@example.test", "admin");
  expect(JSON.parse(fixture.fleetConfigs.get("alpha")!).signIn).toEqual({
    admins: ["operator@example.test", "alice@example.test", "bob@example.test"], members: ["carol@example.test"],
  });
  expect(JSON.parse(fixture.fleetConfigs.get("beta")!).signIn).toEqual({
    admins: ["operator@example.test", "dana@example.test"], members: [],
  });
  for (const client of [alice, bob, carol]) {
    const visible = await (await client.request("/api/workspaces")).json();
    expect(visible.workspaces.map((workspace: { slug: string }) => workspace.slug)).toEqual(["alpha"]);
    expect((await client.request("/api/workspaces/beta/people")).status).toBe(403);
  }
  expect((await dana.request("/api/workspaces/alpha/people")).status).toBe(403);
  expect((await carol.request("/api/workspaces/alpha/invitations", "POST", { email: "outsider@example.test", role: "admin" })).status).toBe(403);
  expect((await alice.request("/api/providers")).status).toBe(403);
  expect((await alice.request("/api/workspaces/alpha/members", "POST", { email: "carol@example.test", role: "admin" })).status).toBe(200);
  expect((await bob.request("/api/workspaces/alpha/members", "POST", { email: "carol@example.test", role: "member" })).status).toBe(200);
  const a = await grant(alice), b = await grant(bob), d = await grant(dana, "beta");
  expect((await bob.request("/api/workspaces/alpha/members", "DELETE", { email: "alice@example.test" })).status).toBe(200);
  expect((await check(a)).status).toBe(401);
  expect((await check(b)).status).toBe(200);
  expect((await check(d)).status).toBe(200);
  expect(JSON.parse(fixture.fleetConfigs.get("alpha")!).signIn.admins).not.toContain("alice@example.test");
  expect((await (await alice.request("/api/workspaces")).json()).workspaces).toHaveLength(0);
  expect((await bob.request("/api/workspaces/alpha/members", "DELETE", { email: "bob@example.test" })).status).toBe(409);
});

it("explains the bootstrap operator role before inviting or accepting, then permits member access after another administrator joins", async () => {
  const blocked = await operator.request("/api/workspaces/alpha/invitations", "POST", { email: "operator@example.test", role: "member" });
  expect(blocked.status).toBe(400);
  expect(await blocked.text()).toContain("Invite another workspace administrator first");
  expect(fixture.store.people("alpha").invitations).toHaveLength(0);
  // A pending invite from an older portal must be checked again on acceptance.
  const previous = fixture.store.invite("alpha", "operator@example.test", "member");
  expect((await operator.request(`/api/invitations/${previous.id}/accept`, "POST", {})).status).toBe(400);
  expect(fixture.calls.some(call => call.path.endsWith("/users"))).toBe(false);
  await join("alpha", "alice@example.test", "admin");
  expect((await operator.request(`/api/invitations/${previous.id}/accept`, "POST", {})).status).toBe(200);
  expect(fixture.store.member("alpha", "operator@example.test")?.role).toBe("member");
  expect(JSON.parse(fixture.fleetConfigs.get("alpha")!).signIn).toEqual({ admins: ["alice@example.test"], members: ["operator@example.test"] });
});

it("retains a bounded shared-IP sign-in allowance after allowing coworkers to onboard together", async () => {
  // The operator's setup already requested one code from this loopback IP.
  const anonymous = fixture.client();
  for (let count = 1; count < 20; count++) {
    expect((await anonymous.request("/api/auth/email-otp/send-verification-otp", "POST", { email: "uninvited@example.test", type: "sign-in" })).status).toBe(200);
  }
  expect((await anonymous.request("/api/auth/email-otp/send-verification-otp", "POST", { email: "uninvited@example.test", type: "sign-in" })).status).toBe(429);
  expect(fixture.mails.some(mail => mail.to === "uninvited@example.test")).toBe(false);
});

it("still locks an individual code after five wrong attempts", async () => {
  expect((await operator.request("/api/workspaces/alpha/invitations", "POST", { email: "alice@example.test", role: "member" })).status).toBe(201);
  const alice = fixture.client();
  expect((await alice.request("/api/auth/email-otp/send-verification-otp", "POST", { email: "alice@example.test", type: "sign-in" })).status).toBe(200);
  const code = /code is (\d{6})/.exec(fixture.mails.findLast(mail => mail.to === "alice@example.test")!.text)![1];
  const wrong = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await alice.request("/api/auth/sign-in/email-otp", "POST", { email: "alice@example.test", otp: wrong })).ok).toBe(false);
  }
  expect((await alice.request("/api/auth/sign-in/email-otp", "POST", { email: "alice@example.test", otp: code })).ok).toBe(false);
  expect((await alice.request("/api/me")).status).toBe(401);
});

it("ends both pending handoffs and workspace grants when their portal session signs out, without signing out another device", async () => {
  const alice = await join("alpha", "alice@example.test", "member");
  const otherDevice = fixture.client(); await otherDevice.login("alice@example.test");
  const signedOut = await grant(alice), stillActive = await grant(otherDevice), pending = await begin(alice);
  expect((await alice.request("/api/auth/sign-out", "POST", {})).status).toBe(200);
  expect((await alice.request("/api/me")).status).toBe(401);
  expect((await check(signedOut)).status).toBe(401);
  expect((await fixture.client().request("/api/handoff/consume", "POST", pending)).status).toBe(401);
  expect((await check(stillActive)).status).toBe(200);
});

it("rejects grants after the portal session expires or its verified email changes", async () => {
  const alice = await join("alpha", "alice@example.test", "member");
  const proof = await grant(alice);
  fixture.db.prepare('UPDATE "session" SET expiresAt = ? WHERE userId IN (SELECT id FROM "user" WHERE email = ?)')
    .run(new Date(Date.now() - 1000).toISOString(), "alice@example.test");
  expect((await check(proof)).status).toBe(401);
  await alice.login("alice@example.test");
  const current = await grant(alice);
  fixture.db.prepare('UPDATE "user" SET email = ? WHERE email = ?').run("someone-else@example.test", "alice@example.test");
  expect((await check(current)).status).toBe(401);
});

it("invalidates legacy sessionless handoffs and grants without changing workspace membership", async () => {
  await join("alpha", "alice@example.test", "member");
  fixture.db.exec(`
    DROP TABLE portal_handoff; DROP TABLE portal_grant;
    CREATE TABLE portal_handoff (hash TEXT PRIMARY KEY, workspace TEXT, email TEXT, challenge TEXT, expiresAt INTEGER);
    CREATE TABLE portal_grant (hash TEXT PRIMARY KEY, workspace TEXT, email TEXT, expiresAt INTEGER);
    INSERT INTO portal_handoff VALUES ('old-code', 'alpha', 'alice@example.test', 'proof', 9999999999999);
    INSERT INTO portal_grant VALUES ('old-grant', 'alpha', 'alice@example.test', 9999999999999);
  `);
  const migrated = new PortalStore(fixture.db);
  expect(fixture.db.prepare("SELECT * FROM portal_handoff").all()).toHaveLength(0);
  expect(fixture.db.prepare("SELECT * FROM portal_grant").all()).toHaveLength(0);
  expect(migrated.member("alpha", "alice@example.test")?.role).toBe("member");
  const alice = fixture.client(); await alice.login("alice@example.test");
  expect((await check(await grant(alice))).status).toBe(200);
});
