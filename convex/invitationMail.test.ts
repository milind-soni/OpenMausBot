/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { createSession, makePasswordRecord } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const hosted = "https://wry-fly-446.eu-west-1.convex.cloud";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function fixture(providerStatus = 200) {
  vi.stubEnv("CONVEX_CLOUD_URL", hosted);
  vi.stubEnv("ORIGIN_SITE_URL", "");
  vi.stubEnv("ORIGIN_PUBLIC_URL", "http://localhost:8799");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("BREVO_API_KEY", "");
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", "");
  vi.stubEnv("INVITE_FROM_EMAIL", "");
  const t = convexTest(schema, modules);
  const sessionToken = await t.run(async ctx => {
    const record = await makePasswordRecord("synthetic-invite-password!");
    const userId = await ctx.db.insert("users", { email: "owner@invite.test", name: "Owner", ...record, role: "user", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    return createSession(ctx, userId);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Invitation fixture", slug: "invitation-fixture" });
  const args = { sessionToken, teamId, email: " Invited@Invite.test ", role: "member" as const };
  const requests: { input: unknown; init?: RequestInit }[] = [];
  const send = vi.fn(async (input: unknown, init?: RequestInit) => { requests.push({ input, init }); return new Response("{}", { status: providerStatus }); });
  vi.stubGlobal("fetch", send);
  return { t, args, scope: { sessionToken, teamId }, requests, send };
}

test("hosted invitation uses the public site and honestly reports missing mail configuration", async () => {
  const f = await fixture();
  const result = await f.t.action(api.workspaces.sendEmailInvite, f.args);
  expect(result).toMatchObject({ sent: false, deliveryStatus: "not_configured", inviteLink: expect.stringMatching(/^https:\/\/origin\.imbored\.fun\/join\/[a-f0-9]{64}$/), token: expect.any(String), expiresAt: expect.any(Number) });
  const rows = await f.t.query(api.workspaces.invitations, f.scope);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ token: result.token, email: "invited@invite.test" });
  expect(f.send).not.toHaveBeenCalled();
});

test("provider acceptance uses the same link, normalized recipient and exactly one invitation", async () => {
  const f = await fixture();
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  vi.stubEnv("BREVO_API_KEY", "unused-brevo-key");
  vi.stubEnv("INVITE_FROM_EMAIL", "Origin <invites@origin.example>");
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const result = await f.t.action(api.workspaces.sendEmailInvite, f.args);
  expect(result).toMatchObject({ sent: true, deliveryStatus: "accepted" });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].input).toBe("https://api.resend.com/emails");
  expect(f.requests[0].init?.headers).toEqual({ Authorization: "Bearer synthetic-key", "Content-Type": "application/json" });
  expect(JSON.parse(String(f.requests[0].init?.body))).toMatchObject({ from: "Origin <invites@origin.example>", to: "invited@invite.test", text: expect.stringContaining(result.inviteLink) });
  expect(f.requests[0].init?.signal).toBeInstanceOf(AbortSignal);
  expect(timeout).toHaveBeenCalledWith(15_000);
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(1);
});

test.each([
  ["invites@origin.example", { email: "invites@origin.example" }],
  ["Origin Team <invites@origin.example>", { name: "Origin Team", email: "invites@origin.example" }],
  ['"Origin Team" <invites@origin.example>', { name: "Origin Team", email: "invites@origin.example" }],
])("explicit Brevo selection accepts %s and keeps one plaintext invitation", async (from, sender) => {
  const f = await fixture(201);
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", "brevo");
  vi.stubEnv("BREVO_API_KEY", "synthetic-brevo-key");
  vi.stubEnv("RESEND_API_KEY", "unused-resend-key");
  vi.stubEnv("INVITE_FROM_EMAIL", from);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const result = await f.t.action(api.workspaces.sendEmailInvite, f.args);
  expect(result).toMatchObject({ sent: true, deliveryStatus: "accepted" });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].input).toBe("https://api.brevo.com/v3/smtp/email");
  expect(f.requests[0].init?.headers).toEqual({ "api-key": "synthetic-brevo-key", "Content-Type": "application/json" });
  expect(JSON.parse(String(f.requests[0].init?.body))).toEqual({
    sender, to: [{ email: "invited@invite.test" }], subject: "Join Invitation fixture on Origin",
    textContent: `You've been invited to Invitation fixture. Join your workspace: ${result.inviteLink}\nThis invitation expires in 7 days.`,
  });
  expect(timeout).toHaveBeenCalledWith(15_000);
  expect(f.requests[0].init?.signal).toBeInstanceOf(AbortSignal);
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(1);
});

