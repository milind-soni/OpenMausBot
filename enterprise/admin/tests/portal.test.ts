import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { digest } from "../server/store.ts";
import { launchFixture } from "./fixture.ts";

let fixture: Awaited<ReturnType<typeof launchFixture>>;
beforeEach(async () => { fixture = await launchFixture(); });
afterEach(async () => { await fixture.close(); });
async function operator() { const client = fixture.client(); await client.login("operator@example.test"); return client; }
async function create(client: Awaited<ReturnType<typeof operator>>, slug: string, models: string[] = []) {
  const result = await client.request("/api/workspaces", "POST", { slug, name: `${slug} workspace`, models });
  expect(result.status, await result.clone().text()).toBe(201);
}
async function invite(client: Awaited<ReturnType<typeof operator>>, slug: string, email: string, role = "member") {
  const response = await client.request(`/api/workspaces/${slug}/invitations`, "POST", { email, role });
  expect(response.status).toBe(201);
  return (await response.json()).invitation.id as string;
}

it("authenticates with real email OTP; a login alone grants no workspace or fleet authority", async () => {
  const anonymous = fixture.client();
  expect((await anonymous.request("/api/workspaces")).status).toBe(401);
  expect((await anonymous.request("/api/auth/email-otp/send-verification-otp", "POST", { email: "unknown@example.test", type: "sign-in" })).ok).toBe(true);
  expect(fixture.mails).toHaveLength(0);
  const admin = await operator();
  await create(admin, "alpha"); await create(admin, "beta");
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
  expect((await admin.request("/api/workspaces/alpha/connect", "POST", { challenge: digest(verifier), state })).status).toBe(403);
  const created = fixture.calls.find((call) => call.path === "/workspaces" && call.method === "POST")!.body as Record<string, unknown>;
  expect(created).toMatchObject({ admins: ["operator@example.test"], members: [], portalUrl: fixture.url });
  expect(Object.keys(created).some((key) => /chat|bot|memory|cookie/i.test(key))).toBe(false);
  const id = await invite(admin, "alpha", "alice@example.test");
  expect(fixture.calls.filter((call) => call.path.endsWith("/users"))).toHaveLength(0);
  const wrong = await admin.request(`/api/invitations/${id}`);
  expect(wrong.status).toBe(403); expect(await wrong.text()).not.toContain("alice@example.test");
  const alice = fixture.client(); await alice.login("alice@example.test");
  expect((await alice.request("/api/workspaces")).status).toBe(200);
  expect((await (await alice.request("/api/workspaces")).json()).workspaces).toHaveLength(0);
  expect((await alice.request(`/api/invitations/${id}/accept`, "POST", {})).status).toBe(200);
  const visible = await (await alice.request("/api/workspaces")).json();
  expect(visible.workspaces.map((workspace: { slug: string }) => workspace.slug)).toEqual(["alpha"]);
  expect((await alice.request("/api/workspaces", "POST", { slug: "owned", name: "bad" })).status).toBe(403);
  expect((await alice.request("/api/workspaces/beta/people")).status).toBe(403);
  expect((await alice.request("/api/providers")).status).toBe(403);
  expect((await alice.request("/api/workspaces/alpha/suspend", "POST", {})).status).toBe(403);
});

