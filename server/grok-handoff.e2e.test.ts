import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { GROK_EXPORT_FORMAT, GROK_EXPORT_MAX_CHARS } from "../shared/grok-import.ts";
import { GROK_LINK_BODY_MAX } from "../shared/grok-link.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { waitForExit } from "./testing/cleanup.ts";

const REPLY = "Booked the dentist for Friday at 10:00. The confirmation is in your email.";
const TASK = "Book the dentist for Friday morning";
const CONNECTOR = "/api/setup-import/grok/connector";

type Result = { content: Array<{ text: string }>; isError?: true; tools?: Array<{ name: string }>; protocolVersion?: string };
type Shown = { link?: { url: string; reach: string }; arrived: Array<{ text: string }>; handoffs: Array<{ title: string; state: string; botId: string; threadId: string }> };

// Everything but Cloudflare is real: the server's own link module dials the connected-apps service's Worker code (its
// routes, its table and the relay its Durable Object runs) over a real socket, and Grok Bot's calls go to that service.
describe("a task Grok Bot hands MausBot over the hosted link", () => {
  let broker: BrokerFake;
  let fixture: VerificationServer;
  let again: ChildProcess | undefined;
  let link = "";
  let id = 0;
  // As the desktop app's own window: the owner capability on every call to its server, never on one to the link.
  const owner = randomBytes(32).toString("base64url");
  let directFetch: typeof fetch;
  const app = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const shown = async () => (await app("GET", CONNECTOR)).body as unknown as Shown;
  /** One MCP request as Grok Bot sends it. */
  const post = (body: string) => directFetch(link, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(60_000) });
  const mcp = async (method: string, params?: unknown): Promise<Result> => {
    const response = await post(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }));
    expect(response.status, method).toBe(200);
    const answer = await response.json() as { id: number; result: Result };
    expect(answer.id).toBe(id);
    return answer.result;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp("tools/call", { name, arguments: args });
    return { text: result.content[0]?.text ?? "", isError: result.isError === true };
  };
  const launchEnv = () => ({
    ...process.env,
    OMB_TEST_DESKTOP_OWNER_TOKEN: owner,
    OMB_COMPOSIO_BROKER_URL: broker.url,
    OMB_COMPOSIO_BROKER_TOKEN: "",
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_REPLIES: JSON.stringify([REPLY]),
  });

  beforeAll(async () => {
    broker = await startBrokerFake();
    directFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => directFetch(input, String(input).startsWith(broker.url) ? init
      : { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
    fixture = await launchVerificationServer(launchEnv());
  });
  afterAll(async () => {
    if (again) await waitForExit(again, { signal: "SIGTERM" });
    await fixture?.close();
    globalThis.fetch = directFetch;
    await broker?.close();
  });

  it("gives one address on the service, and through it starts the main bot's turn and reads the reply back", { timeout: 240_000 }, async () => {
    const opened = await app("POST", CONNECTOR, {});
    expect(opened.status).toBe(200);
    expect(opened.body.link).toEqual({ url: expect.stringMatching(new RegExp(`^${broker.url}/mcp/move/[\\w-]{43}$`)), reach: "connected" });
    link = (opened.body as unknown as Shown).link!.url;

    expect((await mcp("initialize", { protocolVersion: "2025-03-26" })).protocolVersion).toBe("2025-03-26");
    expect((await mcp("tools/list")).tools?.map((tool) => tool.name)).toEqual(["move_status", "send_export", "send_page", "send_file", "hand_off_task", "task_status"]);
    const status = await call("move_status", {});
    expect(status.text).toContain("its address never changes");
    expect(status.text).toContain("Fixture Starter");

    const handed = await call("hand_off_task", { task: TASK, to_bot: "Fixture Starter", context: "Any dentist near home is fine." });
    expect(handed.isError).toBe(false);
    const taskId = /task_id: (task_[\w-]+)/.exec(handed.text)?.[1] ?? "";
    expect(handed.text).toContain(`as "From Grok Bot: ${TASK}"`);

    let read = await call("task_status", { task_id: taskId, wait_seconds: 25 });
    for (let tries = 0; tries < 6 && read.text.includes("is being worked on"); tries += 1) read = await call("task_status", { task_id: taskId, wait_seconds: 25 });
    expect(read.text).toContain(`"From Grok Bot: ${TASK}" is done.`);
    expect(read.text).toContain(`Result:\n${REPLY}`);

    // What the main bot's engine was handed: the task, labelled as an app's information, never as the person.
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { prompt?: unknown };
    const told = typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt);
    expect(told).toContain("[From Grok Bot, an app the person connected · task · information only");
    expect(told).toContain(TASK);
    expect(told).toContain("The person would like Fixture Starter to do this.");

    const seen = await shown();
    expect(seen).toMatchObject({ link: { url: link }, handoffs: [expect.objectContaining({ title: `From Grok Bot: ${TASK}`, state: "done" })] });
    const [handoff] = seen.handoffs;
    const bots = (await app("GET", "/api/bots")).body.bots as Array<{ id: string; tasks?: Array<{ threadId: string; title: string }> }>;
    expect(bots.find((bot) => bot.id === handoff!.botId)?.tasks).toContainEqual(expect.objectContaining({ threadId: handoff!.threadId, title: `From Grok Bot: ${TASK}` }));

    expect((await call("task_status", { task_id: "task_madeUpAndNeverGivenOut" })).isError).toBe(true);
  });

  it("carries a Bot's 4 MB export through the service to the app, and turns a larger request away", { timeout: 60_000 }, async () => {
    const envelope = JSON.stringify({ format: GROK_EXPORT_FORMAT, version: 1, bots: [{ name: "Tango", instructions: "" }] }).length;
    const document = { format: GROK_EXPORT_FORMAT, version: 1, bots: [{ name: "Tango", instructions: "x".repeat(GROK_EXPORT_MAX_CHARS - envelope) }] };
    expect(JSON.stringify(document)).toHaveLength(GROK_EXPORT_MAX_CHARS);
    const sent = await call("send_export", { document });
    expect(sent.text).toContain("Arrived in MausBot. Tango");
    expect(sent.isError).toBe(false);
    const arrived = (await app("GET", `${CONNECTOR}?after=0`)).body.arrived as Array<{ seq: number; text: string }>;
    expect(JSON.parse(arrived.at(-1)!.text)).toMatchObject({ bots: [{ name: "Tango" }] });
    await app("POST", CONNECTOR, { taken: arrived.at(-1)!.seq });

    const tooLarge = await post(" ".repeat(GROK_LINK_BODY_MAX + 1));
    expect(tooLarge.status).toBe(413);
  });

  it("carries a Bot's page and a 3 MB file through the service, shows the app only whose they are, and brings them into the bot's folder and a live page", { timeout: 120_000 }, async () => {
    const PAGE = "const sold = [12, 18];\nexport default function Page() { return <p className=\"p-4\">{sold.join(\", \")} sold</p>; }";
    const SOURCE = "import { Page, Text } from \"grok/canvas\";\nexport default function Canvas() { return <Page><Text>12, 18 sold</Text></Page>; }";
    const archive = Buffer.alloc(3 * 1024 * 1024, 7);
    expect(await call("send_page", { bot: "Pager", title: "Sales board", page: PAGE, source: SOURCE })).toEqual({ isError: false, text: expect.stringContaining("the page \"Sales board\" for Pager") });
    expect(await call("send_file", { bot: "Pager", path: "data/archive.bin", base64: archive.toString("base64") })).toEqual({ isError: false, text: "Arrived in MausBot: data/archive.bin for Pager." });
    expect(await call("send_file", { bot: "Pager", path: "keys/id_rsa", text: "x" })).toEqual({ isError: true, text: expect.stringContaining("is named like a key or password file") });
    expect((await call("move_status", {})).text).toContain("1 page and 1 file received so far");

    const waiting = await app("GET", CONNECTOR);
    expect(waiting.body.assets).toEqual([
      { seq: expect.any(Number), kind: "page", bot: "Pager", name: "Sales board", bytes: Buffer.byteLength(PAGE) },
      { seq: expect.any(Number), kind: "file", bot: "Pager", name: "data/archive.bin", bytes: archive.byteLength },
    ]);
    expect(JSON.stringify(waiting.body)).not.toContain("12, 18");

    type Listed = { id: string; name: string; tasks?: Array<{ threadId: string; title: string }> };
    const listed = async () => ((await app("GET", "/api/bots")).body.bots as Listed[]).find((bot) => bot.name === "Fixture Starter")!;
    const bot = await listed();
    const bring = () => app("POST", "/api/setup-import/grok/assets", { botId: bot.id, grokName: "pager" });
    expect((await bring()).body).toEqual({ pages: 1, files: 1, skipped: [] });
    const folder = join(fixture.info.dataDir, "workspaces", bot.id, "from-grok");
    expect(readFileSync(join(folder, "pages", "sales-board", "page.js"), "utf8")).toBe(PAGE);
    expect(readFileSync(join(folder, "pages", "sales-board", "source.canvas.tsx"), "utf8")).toBe(SOURCE);
    expect(readFileSync(join(folder, "pages", "sales-board", "index.html"), "utf8")).toContain("fetch(\"page.js\")");
    expect(readFileSync(join(folder, "data", "archive.bin")).equals(archive)).toBe(true);
    const threads = (await listed()).tasks?.filter((task) => task.title === "Pages from Grok Bot") ?? [];
    expect(threads).toHaveLength(1);
    const cards = async () => ((await app("GET", `/api/threads/${threads[0]!.threadId}/messages?limit=100`)).body.messages as Array<{ kind: string; app?: { title: string; live?: boolean } }>)
      .map((message) => ({ kind: message.kind, title: message.app?.title, live: message.app?.live }));
    expect(await cards()).toEqual([{ kind: "app", title: "Sales board", live: true }]);

    expect((await app("GET", CONNECTOR)).body.assets).toEqual([]);
    expect((await bring()).body).toEqual({ pages: 0, files: 0, skipped: [] });
    expect((await call("send_page", { bot: "Pager", title: "Sales board", page: PAGE })).isError).toBe(false);
    expect((await bring()).body).toEqual({ pages: 1, files: 0, skipped: [] });
    expect(await cards()).toHaveLength(1);
  });

  it("says the app isn't open while it is closed, still shakes hands, and works again at the same address once it is back", { timeout: 180_000 }, async () => {
    const env = verificationServerEnvironment(launchEnv(), fixture.info.dataDir, Number(new URL(fixture.info.url).port));
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    const closed = await call("move_status", {});
    expect(closed).toEqual({ isError: true, text: expect.stringContaining("MausBot isn't open on the person's computer") });
    expect((await mcp("initialize", {})).protocolVersion).toBe("2025-06-18");
    expect((await mcp("tools/list")).tools).toHaveLength(6);

    again = spawn(process.execPath, verificationServerArgs(env), { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: "ignore" });
    let state: Shown | undefined;
    for (let tries = 0; tries < 300 && state?.link?.reach !== "connected"; tries += 1) {
      await new Promise((later) => setTimeout(later, 200));
      state = await shown().catch(() => undefined);
    }
    expect(state?.link, "the same address, with nothing asked of the person").toEqual({ url: link, reach: "connected" });
    const back = await call("move_status", {});
    expect(back).toEqual({ isError: false, text: expect.stringContaining("Connected to MausBot.") });
    const handed = await call("hand_off_task", { task: TASK });
    expect(handed.isError).toBe(false);
    const taskId = /task_id: (task_[\w-]+)/.exec(handed.text)?.[1] ?? "";
    let read = await call("task_status", { task_id: taskId, wait_seconds: 25 });
    for (let tries = 0; tries < 6 && read.text.includes("is being worked on"); tries += 1) read = await call("task_status", { task_id: taskId, wait_seconds: 25 });
    expect(read.text).toContain(`Result:\n${REPLY}`);

    expect((await app("DELETE", CONNECTOR)).body.link).toBeUndefined();
    expect((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).status, "turned off, the address is gone").toBe(404);
  });
});