test.each([
  ["unrecognized", "synthetic-resend-key", "synthetic-brevo-key"],
  ["brevo", "synthetic-resend-key", ""],
  ["resend", "", "synthetic-brevo-key"],
])("unconfigured selected provider %s never falls back to another configured transport", async (provider, resend, brevo) => {
  const f = await fixture();
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", provider);
  vi.stubEnv("RESEND_API_KEY", resend);
  vi.stubEnv("BREVO_API_KEY", brevo);
  vi.stubEnv("INVITE_FROM_EMAIL", "Origin <invites@origin.example>");
  expect(await f.t.action(api.workspaces.sendEmailInvite, f.args)).toMatchObject({ sent: false, deliveryStatus: "not_configured" });
  expect(f.send).not.toHaveBeenCalled();
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(1);
});

test.each([
  "", "Origin", "Origin <invites@origin.example", "<invites@origin.example>",
  "one@origin.example, two@origin.example", "Origin <one@origin.example> <two@origin.example>",
  "Origin\r\nBcc: hidden@origin.example <invites@origin.example>", "Origin <invites@localhost>",
  "Origin <invites@origin..example>", "Origin <invites@-origin.example>", "Origin <.invites@origin.example>",
  "Origin <invites..team@origin.example>", '"Origin <invites@origin.example>', `Origin <${"a".repeat(65)}@origin.example>`,
])("Brevo sender configuration is rejected before transport: %j", async from => {
  const f = await fixture();
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", "brevo");
  vi.stubEnv("BREVO_API_KEY", "synthetic-brevo-key");
  vi.stubEnv("RESEND_API_KEY", "unused-resend-key");
  vi.stubEnv("INVITE_FROM_EMAIL", from);
  expect(await f.t.action(api.workspaces.sendEmailInvite, f.args)).toMatchObject({ sent: false, deliveryStatus: "not_configured" });
  expect(f.send).not.toHaveBeenCalled();
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(1);
});

test.each(["rejection", "network", "timeout"])("Brevo %s preserves one invitation and never retries through Resend", async mode => {
  const f = await fixture();
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", "brevo");
  vi.stubEnv("BREVO_API_KEY", "synthetic-brevo-key");
  vi.stubEnv("RESEND_API_KEY", "unused-resend-key");
  vi.stubEnv("INVITE_FROM_EMAIL", "Origin <invites@origin.example>");
  f.send.mockImplementation(async () => {
    if (mode !== "rejection") throw new DOMException("private provider response and synthetic-brevo-key", mode === "timeout" ? "TimeoutError" : "NetworkError");
    return new Response("private provider response and synthetic-brevo-key", { status: 429 });
  });
  const result = await f.t.action(api.workspaces.sendEmailInvite, f.args);
  expect(result).toMatchObject({ sent: false, deliveryStatus: "failed" });
  expect(JSON.stringify(result)).not.toMatch(/private provider response|synthetic-brevo-key|unused-resend-key/);
  expect(f.requests).toHaveLength(0);
  expect(f.send).toHaveBeenCalledExactlyOnceWith("https://api.brevo.com/v3/smtp/email", expect.anything());
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(1);
});

test.each(["resend", "brevo"])("an aborted %s request settles as failed without a second invitation", async provider => {
  const f = await fixture();
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  vi.stubEnv("BREVO_API_KEY", "synthetic-brevo-key");
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", provider);
  vi.stubEnv("INVITE_FROM_EMAIL", "invites@origin.example");
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  f.send.mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    controller.abort(new DOMException("synthetic timeout", "TimeoutError"));
  }));
  expect(await f.t.action(api.workspaces.sendEmailInvite, f.args)).toMatchObject({ sent: false, deliveryStatus: "failed" });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(1);
});

test.each(["missing sender", "missing key"])("%s does not make a provider request", async missing => {
  const f = await fixture();
  vi.stubEnv("RESEND_API_KEY", missing === "missing key" ? "" : "synthetic-key");
  vi.stubEnv("INVITE_FROM_EMAIL", missing === "missing sender" ? "" : "invites@origin.example");
  expect(await f.t.action(api.workspaces.sendEmailInvite, f.args)).toMatchObject({ sent: false, deliveryStatus: "not_configured" });
  expect(f.send).not.toHaveBeenCalled();
});

test.each(["rejection", "network", "timeout"])("provider %s preserves the invitation and sanitizes its failure", async mode => {
  const f = await fixture();
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  vi.stubEnv("INVITE_FROM_EMAIL", "invites@origin.example");
  f.send.mockImplementation(async () => {
    if (mode !== "rejection") throw new DOMException("private provider response", mode === "timeout" ? "TimeoutError" : "NetworkError");
    return new Response("private provider response", { status: 429 });
  });
  const result = await f.t.action(api.workspaces.sendEmailInvite, f.args);
  expect(result).toMatchObject({ sent: false, deliveryStatus: "failed" });
  expect(JSON.stringify(result)).not.toContain("private provider response");
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(1);
});

