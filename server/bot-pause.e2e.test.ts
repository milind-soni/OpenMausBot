// Pausing on a real server, its AI a fixture whose turns never end (FAKE_CLAUDE_MODE=hang), so there is always work to stop.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

let fixture: VerificationServer;
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
};
const ok = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
const newBot = async (name: string) => (await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]) as { bot: { id: string; activeTaskId: string } }).bot;
const send = (bot: { id: string; activeTaskId: string }, text: string) => call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.activeTaskId, sendId: randomUUID() });
const busy = async (botId: string) => ((await ok("GET", "/api/bots")).bots as Array<{ id: string; tasks?: Array<{ busy?: boolean }> }>)
  .find((bot) => bot.id === botId)?.tasks?.some((task) => task.busy) === true;

beforeAll(async () => { fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" }); }, 120_000);
afterAll(async () => { await fixture?.close(); });

it("pausing a bot stops its running work and refuses new work until it is resumed", async () => {
  const ada = await newBot("Ada");
  expect((await send(ada, "Start a long job.")).status).toBeLessThan(300);
  await expect.poll(() => busy(ada.id), { timeout: 20_000 }).toBe(true);

  expect(await ok("POST", "/api/paused", { kind: "bot", id: ada.id, paused: true })).toMatchObject({ bots: [ada.id], heldBots: [ada.id], stopped: 1 });
  await expect.poll(() => busy(ada.id), { timeout: 20_000 }).toBe(false);
  expect((await ok("GET", "/api/config")).heldBots).toEqual([ada.id]);

  const refused = await send(ada, "One more thing.");
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ code: "bot_held" });
  expect(JSON.stringify(refused.body)).toContain("Ada is paused");

  expect(await ok("POST", "/api/paused", { kind: "bot", id: ada.id, paused: false })).toMatchObject({ bots: [], heldBots: [], stopped: 0 });
  expect((await send(ada, "Carry on.")).status).toBeLessThan(300);
  await expect.poll(() => busy(ada.id), { timeout: 20_000 }).toBe(true);
}, 120_000);

it("pausing a department pauses its bots, keeps the pause through a rename, and leaves other bots working", async () => {
  const bo = await newBot("Bo");
  const cy = await newBot("Cy");
  await ok("POST", "/api/sidebar-sections", { name: "Sales", botIds: [bo.id] });
  expect(await ok("POST", "/api/paused", { kind: "department", id: "Sales", paused: true })).toMatchObject({ departments: ["Sales"], heldBots: expect.arrayContaining([bo.id]) });
  const refused = await send(bo, "Hello.");
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.body)).toContain("Sales department");
  expect((await send(cy, "Hello.")).status).toBeLessThan(300);

  await ok("PATCH", "/api/sidebar-sections?section=Sales", { name: "Revenue" });
  expect(await ok("GET", "/api/paused")).toMatchObject({ departments: ["Revenue"], heldBots: expect.arrayContaining([bo.id]) });
  expect((await send(bo, "Still there?")).status).toBe(409);

  await ok("POST", "/api/paused", { kind: "department", id: "Revenue", paused: false });
  expect((await send(bo, "Back to work.")).status).toBeLessThan(300);
  expect((await call("POST", "/api/paused", { kind: "department", id: "Nowhere", paused: true })).status).toBe(404);
}, 120_000);
