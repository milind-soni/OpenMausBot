// End to end on the fakes: a scripted bot on a real server shows a folder page, the person saves it as an app through the
// real routes and sign-in gate, the bot replaces the page and the app follows, and the app and its files outlive the chat.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
}, 90_000);
afterAll(async () => { await fixture?.close(); });

it("saves a shown page as an app that follows its newest version and outlives its chat, files and all", async () => {
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, { ...init, headers: { "content-type": "application/json" } });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const bot = (await cli("new-bot", "--name", "Builder")).bot;
  const threadId = (await api(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Dashboards" }) })).body?.task?.threadId
    ?? bot.activeTaskId as string;
  const folder = join(fixture.info.dataDir, "workspaces", bot.id, "dash");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "index.html"), "<h1>Sales</h1><script src=\"app.js\"></script>");
  writeFileSync(join(folder, "data.csv"), "region,total\nNorth,12");
  const plan = (steps: Array<{ tool: string; arguments: unknown }>) => writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply: "Done." } }));
  const settled = async () => expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");

  plan([{ tool: "show_html", arguments: { html: "<h1>Sales v1</h1>", title: "Sales board" } }]);
  await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Make me a sales board.");
  await settled();
  const messages = (await api(`/api/threads/${threadId}/messages?limit=50`)).body.messages as any[];
  const page = messages.find((message) => message.kind === "app");
  expect(page?.app?.title).toBe("Sales board");

  const saved = await api("/api/local-apps", { method: "POST", body: JSON.stringify({ botId: bot.id, threadId, messageId: page.id }) });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  const id = saved.body.app.id as string;
  // A fresh server already lists the starter apps, after the one just saved.
  expect((await api("/api/local-apps")).body.apps.map((app: any) => app.sample ? "sample" : app.id)).toEqual([id, "sample", "sample", "sample", "sample"]);

  plan([{ tool: "update_html", arguments: { app_id: page.id, html: "<h1>Sales v2</h1>" } }]);
  await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Bigger heading please.");
  await settled();
  const followed = await api(`/api/local-apps/${id}`);
  expect(followed.body.app).toMatchObject({ rev: 1, versions: [{ rev: 0 }, { rev: 1 }] });
  expect((await api(`/api/local-apps/${id}/app`)).body.srcdoc).toContain("Sales v2");

  plan([{ tool: "show_html", arguments: { path: folder, title: "Dash" } }]);
  await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Now from the folder.");
  await settled();
  const dash = ((await api(`/api/threads/${threadId}/messages?limit=50`)).body.messages as any[]).find((message) => message.kind === "app" && message.app.title === "Dash");
  expect(dash).toBeTruthy();
  {
    const folderApp = (await api("/api/local-apps", { method: "POST", body: JSON.stringify({ botId: bot.id, threadId, messageId: dash.id }) })).body.app.id as string;
    const doc = (await api(`/api/local-apps/${folderApp}/app?origin=${encodeURIComponent(fixture.info.url)}`)).body;
    const files = /<base href="([^"]+)"/.exec(doc.srcdoc)?.[1];
    expect(files).toMatch(/\/api\/local-app-files\/[\w-]{43}\/$/);
    const csv = await fetch(`${files}data.csv`);
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain("North,12");
  }

  expect((await api(`/api/bots/${bot.id}/tasks/${threadId}`, { method: "DELETE" })).status).toBeLessThan(300);
  const after = await api(`/api/local-apps/${id}`);
  expect(after.body.app).toMatchObject({ id, chat: false });
  expect((await api(`/api/local-apps/${id}/app`)).body.srcdoc).toContain("Sales v2");
  expect((await api(`/api/local-apps/${id}`, { method: "DELETE" })).body).toEqual({ ok: true });
  expect((await api(`/api/local-apps/${id}`)).status).toBe(404);
}, 120_000);
