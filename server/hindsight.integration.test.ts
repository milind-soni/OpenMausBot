// Real HTTP harness + a disposable Hindsight service and the repository's
// fake Claude CLI. No user's app, provider account, or memory bank is used.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SECRET = "hindsight-fixture-secret-never-public";
const REPLY = "hello from fake claude";
interface MemoryRequest {
  bank: string;
  path: string;
  method: string;
  authorization?: string;
  body: any;
}

describe("Hindsight direct conversations (isolated HTTP integration)", () => {
  let child: ChildProcess;
  let hindsight: Server;
  let home: string;
  let base: string;
  let memoryBase: string;
  let dump: string;
  let replyCount: string;
  let events: SseRecorder;
  let stderr = "";
  const signals = new EventEmitter();
  const requests: MemoryRequest[] = [];
  const failures = new Map<string, number>();
  const heldBanks = new Set<string>();
  const heldResponses = new Map<MemoryRequest, ServerResponse>();

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === id);
  const view = async (id: string) => (await api("GET", `/api/bots/${id}/hindsight`)).body;
  const forBank = (bank: string, path?: string) => requests.filter((request) => request.bank === bank && (!path || request.path === path));
  const dispatched = () => existsSync(replyCount) ? Number(readFileSync(replyCount, "utf8")) : 0;
  const recallResult = (bank: string) => ({ results: [{ text: `private-memory-for-${bank}` }] });
  const respond = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const releaseRecall = (bank: string, query?: string) => {
    for (const [request, response] of heldResponses) {
      if (request.bank !== bank || (query !== undefined && request.body.query !== query)) continue;
      if (!response.destroyed) respond(response, 200, recallResult(bank));
      heldResponses.delete(request);
    }
    if (query === undefined) heldBanks.delete(bank);
  };
  const untilSignal = (predicate: () => boolean, what: string) => new Promise<void>((resolve, reject) => {
    if (predicate()) return resolve();
    const cleanup = () => { clearTimeout(timer); signals.off("change", check); };
    const check = () => { if (predicate()) { cleanup(); resolve(); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${what}. ${stderr.slice(-2000)}`)); }, 20_000);
    signals.on("change", check);
  });
  const waitRequest = (bank: string, path: string, count = 1) =>
    untilSignal(() => forBank(bank, path).length >= count, `${bank}${path} request ${count}`);
  const waitSettled = (id: string, since: number) => events.until((frame) =>
    events.frames.indexOf(frame) >= since && frame.kind === "bot" && frame.bot?.id === id && frame.bot?.busy === false);
  const waitThreadSettled = (id: string, threadId: string) => expect.poll(async () =>
    (await getBot(id)).tasks.find((task: any) => task.threadId === threadId)?.busy, { timeout: 10_000 }).toBe(false);
  const threadMessages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;
  const createBot = async (name: string) => {
    const created = await api("POST", "/api/bots", {
      name, modelSelection: { instanceId: "claude", model: "claude-fake" },
    });
    expect(created.status).toBe(201);
    return created.body.bot;
  };
  const configure = async (id: string, bankId: string, extra: Record<string, unknown> = {}) => {
    const configured = await api("PUT", `/api/bots/${id}/hindsight`, {
      enabled: true, baseUrl: memoryBase, bankId, ...extra,
    });
    expect(configured.status).toBe(200);
    return configured.body;
  };
  const concurrentRecalls = async (bank: string) => {
    const bot = await createBot("Concurrent memory owner");
    await configure(bot.id, bank);
    const second = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling conversation" });
    expect(second.status).toBe(201);
    const turns = [
      { threadId: bot.threadId, text: `Question A for ${bank}` },
      { threadId: second.body.task.threadId, text: `Question B for ${bank}` },
    ];
    heldBanks.add(bank);
    for (const [index, turn] of turns.entries()) {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, turn)).status).toBe(202);
      await waitRequest(bank, "/memories/recall", index + 1);
    }
    expect((await getBot(bot.id)).tasks.filter((task: any) => task.busy)).toHaveLength(2);
    return { bot, turns };
  };
  const send = async (id: string, text: string) => {
    const previous = (await getBot(id)).messages.length;
    const since = events.frames.length;
    expect((await api("POST", `/api/bots/${id}/messages`, { text })).status).toBe(202);
    await events.until((frame) => events.frames.indexOf(frame) >= since && frame.kind === "message"
      && frame.message?.role === "bot" && frame.message?.text === REPLY);
    await waitSettled(id, since);
    const bot = await getBot(id);
    expect(bot.messages.slice(previous).some((message: any) => message.role === "bot" && message.kind === "text" && message.text === REPLY)).toBe(true);
    return bot;
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-hindsight-integration-"));
    const dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir);
    const fakeCli = join(home, "fake-claude-cli.ts");
    copyFileSync(join(SERVER_DIR, "testing", "fake-claude-cli.ts"), fakeCli);
    chmodSync(fakeCli, 0o755);
    dump = join(home, "provider-prompt.json");
    replyCount = join(home, "provider-replies.txt");
    const instance = {
      driver: "claudeAgent",
      environment: { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_REPLY_STATE: replyCount },
      config: { cli: fakeCli, permissionMode: "bypassPermissions" },
    };
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { claude: instance, second: instance } }));
    hindsight = createServer(async (request, response) => {
      const match = request.url?.match(/^\/v1\/default\/banks\/([^/]+)(\/.*)$/);
      if (!match) return respond(response, 404, { error: "unknown route" });
      const bank = decodeURIComponent(match[1]);
      const path = match[2];
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const recorded: MemoryRequest = { bank, path, method: request.method!, authorization: request.headers.authorization, body };
      requests.push(recorded);
      signals.emit("change");
      const failure = failures.get(`${bank}${path}`);
      if (failure) return respond(response, failure, { error: `untrusted failure echo ${SECRET}` });
      if (path === "/config") return respond(response, 200, { bank_id: bank, config: {}, overrides: {} });
      if (path === "/memories/recall") {
        if (heldBanks.has(bank)) {
          heldResponses.set(recorded, response);
          return;
        }
        return respond(response, 200, recallResult(bank));
      }
      if (path === "/memories") return respond(response, 200, {
        success: true, async: true, bank_id: bank, items_count: 1, operation_id: body.operation_id,
      });
      return respond(response, 404, { error: "unknown route" });
    });
    await new Promise<void>((resolve) => hindsight.listen(0, "127.0.0.1", resolve));
    const address = hindsight.address();
    if (!address || typeof address === "string") throw new Error("Missing fake Hindsight port");
    memoryBase = `http://127.0.0.1:${address.port}`;
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    let stdout = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; signals.emit("change"); });
    await untilSignal(() => stdout.includes(`openmausbot server on ${base}`), "the isolated harness's listening event");
    expect((await fetch(`${base}/api/health`)).ok).toBe(true);
    events = await openSse(`${base}/api/events`);
  }, 30_000);

  afterEach(() => {
    for (const bank of heldBanks) releaseRecall(bank);
    failures.clear();
  });
  afterAll(async () => {
    events?.close();
    await waitForExit(child, { signal: "SIGTERM" });
    if (hindsight) {
      hindsight.closeAllConnections();
      await new Promise<void>((resolve) => hindsight.close(() => resolve()));
    }
    if (home) await removeTempDir(home);
  });

  it("keeps credentials write-only, tests the existing bank, and clears credentials when its target changes", async () => {
    const bot = await createBot("Secret owner");
    const events = await openSse(`${base}/api/events`);
    try {
      expect(await configure(bot.id, "secret-bank", { apiKey: SECRET })).toMatchObject({ apiKeyConfigured: true });
      expect((await api("POST", `/api/bots/${bot.id}/hindsight/test`, {})).body).toMatchObject({ connection: { ok: true } });
      expect(forBank("secret-bank")).toMatchObject([{ method: "GET", path: "/config", authorization: `Bearer ${SECRET}` }]);
      await api("PATCH", `/api/bots/${bot.id}`, { name: "Secret owner renamed" });
      await events.until((frame) => frame.kind === "bot" && frame.bot?.id === bot.id && frame.bot?.name === "Secret owner renamed");
      const publicData = [await getBot(bot.id), (await api("GET", "/api/config")).body, await view(bot.id), events.frames];
      expect(JSON.stringify(publicData)).not.toContain(SECRET);
      expect(JSON.stringify(publicData)).not.toContain("hindsightBots");
      expect(await configure(bot.id, "secret-bank", { enabled: false })).toMatchObject({ apiKeyConfigured: true });
      expect(await configure(bot.id, "changed-bank")).toMatchObject({ apiKeyConfigured: false });
      await configure(bot.id, "changed-bank", { apiKey: SECRET });
      expect(await configure(bot.id, "changed-bank", { apiKey: null })).toMatchObject({ apiKeyConfigured: false });
    } finally { events.close(); }
  });

  it("refuses Hindsight settings access to a paired client without admin scope", async () => {
    const bot = await createBot("Admin-only memory");
    await configure(bot.id, "admin-bank");
    const pairing = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
    expect(pairing.status).toBe(200);
    // node:http preserves a non-loopback Host; fetch may discard it. All
    // traffic still reaches this suite's owned loopback fixture.
    const remote = (method: string, path: string, body?: unknown, token?: string) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const request = httpRequest(new URL(path, base), {
          method,
          headers: {
            host: "hindsight-fixture.invalid", "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        }, (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { raw += chunk; });
          response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(raw) }));
        });
        request.once("error", reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const paired = await remote("POST", "/api/auth/pair", { code: pairing.body.code, label: "Client fixture" });
    expect(paired.status).toBe(200);
    expect((await remote("GET", "/api/bots", undefined, paired.body.token)).status).toBe(200);
    for (const method of ["GET", "PUT", "DELETE", "POST"]) {
      const path = `/api/bots/${bot.id}/hindsight${method === "POST" ? "/test" : ""}`;
      const response = await remote(method, path, method === "PUT" ? { enabled: false } : undefined, paired.body.token);
      expect(response.status).toBe(403);
      expect(response.body.error).toContain("admin");
    }
    expect(await view(bot.id)).toMatchObject({ enabled: true, bankId: "admin-bank" });
    expect(forBank("admin-bank")).toHaveLength(0);
  });

  it("rejects sharing a bank between bots and never sends one bot's recalled context into another bot", async () => {
    const first = await createBot("Bank A");
    const second = await createBot("Bank B");
    await configure(first.id, "isolation-a");
    expect((await api("PUT", `/api/bots/${second.id}/hindsight`, {
      enabled: true, baseUrl: `${memoryBase}/`, bankId: "isolation-a",
    })).status).toBe(409);
    await configure(second.id, "isolation-b");
    for (const [bot, own, other] of [[first, "isolation-a", "isolation-b"], [second, "isolation-b", "isolation-a"]] as const) {
      const text = `Question for ${own}`;
      const current = await send(bot.id, text);
      const prompt = JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt);
      expect(prompt).toContain(`private-memory-for-${own}`);
      expect(prompt).not.toContain(`private-memory-for-${other}`);
      expect(current.messages.find((message: any) => message.role === "user" && message.text === text)).toBeDefined();
      expect(JSON.stringify(current.messages)).not.toContain("private-memory-for-");
      await waitRequest(own, "/memories");
      expect(forBank(own, "/memories")[0].body.items[0].metadata.bot_id).toBe(bot.id);
    }
  }, 40_000);

  it("retains only the successful direct user/reply pair, excluding recall and earlier conversation", async () => {
    const bot = await createBot("Pair owner");
    await send(bot.id, "Old conversation must not be retained again");
    await configure(bot.id, "pair-bank");
    await send(bot.id, "Remember this new direct question");
    await waitRequest("pair-bank", "/memories");
    // Private operation status has no public SSE event. Poll only this
    // observable condition; a sent HTTP response alone cannot prove it.
    await expect.poll(async () => (await view(bot.id)).retain?.ok, { timeout: 10_000 }).toBe(true);
    const retained = forBank("pair-bank", "/memories");
    expect(retained).toHaveLength(1);
    expect(retained[0].body).toMatchObject({ async: true, items: [{
      content: `User: Remember this new direct question\n\nAssistant (Pair owner): ${REPLY}`,
      metadata: { bot_id: bot.id },
    }] });
    expect(retained[0].body.items).toHaveLength(1);
    expect(JSON.stringify(retained)).not.toMatch(/private-memory-for-|Old conversation|Bash/);
    const operations = forBank("pair-bank");
    const existenceCheck = operations.findIndex((request) => request.method === "GET" && request.path === "/config");
    expect(existenceCheck).toBeGreaterThanOrEqual(0);
    expect(existenceCheck).toBeLessThan(operations.findIndex((request) => request.path === "/memories"));
  }, 40_000);

  it("preserves a bot's bank across a new task and model change", async () => {
    const bot = await createBot("Stable identity");
    await configure(bot.id, "stable-bank");
    await send(bot.id, "First task");
    await waitRequest("stable-bank", "/memories");
    const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Next task" });
    expect(created.status).toBe(201);
    expect(created.body.bot.threadId).not.toBe(bot.threadId);
    expect((await api("PATCH", `/api/bots/${bot.id}/model`, { instanceId: "second", model: "claude-sonnet-5" })).status).toBe(200);
    expect(await view(bot.id)).toMatchObject({ enabled: true, bankId: "stable-bank" });
    await send(bot.id, "Second task with another engine");
    await waitRequest("stable-bank", "/memories", 2);
    expect(forBank("stable-bank", "/memories").map((request) => request.body.items[0].metadata.thread_id))
      .toEqual([bot.threadId, created.body.bot.threadId]);
  }, 40_000);

  it("does not contact memory while disabled or disconnected, and deleting a bot clears only its local connection", async () => {
    const bot = await createBot("Disabled owner");
    await configure(bot.id, "disabled-bank", { enabled: false });
    await send(bot.id, "Memory is off");
    expect(forBank("disabled-bank")).toHaveLength(0);
    expect((await api("DELETE", `/api/bots/${bot.id}/hindsight`)).status).toBe(200);
    expect(await view(bot.id)).toMatchObject({ enabled: false, apiKeyConfigured: false });
    await send(bot.id, "Memory was disconnected");
    expect(forBank("disabled-bank")).toHaveLength(0);
    await configure(bot.id, "deleted-bank", { apiKey: SECRET });
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    const stored = JSON.parse(readFileSync(join(home, ".openmausbot", "config.json"), "utf8"));
    expect(stored.hindsightBots?.[bot.id]).toBeUndefined();
    expect(forBank("deleted-bank")).toHaveLength(0);
  }, 40_000);

  it("does not copy external memory authority through bot duplication or backup import", async () => {
    const source = await createBot("Memory source");
    await configure(source.id, "source-only-bank", { apiKey: SECRET });
    // This is the UI's duplicateBot flow: create, then copy profile/model.
    const copy = await createBot("Memory source copy");
    expect((await api("PATCH", `/api/bots/${copy.id}`, { description: source.description, modelSelection: source.modelSelection })).status).toBe(200);
    expect(await view(copy.id)).toMatchObject({ enabled: false, apiKeyConfigured: false });
    const backup = await api("POST", "/api/teams/export", { format: "backup", name: "Memory isolation backup" });
    expect(backup.status).toBe(200);
    expect(JSON.stringify(backup.body)).not.toMatch(/source-only-bank|hindsightBots|hindsight-fixture-secret/);
    const imported = await api("POST", "/api/teams/import", backup.body);
    expect(imported.status).toBe(201);
    expect(imported.body.bots.length).toBeGreaterThan(0);
    for (const bot of imported.body.bots) {
      expect(bot.id).not.toBe(source.id);
      expect(await view(bot.id)).toMatchObject({ enabled: false, apiKeyConfigured: false });
    }
    expect(await view(source.id)).toMatchObject({ enabled: true, bankId: "source-only-bank", apiKeyConfigured: true });
  });

  it("continues the provider reply when recall or retain fails and reports only safe operation status", async () => {
    const bot = await createBot("Failure owner");
    await configure(bot.id, "failure-bank", { apiKey: SECRET });
    failures.set("failure-bank/memories/recall", 503);
    failures.set("failure-bank/memories", 401);
    const current = await send(bot.id, "Answer even if external memory is down");
    expect(current.busy).toBe(false);
    await waitRequest("failure-bank", "/memories");
    await expect.poll(async () => (await view(bot.id)).retain?.ok, { timeout: 10_000 }).toBe(false);
    const status = await view(bot.id);
    expect(status).toMatchObject({ recall: { ok: false, at: expect.any(String) }, retain: { ok: false, at: expect.any(String) } });
    expect(status.recall.message).toContain("503");
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(JSON.stringify(current.messages)).not.toContain(SECRET);
  });

  it("stops a held recall on interrupt, while settings changes allow a reply without stale memory or retain", async () => {
    for (const action of ["interrupt", "settings"] as const) {
      const bot = await createBot(`Cancelled ${action}`);
      const bank = `cancel-${action}`;
      await configure(bot.id, bank);
      const before = dispatched();
      const since = events.frames.length;
      heldBanks.add(bank);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Do not dispatch after cancellation" })).status).toBe(202);
      await waitRequest(bank, "/memories/recall");
      if (action === "interrupt") expect((await api("POST", `/api/bots/${bot.id}/interrupt`, {})).status).toBe(200);
      else await configure(bot.id, bank, { enabled: false });
      releaseRecall(bank);
      await waitSettled(bot.id, since);
      expect(dispatched()).toBe(before + (action === "settings" ? 1 : 0));
      expect(forBank(bank, "/memories")).toHaveLength(0);
      expect((await getBot(bot.id)).messages.filter((message: any) => message.role === "bot" && message.text === REPLY))
        .toHaveLength(action === "settings" ? 1 : 0);
      if (action === "settings") {
        expect(JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt)).not.toContain(`private-memory-for-${bank}`);
      }
    }
  }, 40_000);

  it("recalls and retains both simultaneous conversations of one bot without mixing their turns", async () => {
    const bank = "concurrent-pairs";
    const { bot, turns } = await concurrentRecalls(bank);
    for (const [index, turn] of turns.entries()) {
      releaseRecall(bank, turn.text);
      await waitThreadSettled(bot.id, turn.threadId);
      const prompt = JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt);
      expect(prompt).toContain(`private-memory-for-${bank}`);
      expect(prompt).toContain(turn.text);
      expect(prompt).not.toContain(turns[1 - index].text);
      await waitRequest(bank, "/memories", index + 1);
      const retained = forBank(bank, "/memories")[index].body.items[0];
      expect(retained).toMatchObject({
        content: `User: ${turn.text}\n\nAssistant (${bot.name}): ${REPLY}`,
        metadata: { bot_id: bot.id, thread_id: turn.threadId },
      });
      const messages = await threadMessages(turn.threadId);
      expect(messages.some((message: any) => message.role === "bot" && message.text === REPLY)).toBe(true);
      expect(JSON.stringify(messages)).not.toContain("private-memory-for-");
    }
    expect(forBank(bank, "/memories")).toHaveLength(2);
  }, 40_000);

  it("uses only the queued user's words after capacity frees, keeping reply quotes out of external memory", async () => {
    const bank = "capacity-reply";
    const bot = await createBot("Queued memory owner");
    const earlier = "Earlier conversation must stay out of this memory exchange";
    await send(bot.id, earlier);
    const quoted = (await threadMessages(bot.threadId)).find((message: any) => message.text === earlier);
    await configure(bot.id, bank);
    const sibling = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Occupies the only slot" });
    expect(sibling.status).toBe(201);
    const activeThread = sibling.body.task.threadId;
    expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
    try {
      heldBanks.add(bank);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, {
        threadId: activeThread, text: "A separate active question",
      })).status).toBe(202);
      await waitRequest(bank, "/memories/recall");
      const current = ["The current reply", "A second queued message"];
      for (const [index, text] of current.entries()) {
        const queued = await api("POST", `/api/bots/${bot.id}/messages`, {
          threadId: bot.threadId, text, ...(index === 0 ? { replyToId: quoted.id } : {}),
        });
        expect(queued.status).toBe(202);
        expect(queued.body).toMatchObject({ queued: true, reason: "capacity" });
      }
      expect(forBank(bank, "/memories/recall")).toHaveLength(1);
      expect((await threadMessages(bot.threadId)).filter((message: any) => current.includes(message.text))).toHaveLength(0);
      releaseRecall(bank);
      await waitRequest(bank, "/memories/recall", 2);
      await waitThreadSettled(bot.id, activeThread);
      await waitThreadSettled(bot.id, bot.threadId);
      await waitRequest(bank, "/memories", 2);
      const prompt = JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt);
      expect(prompt).toContain("--- quoted excerpt ---");
      expect(prompt).toContain(earlier);
      expect(forBank(bank, "/memories/recall")[1].body.query).toBe(current.join("\n\n"));
      const retained = forBank(bank, "/memories").find((request) => request.body.items[0].metadata.thread_id === bot.threadId);
      expect(retained?.body.items[0].content).toBe(`User: ${current.join("\n\n")}\n\nAssistant (${bot.name}): ${REPLY}`);
      expect(JSON.stringify(retained)).not.toMatch(/Earlier conversation|quoted excerpt|untrusted conversation|private-memory-for-|Bash/);
    } finally {
      releaseRecall(bank);
      expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 3 } })).status).toBe(200);
    }
  }, 40_000);

  it("stops only the requested conversation's recall while its sibling still recalls and retains", async () => {
    const bank = "concurrent-stop";
    const { bot, turns: [first, second] } = await concurrentRecalls(bank);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: first.threadId })).status).toBe(200);
    await waitThreadSettled(bot.id, first.threadId);
    expect((await getBot(bot.id)).tasks.find((task: any) => task.threadId === second.threadId)?.busy).toBe(true);
    releaseRecall(bank, first.text);
    releaseRecall(bank, second.text);
    await waitThreadSettled(bot.id, second.threadId);
    await waitRequest(bank, "/memories");
    expect(forBank(bank, "/memories")).toHaveLength(1);
    expect(forBank(bank, "/memories")[0].body.items[0]).toMatchObject({
      content: `User: ${second.text}\n\nAssistant (${bot.name}): ${REPLY}`,
      metadata: { bot_id: bot.id, thread_id: second.threadId },
    });
    const prompt = JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt);
    expect(prompt).toContain(`private-memory-for-${bank}`);
    expect(prompt).toContain(second.text);
    expect(prompt).not.toContain(first.text);
    expect((await threadMessages(first.threadId)).some((message: any) => message.role === "bot" && message.text === REPLY)).toBe(false);
    expect((await threadMessages(second.threadId)).some((message: any) => message.role === "bot" && message.text === REPLY)).toBe(true);
  }, 40_000);

  it("invalidates held memory in every conversation when the bot's connection is disabled", async () => {
    const bank = "concurrent-settings";
    const { bot, turns } = await concurrentRecalls(bank);
    await configure(bot.id, bank, { enabled: false });
    releaseRecall(bank);
    await Promise.all(turns.map((turn) => waitThreadSettled(bot.id, turn.threadId)));
    for (const turn of turns) {
      expect((await threadMessages(turn.threadId)).some((message: any) => message.role === "bot" && message.text === REPLY)).toBe(true);
    }
    expect(forBank(bank, "/memories")).toHaveLength(0);
    expect(await view(bot.id)).toMatchObject({ enabled: false });
    expect(JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt)).not.toContain(`private-memory-for-${bank}`);
  }, 40_000);

  it("does not recall or retain a bot's private bank for a group conversation", async () => {
    const bot = await createBot("Group member");
    await configure(bot.id, "group-private-bank");
    const created = await api("POST", "/api/groups", {
      name: "Memory boundary room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    expect(created.status).toBe(201);
    const groupId = created.body.group.id;
    const since = events.frames.length;
    expect((await api("POST", `/api/groups/${groupId}/messages`, { text: "Reply in this group only" })).status).toBe(202);
    await events.until((frame) => events.frames.indexOf(frame) >= since && frame.kind === "message"
      && frame.threadId === created.body.group.threadId && frame.message?.text === REPLY);
    await waitSettled(bot.id, since);
    expect(forBank("group-private-bank")).toHaveLength(0);
    expect(JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).prompt)).not.toContain("private-memory-for-group-private-bank");
  });
});
