import { afterEach, beforeEach, expect, it } from "vitest";
import { launchFixture } from "./fixture.ts";

let fixture: Awaited<ReturnType<typeof launchFixture>>;
beforeEach(async () => { fixture = await launchFixture(); });
afterEach(async () => { await fixture.close(); });

it("keeps intended state separate from live service state and unavailable status", async () => {
  const admin = fixture.client(); await admin.login("operator@example.test");
  expect((await admin.request("/api/workspaces", "POST", { slug: "alpha", name: "Alpha" })).status).toBe(201);
  const listed = async () => (await (await admin.request("/api/workspaces")).json()).workspaces[0];
  expect(await listed()).toMatchObject({ slug: "alpha", status: "running", runtime: "active", checkedAt: expect.any(Number) });
  fixture.fleetWorkspaces.set("alpha", "failed");
  expect(await listed()).toMatchObject({ status: "running", runtime: "failed" });
  fixture.fleetWorkspaces.set("alpha", "inactive");
  expect(await listed()).toMatchObject({ status: "running", runtime: "inactive" });
  fixture.fleetWorkspaces.delete("alpha");
  expect(await listed()).toMatchObject({ status: "running", runtime: "missing" });
  fixture.faults.fleet = true;
  const unavailable = await listed();
  expect(unavailable).toMatchObject({ status: "running", runtime: "unknown", checkedAt: null });
  expect(JSON.stringify(unavailable)).not.toContain("fixture-private-error");
  expect(fixture.calls.findLast(call => call.method === "GET")?.path).toBe("/workspaces?statusOnly=true");
});

it("does not reveal a removed member's workspace after awaiting fleet status", async () => {
  const admin = fixture.client(); await admin.login("operator@example.test");
  await admin.request("/api/workspaces", "POST", { slug: "alpha", name: "Alpha" });
  const invite = await (await admin.request("/api/workspaces/alpha/invitations", "POST", { email: "member@example.test", role: "member" })).json();
  const member = fixture.client(); await member.login("member@example.test");
  expect((await member.request(`/api/invitations/${invite.invitation.id}/accept`, "POST", {})).ok).toBe(true);
  fixture.behavior.beforeFleet = async (method, path) => {
    if (method === "GET" && path === "/workspaces?statusOnly=true") {
      fixture.store.db.prepare("DELETE FROM portal_member WHERE workspace = ? AND email = ?").run("alpha", "member@example.test");
    }
  };
  expect((await (await member.request("/api/workspaces")).json()).workspaces).toEqual([]);
});