it("binds handoffs to the workspace and PKCE proof, consumes once, and revokes grants on removal", async () => {
  const admin = await operator(); await create(admin, "alpha"); await create(admin, "beta");
  const id = await invite(admin, "alpha", "alice@example.test");
  const alice = fixture.client(); await alice.login("alice@example.test"); await alice.request(`/api/invitations/${id}/accept`, "POST", {});
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
  const connected = await (await alice.request("/api/workspaces/alpha/connect", "POST", { challenge: digest(verifier), state })).json();
  const url = new URL(connected.url), code = url.searchParams.get("code");
  expect(url.origin).toBe("https://alpha.example.test"); expect(url.searchParams.get("state")).toBe(state);
  const anon = fixture.client();
  expect((await anon.request("/api/handoff/consume", "POST", { workspace: "beta", code, verifier })).status).toBe(401);
  expect((await anon.request("/api/handoff/consume", "POST", { workspace: "alpha", code, verifier: state })).status).toBe(401);
  const result = await anon.request("/api/handoff/consume", "POST", { workspace: "alpha", code, verifier });
  expect(result.status).toBe(200); const grant = (await result.json()).grant;
  expect((await anon.request("/api/handoff/consume", "POST", { workspace: "alpha", code, verifier })).status).toBe(401);
  expect((await anon.request("/api/handoff/check", "POST", { workspace: "beta", grant })).status).toBe(401);
  expect((await anon.request("/api/handoff/check", "POST", { workspace: "alpha", grant })).status).toBe(200);
  expect(JSON.stringify(fixture.db.prepare("SELECT * FROM portal_grant").all())).not.toContain(grant);
  expect((await admin.request("/api/workspaces/alpha/members", "DELETE", { email: "alice@example.test" })).status).toBe(200);
  expect((await anon.request("/api/handoff/check", "POST", { workspace: "alpha", grant })).status).toBe(401);
});

it("keeps expired/revoked invitations out, reports delivery failure, and protects same-tab account switching", async () => {
  const admin = await operator(); await create(admin, "alpha");
  const id = await invite(admin, "alpha", "alice@example.test");
  await admin.request(`/api/invitations/${id}/revoke`, "POST", {});
  expect((await admin.request(`/api/invitations/${id}/resend`, "POST", {})).status).toBe(409);
  const next = await invite(admin, "alpha", "alice@example.test");
  const alice = fixture.client(); await alice.login("alice@example.test");
  fixture.db.prepare("UPDATE portal_invitation SET expiresAt = 0 WHERE id = ?").run(next);
  expect((await alice.request(`/api/invitations/${next}/accept`, "POST", {})).status).toBe(409);
  fixture.faults.mail = true;
  const failed = await admin.request("/api/workspaces/alpha/invitations", "POST", { email: "bob@example.test", role: "member" });
  expect(failed.status).toBe(502);
  expect((await failed.json()).invitation.status).toBe("pending");
  expect((await admin.request("/api/workspaces/alpha/invitations", "POST", { email: "csrf@example.test", role: "admin" }, { origin: "https://attacker.example" })).status).toBe(403);
  expect((await admin.request("/api/auth/sign-out", "POST", {})).status).toBe(200);
  expect((await admin.request("/api/me")).status).toBe(401);
});

it("isolates the master provider key and enforces each workspace's allowed models and state", async () => {
  const admin = await operator();
  const secret = "fixture-master-key-must-stay-server-side";
  const saved = await admin.request("/api/providers", "POST", { key: secret, models: ["fixture-model", "other-model"] });
  expect(saved.status).toBe(200); expect(await saved.text()).not.toContain(secret);
  await create(admin, "alpha", ["fixture-model"]); await create(admin, "beta", []);
  const seed = fixture.calls.find((call) => call.method === "POST" && call.path === "/workspaces")!.body as { anthropicKey: string };
  expect(seed.anthropicKey).not.toBe(secret);
  expect(JSON.stringify(fixture.db.prepare("SELECT * FROM portal_provider").all())).not.toContain(secret);
  const anon = fixture.client();
  const post = (slug: string, model: string, path = "messages") => anon.request(`/api/gateway/${slug}/anthropic/v1/${path}`, "POST", { model, messages: [] }, { "x-api-key": seed.anthropicKey });
  expect((await post("beta", "fixture-model")).status).toBe(403);
  expect((await post("alpha", "other-model")).status).toBe(403);
  expect((await post("alpha", "fixture-model", "organizations")).status).toBe(404);
  expect((await post("alpha", "fixture-model")).status).toBe(200);
  expect(fixture.upstream).toHaveLength(1);
  expect(fixture.upstream[0].url).toBe("https://api.anthropic.com/v1/messages");
  expect(fixture.upstream[0].headers.get("x-api-key")).toBe(secret);
  expect((await admin.request("/api/workspaces/alpha/suspend", "POST", {})).status).toBe(200);
  expect((await post("alpha", "fixture-model")).status).toBe(403);
  expect(JSON.stringify(await (await admin.request("/api/activity")).json())).not.toContain(secret);
});

