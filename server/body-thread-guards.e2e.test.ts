import { expect, it } from "vitest";

import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("gives a member the same 404 for missing and hidden bots with invalid handoff bodies", async () => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "synthetic-owner-lookup-token",
    team: { id: "team-owner-lookup", name: "Owner lookup" } });
  try {
    const team = fixture.team!;
    const owner = await team.pair({ email: "ada@guards.test", role: "owner" });
    const member = await team.pair({ email: "bob@guards.test", role: "member" });
    const created = await team.as(owner.token!, "POST", "/api/bots", { name: "Private Scout", visibility: "admins" });
    expect(created.status).toBe(201);
    for (const id of [created.body.bot.id, "missing-bot"]) {
      const response = await team.as(member.token!, "PUT", `/api/bots/${id}/reports-to`, {});
      expect(response, id).toEqual({ status: 404, body: { error: "no such bot" } });
    }
  } finally {
    await fixture.close();
  }
}, hostTimeout(120_000));

it("keeps a Team Cloud server alive when a member posts request-sized threadIds arrays", async () => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "synthetic-route-guard-token",
    team: { id: "team-guards", name: "Guards" } });
  try {
    const team = fixture.team!;
    const member = await team.pair({ email: "bob@guards.test", role: "member" });
    expect(member.status).toBe(200);
    for (const refs of [{ threadIds: Array<string>(200_000).fill("") }, { envelope: { threadIds: Array<string>(200_000).fill("") } }]) {
      const body = { memberIds: [], ...refs };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1_000_000);
      const response = await team.as(member.token!, "POST", "/api/groups", body);
      expect(response.status, fixture.logs()).toBe(400);
      expect((await team.as(member.token!, "GET", "/api/bots")).status).toBe(200);
    }
  } finally {
    await fixture.close();
  }
}, hostTimeout(120_000));