test("unrecognized deployment cannot send tokens to the global site or a loopback site", async () => {
  const f = await fixture();
  vi.stubEnv("CONVEX_CLOUD_URL", "https://custom-deployment.convex.cloud");
  for (const site of ["", "http://localhost:3000", "https://user:password@site.example"]) {
    vi.stubEnv("ORIGIN_SITE_URL", site);
    await expect(f.t.action(api.workspaces.sendEmailInvite, f.args)).rejects.toThrow("invitation website");
  }
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(0);
  expect(f.send).not.toHaveBeenCalled();
});

test.each(["resend", "brevo"])("invalid session is refused before any %s invitation or mail", async provider => {
  const f = await fixture();
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", provider);
  await expect(f.t.action(api.workspaces.sendEmailInvite, { ...f.args, sessionToken: "not-a-session" })).rejects.toThrow();
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(0);
  expect(f.send).not.toHaveBeenCalled();
});

test("authoritative address follows the deployment and never accepts client site overrides", async () => {
  const f = await fixture();
  expect(await f.t.query(api.workspaces.inviteAddress, {})).toEqual({ convexUrl: hosted, origin: "https://origin.imbored.fun" });
  vi.stubEnv("CONVEX_CLOUD_URL", "https://custom.convex.cloud");
  vi.stubEnv("ORIGIN_SITE_URL", "https://team.example/");
  expect(await f.t.query(api.workspaces.inviteAddress, {})).toEqual({ convexUrl: "https://custom.convex.cloud", origin: "https://team.example" });
  expect((await f.t.action(api.workspaces.sendEmailInvite, f.args)).inviteLink).toMatch(/^https:\/\/team\.example\/join\//);
});

test("project email invitation keeps its project, role and one-time email binding", async () => {
  const f = await fixture();
  const projectId = await f.t.mutation(api.projects.create, { ...f.scope, name: "Private fixture", repoUrl: "https://github.com/fixture/invitation" });
  const result = await f.t.action(api.workspaces.sendEmailInvite, { ...f.args, projectId, role: "viewer" });
  const rows = await f.t.query(api.workspaces.invitations, f.scope);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ token: result.token, projectId, role: "viewer", email: "invited@invite.test" });
  await expect(f.t.action(api.workspaces.sendEmailInvite, { ...f.args, projectId, role: "admin" })).rejects.toThrow("cannot grant");
  const other = await f.t.mutation(api.workspaces.create, { sessionToken: f.args.sessionToken, name: "Other fixture", slug: "other-invite-fixture" });
  await expect(f.t.action(api.workspaces.sendEmailInvite, { ...f.args, teamId: other.teamId, projectId })).rejects.toThrow("Project not found");
  expect(await f.t.query(api.workspaces.invitations, { sessionToken: f.args.sessionToken, teamId: other.teamId })).toHaveLength(0);
  expect(f.send).not.toHaveBeenCalled();
});

test.each(["resend", "brevo"])("a valid non-admin session cannot reserve or send %s invitations", async provider => {
  const f = await fixture();
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", provider);
  const outsiderSession = await f.t.run(async ctx => {
    const owner = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", "owner@invite.test")).unique();
    if (!owner) throw new Error("Missing fixture owner");
    const userId = await ctx.db.insert("users", { email: "outsider@invite.test", name: "Outsider", passwordHash: owner.passwordHash, salt: owner.salt, iterations: owner.iterations, role: "user", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    return createSession(ctx, userId);
  });
  await expect(f.t.action(api.workspaces.sendEmailInvite, { ...f.args, sessionToken: outsiderSession })).rejects.toThrow("You don't have access to this workspace");
  expect(await f.t.query(api.workspaces.invitations, f.scope)).toHaveLength(0);
  expect(f.send).not.toHaveBeenCalled();
});

test.each(["resend", "brevo"])("per-creator hourly reservations cover all workspaces and concurrent %s attempts", async provider => {
  const f = await fixture();
  vi.stubEnv("ORIGIN_INVITE_MAIL_PROVIDER", provider);
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  vi.stubEnv("BREVO_API_KEY", "synthetic-brevo-key");
  vi.stubEnv("INVITE_FROM_EMAIL", "invites@origin.example");
  for (let index = 0; index < 19; index++) await f.t.mutation(api.workspaces.createInvite, { ...f.scope, role: "member" });
  const other = await f.t.mutation(api.workspaces.create, { sessionToken: f.args.sessionToken, name: "Rate fixture", slug: "rate-invite-fixture" });
  const results = await Promise.allSettled([
    f.t.action(api.workspaces.sendEmailInvite, f.args),
    f.t.action(api.workspaces.sendEmailInvite, { ...f.args, teamId: other.teamId }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(result => result.status === "rejected");
  expect(rejected?.status === "rejected" && String(rejected.reason)).toContain("20 invitations per hour");
  expect(f.requests).toHaveLength(1);
  const before = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(before + 3_600_001);
  expect(await f.t.action(api.workspaces.sendEmailInvite, { ...f.args, teamId: other.teamId })).toMatchObject({ deliveryStatus: "accepted" });
  expect(f.requests).toHaveLength(2);
});
