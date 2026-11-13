// End-to-end on the fakes: in a room, the person points at part of a member's page and the pick goes to the bot that
// made the page, as records in that bot's turn only. No model is called and no external service is reached.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
}, 90_000);
afterAll(async () => {
  await fixture?.close();
});

it("sends a pick on a room page to the bot that made it, and to no other member", async () => {
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const designer = (await cli("new-bot", "--name", "Designer")).bot;
  const helper = (await cli("new-bot", "--name", "Helper")).bot;
  const evidence = (botId: string) => (existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean) : [])
    .map((line) => JSON.parse(line)).filter((entry: any) => entry.botId === botId && entry.prompt !== undefined);
  const plan = (steps: Array<{ tool: string; arguments: unknown }>) =>
    writeFileSync(planPath, JSON.stringify({ [designer.id]: { steps, reply: "Done." }, [helper.id]: { steps: [], reply: "Done." } }));
  const settled = async (botId: string) => expect((await cli("wait", "--bot", botId, "--timeout", "30")).status).toBe("settled");
  // Helper answers the room by default, so only the pick can send the next line to Designer.
  const created = await api("/api/groups", {
    name: "Design room", memberIds: [designer.id, helper.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: helper.id } },
  });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  const group = created.body.group;
  const transcript = async () => (await api(`/api/threads/${group.threadId}/messages?limit=50`)).body.messages as any[];

  plan([{ tool: "show_html", arguments: { html: "<main><button>Go</button></main>", title: "Launch" } }]);
  expect((await api(`/api/groups/${group.id}/messages`, { text: "@Designer make a launch page", mentions: [designer.id] })).status).toBe(202);
  await expect.poll(async () => (await transcript()).find((message) => message.kind === "app")?.id, { timeout: 30_000 }).toBeTruthy();
  await settled(designer.id);
  const page = (await transcript()).find((message) => message.kind === "app");
  expect(page).toMatchObject({ from: { botId: designer.id }, app: { source: "html", title: "Launch" } });

  plan([]);
  const designerTurns = evidence(designer.id).length, helperTurns = evidence(helper.id).length;
  const pointed = { appId: page.id, rev: 0, tag: "button", role: "", text: "Go", selector: "main > button", html: "<button>Go</button>" };
  const firstSend = { text: "Make this one bigger", pointed: [pointed], sendId: "room-pick-first-0001" };
  const sent = await api(`/api/groups/${group.id}/messages`, firstSend);
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  expect(sent.body.message).toMatchObject({ role: "user", text: "Make this one bigger", pointed: [{ appId: page.id }] });
  await expect.poll(() => evidence(designer.id).length, { timeout: 30_000 }).toBe(designerTurns + 1);
  await settled(designer.id);
  const prompt = JSON.stringify(evidence(designer.id).at(-1).prompt);
  expect(prompt).toContain("While writing this message the person pointed at parts of your page.");
  expect(prompt).toContain(`Page app_id \\"${page.id}\\" (now version 1); the person was looking at version 1.`);
  expect(prompt).toContain("1. <button>; text: Go; selector: main > button; html: <button>Go</button>");
  expect(evidence(helper.id).length).toBe(helperTurns);

  // A plain line still goes to the room's default responder, and carries no pick.
  expect((await api(`/api/groups/${group.id}/messages`, { text: "Thanks" })).status).toBe(202);
  await expect.poll(() => evidence(helper.id).length, { timeout: 30_000 }).toBe(helperTurns + 1);
  await settled(helper.id);
  expect(JSON.stringify(evidence(helper.id).at(-1).prompt)).not.toContain("pointed at parts of your page");
  expect(evidence(designer.id).length).toBe(designerTurns + 1);

  // A pick must name a page in this room, and a goal is a plain typed line.
  expect((await api(`/api/groups/${group.id}/messages`, { text: "This", pointed: [{ ...pointed, appId: "not-a-page" }] })).status).toBe(404);
  expect((await api(`/api/groups/${group.id}/messages`, { text: "This", mode: "goal", pointed: [pointed] })).status).toBe(400);

  // A pick whose page bot is on hold would reach no one, so it is refused until the bot may answer again.
  expect((await api(`/api/groups/${group.id}/holds`, { botId: designer.id, held: true })).status).toBeLessThan(300);
  const held = await api(`/api/groups/${group.id}/messages`, { text: "This", pointed: [pointed] });
  expect(held.status, JSON.stringify(held.body)).toBe(409);
  expect(held.body.error).toContain("on hold");
  expect(evidence(designer.id).length).toBe(designerTurns + 1);
  // A retry of a pick the room already took keeps its receipt, even with the page's bot on hold now.
  const retried = await api(`/api/groups/${group.id}/messages`, firstSend);
  expect(retried.status, JSON.stringify(retried.body)).toBe(202);
  expect(retried.body.message?.id).toBe(sent.body.message.id);

  // A pick queued behind a busy room whose page bot goes on hold before it runs is reported, never silently lost.
  expect((await api(`/api/groups/${group.id}/holds`, { botId: designer.id, held: false })).status).toBeLessThan(300);
  const readyFile = join(fixture.info.dataDir, "helper-ready"), gateFile = join(fixture.info.dataDir, "helper-gate");
  writeFileSync(planPath, JSON.stringify({ [designer.id]: { steps: [], reply: "Done." }, [helper.id]: { steps: [], reply: "Done.", readyFile, gateFile } }));
  expect((await api(`/api/groups/${group.id}/messages`, { text: "Plan the week" })).status).toBe(202);
  await expect.poll(() => existsSync(readyFile), { timeout: 30_000 }).toBe(true);
  const queued = await api(`/api/groups/${group.id}/messages`, { text: "Make this one round", pointed: [pointed] });
  expect(queued.status, JSON.stringify(queued.body)).toBe(202);
  expect(queued.body.queued).toBe(true);
  expect((await api(`/api/groups/${group.id}/holds`, { botId: designer.id, held: true })).status).toBeLessThan(300);
  writeFileSync(gateFile, "go");
  await settled(helper.id);
  await expect.poll(async () => (await transcript()).some((message) => message.kind === "activity" && String(message.tool?.name).includes("what you pointed at in its page wasn't sent")), { timeout: 30_000 }).toBe(true);
  expect(evidence(designer.id).length).toBe(designerTurns + 1);
}, 120_000);