it("preserves recovery states, never silently deletes files, and requires an active entitlement", async () => {
  const admin = await operator(); await create(admin, "alpha");
  fixture.db.prepare("UPDATE portal_workspace SET status = 'error' WHERE slug = 'alpha'").run();
  expect((await admin.request("/api/workspaces/alpha/suspend", "POST", {})).status).toBe(409);
  expect(fixture.store.workspace("alpha")?.status).toBe("error");
  expect((await admin.request("/api/workspaces/alpha", "DELETE", { confirm: "alpha" })).status).toBe(409);
  fixture.db.prepare("UPDATE portal_workspace SET status = 'running' WHERE slug = 'alpha'").run();
  expect((await admin.request("/api/workspaces/alpha", "DELETE", { confirm: "wrong" })).status).toBe(400);
  expect((await admin.request("/api/workspaces/alpha", "DELETE", { confirm: "alpha" })).status).toBe(200);
  expect(fixture.store.workspace("alpha")?.status).toBe("retained");
  expect(fixture.calls.find((call) => call.method === "DELETE")?.body).toEqual({ keepData: true });
  fixture.faults.licensed = false;
  expect((await admin.request("/api/workspaces")).status).toBe(403);
});

it("reserves failed creates, does not leak fleet errors, and serializes concurrent creation", async () => {
  const admin = await operator();
  fixture.behavior.beforeFleet = async (method, path) => {
    if (method === "POST" && path === "/workspaces") fixture.faults.fleet = true;
  };
  const failed = await admin.request("/api/workspaces", "POST", { slug: "alpha", name: "Alpha" });
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain("fixture-private-error");
  expect(fixture.store.workspace("alpha")?.status).toBe("error");
  expect((await admin.request("/api/workspaces", "POST", { slug: "alpha", name: "Again" })).status).toBe(409);
  fixture.faults.fleet = false; fixture.behavior.beforeFleet = undefined;
  const results = await Promise.all([
    admin.request("/api/workspaces", "POST", { slug: "beta", name: "Beta" }),
    admin.request("/api/workspaces", "POST", { slug: "beta", name: "Beta twice" }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  expect(fixture.calls.filter((call) => call.method === "POST" && call.path === "/workspaces" && (call.body as { slug: string }).slug === "beta")).toHaveLength(1);
});

it("rechecks manager authority after queued demotion rather than applying stale permission", async () => {
  const admin = await operator(); await create(admin, "alpha");
  const first = await invite(admin, "alpha", "manager@example.test", "admin");
  const second = await invite(admin, "alpha", "other@example.test", "admin");
  const manager = fixture.client(); await manager.login("manager@example.test");
  const other = fixture.client(); await other.login("other@example.test");
  await manager.request(`/api/invitations/${first}/accept`, "POST", {});
  await other.request(`/api/invitations/${second}/accept`, "POST", {});
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((done) => { entered = done; });
  const blocked = new Promise<void>((done) => { release = done; });
  fixture.behavior.beforeFleet = async (method, path) => {
    if (method === "POST" && path === "/workspaces") { entered(); await blocked; }
  };
  const creating = admin.request("/api/workspaces", "POST", { slug: "beta", name: "Beta" });
  await waiting;
  const memberSpy = vi.spyOn(fixture.store, "member");
  const demoting = admin.request("/api/workspaces/alpha/members", "POST", { email: "manager@example.test", role: "member" });
  const stale = manager.request("/api/workspaces/alpha/invitations", "POST", { email: "attacker@example.test", role: "admin" });
  await vi.waitFor(() => expect(memberSpy).toHaveBeenCalledWith("alpha", "manager@example.test"));
  release();
  expect((await creating).status).toBe(201);
  expect((await demoting).status).toBe(200);
  expect((await stale).status).toBe(403);
  expect(fixture.store.people("alpha").invitations.some((invitation) => invitation.email === "attacker@example.test")).toBe(false);
});
