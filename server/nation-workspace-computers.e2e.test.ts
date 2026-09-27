// A member's own workspace gets NATION's cloud computers and the guarded
// browser, through the real HTTP API and real workspace servers:
//   (a) a new account's workspace has computers and a browser and no sharing;
//       its bot works on a cloud computer of its own, and browses behind the
//       egress guard with web addresses only;
//   (b) the founder desk is unchanged;
//   (c) a member still cannot set a provider key, an engine or a computer on
//       this machine, and its workspace answers no one by loopback;
//   (d) two workspaces never see each other's computer or browser.
// Every external service is an owned loopback stand-in: the NATION API model,
// the cloud computer provider (a filesystem per machine), the browser engine
// and Robinhood Chain.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeRobinhoodChain } from "./testing/fake-robinhood-chain.ts";

const FOUNDER = "founder@example.test";
const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const TREASURY = "0x85E3C2D8f776d9D05b14E108F368070CbD8C1639";
const BOX_TOKEN = "box_verification_fixture";
const BOX_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

type Reply = { status: number; body: any; text: string };
const seenByMembers: string[] = [];

/** One browser: its own cookie jar, and the Origin a page on the app sends. */
function browser(base: string) {
  const jar = new Map<string, string>();
  const request = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<Reply> => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(base + path, {
      method: init.method ?? "GET",
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), origin: base, ...(cookie ? { cookie } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      if (attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) jar.delete(name);
      else jar.set(name, pair!.slice(eq + 1).trim());
    }
    const text = await response.text();
    seenByMembers.push(text);
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { status: response.status, body, text };
  };
  return { request };
}

/** A plain http request in proxy form, the way Chrome sends one. */
function viaProxy(proxyUrl: string, target: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: "GET", path: target, headers: { host: new URL(target).host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The status line a CONNECT to host:port gets. */
function tunnelStatus(proxyUrl: string, authority: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.includes("\r\n")) { resolve(Number(data.split(" ")[1])); socket.destroy(); }
    });
    socket.on("error", reject);
  });
}

const jsonLines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

it("gives each member workspace a cloud computer and a guarded browser of its own, and leaves the founder desk as it was", async () => {
  const boxes: Array<{ id: string; name: string; state: string; files: Map<string, string> }> = [];
  const commands: Array<{ box: string; command: string }> = [];
  const stopped: string[] = [];
  // Makes the provider fail the next commands, with its own wording.
  let providerFailing = false;
  const modelRequests: Array<{ tools: any[] }> = [];
  let deskPort = 0;
  let callSeq = 0;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    // NATION API: runs what the person named with the tool it names, then reports.
    if (path.endsWith("/chat/completions")) {
      const tools: any[] = body.tools ?? [];
      const names = tools.map((item) => item.function.name as string);
      modelRequests.push({ tools });
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user" && typeof item.content === "string");
      const ask = String(lastUser?.content ?? "").trim().split("\n").at(-1) ?? "";
      const replies = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1).filter((item: any) => item.role === "tool");
      const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `c-${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      const save = ask.match(/^save (\S+) as (\S+)$/);
      const show = ask.match(/^show (\S+)$/);
      const browse: Record<string, [string, unknown]> = {
        "browse": ["browser_agent_browser_open", { url: "https://example.test/" }],
        "open a file": ["browser_agent_browser_open", { url: "file:///etc/passwd" }],
        "read the desk": ["browser_agent_browser_read", { url: `http://127.0.0.1:${deskPort}/api/config` }],
        "keep a picture": ["browser_agent_browser_screenshot", { path: "/etc/nation-owned.png", screenshotDir: "/etc", fullPage: true }],
        "take a picture": ["browser_agent_browser_screenshot", { fullPage: true }],
      };
      const delta = replies.length === 0 && (save || show) && names.includes("computer_execute")
        ? call("computer_execute", { command: save ? `printf %s ${save[1]} > /root/${save[2]}` : `cat /root/${show![1]}` })
        : replies.length === 0 && browse[ask] && names.includes(browse[ask][0])
          ? call(browse[ask][0], browse[ask][1])
          : { content: `Result: ${replies.map((item: any) => String(item.content)).join(" | ") || "none"}` };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    // Cloud computers: each machine has its own filesystem.
    if (req.headers.authorization !== `Bearer ${BOX_TOKEN}`) return json({ ok: false, code: "unauthorized" }, 401);
    if (path === "/boxes" && req.method === "GET") return json({ ok: true, boxes: boxes.map(({ files: _files, ...box }) => box) });
    if (path === "/boxes" && req.method === "POST") {
      const id = "bx_" + Array.from({ length: 8 }, (_, i) => BOX_ALPHABET[(boxes.length * 7 + i * 3) % BOX_ALPHABET.length]).join("");
      const box = { id, name: body.name ?? "", state: "running", files: new Map<string, string>() };
      boxes.push(box);
      const { files: _files, ...wire } = box;
      return json({ ok: true, box: wire }, 201);
    }
    let m = path.match(/^\/boxes\/(bx_\w{8})$/);
    if (m) {
      const box = boxes.find((item) => item.id === m![1]);
      if (!box) return json({ ok: false, message: "not found" }, 404);
      if (req.method === "PATCH" && body.name) box.name = body.name;
      const { files: _files, ...wire } = box;
      return json({ ok: true, box: wire });
    }
    m = path.match(/^\/boxes\/(bx_\w{8})\/commands$/);
    if (m) {
      const box = boxes.find((item) => item.id === m![1])!;
      const text = String(body.command);
      if (providerFailing) return json({ ok: true, exitCode: 1, stdout: "", stderr: `provider fault on ${box.id} (${box.name})` });
      commands.push({ box: box.id, command: text });
      const write = text.match(/printf %s (\S+) > \/root\/([\w.-]+)/);
      const read = text.match(/cat \/root\/([\w.-]+)/);
      if (write) { box.files.set(write[2]!, write[1]!); return json({ ok: true, exitCode: 0, stdout: "", stderr: "" }); }
      if (read) {
        const content = box.files.get(read[1]!);
        return json({ ok: true, exitCode: content === undefined ? 1 : 0, stdout: content ?? "", stderr: content === undefined ? "no such file" : "" });
      }
      return json({ ok: true, exitCode: 0, stdout: /ogb-panel/.test(text) ? "captured" : "", stderr: "" });
    }
    m = path.match(/^\/boxes\/(bx_\w{8})\/stop$/);
    if (m) {
      stopped.push(m[1]!);
      const box = boxes.find((item) => item.id === m![1]);
      if (box) box.state = "archived";
      return json({ ok: true });
    }
    m = path.match(/^\/boxes\/(bx_\w{8})\/artifacts$/);
    if (m) { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(PNG); return; }
    m = path.match(/^\/boxes\/(bx_\w{8})\/files$/);
    if (m) return json({ ok: true, content: PNG.toString("base64") });
    m = path.match(/^\/boxes\/(bx_\w{8})\/resume$/);
    if (m) {
      const box = boxes.find((item) => item.id === m![1]);
      if (box) box.state = "running";
      return json({ ok: true });
    }
    if (/^\/boxes\/bx_\w{8}\/desktop$/.test(path)) return json({ ok: true, desktopUrl: "https://desktop.invalid/" });
    json({ ok: true });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const chain = await startFakeRobinhoodChain();
  const engine = fileURLToPath(new URL("./testing/fake-agent-browser-core.mjs", import.meta.url));
  const fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath: engine, executablePath: engine },
    undefined, undefined, [], origin, origin, undefined, undefined, undefined, {
      founderEmails: [FOUNDER],
      payments: { rpc: chain.url, treasury: TREASURY, confirmations: 1, scanSeconds: 5 },
    });
  const base = fixture.info.url;
  deskPort = Number(new URL(base).port);
  let closed = false;

  const outbox = join(fixture.info.dataDir, "mail-outbox");
  const signIn = async (who: ReturnType<typeof browser>, email: string) => {
    expect((await who.request("/api/auth/magic/start", { method: "POST", body: { email } })).status).toBe(200);
    const message = readdirSync(outbox).sort().reverse().map((file) => JSON.parse(readFileSync(join(outbox, file), "utf8"))).find((item) => item.to === email);
    const token = decodeURIComponent(String(message.link).split("#login=")[1]!);
    const verified = await who.request("/api/auth/magic/verify", { method: "POST", body: { token, label: "Fixture browser" } });
    expect(verified.body).toMatchObject({ ok: true, destination: "workspace" });
    // As the app does on load: the free plan's starter credit.
    expect((await who.request("/api/credits/status")).body).toMatchObject({ onFreePlan: true, starterGranted: true });
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    expect(response.status, `${method} ${path} ${text}`).toBeLessThan(300);
    return text ? JSON.parse(text) : {};
  };
  const workspaceRoot = (email: string): string => {
    const dir = join(fixture.info.dataDir, "workspaces");
    const root = readdirSync(dir).map((name) => join(dir, name)).find((candidate) =>
      existsSync(join(candidate, "config.json")) && JSON.parse(readFileSync(join(candidate, "config.json"), "utf8")).signIn?.members?.includes(email));
    if (!root) throw new Error(`no workspace for ${email}`);
    return root;
  };
  /** Send one message, allow every approval card, and return the teammate's report. */
  const turn = async (who: ReturnType<typeof browser>, bot: { id: string; threadId: string }, text: string): Promise<string> => {
    const before = ((await who.request(`/api/threads/${bot.threadId}/messages`)).body.messages ?? []).length;
    const sent = await who.request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text } });
    expect(sent.status, sent.text).toBeLessThan(300);
    let report = "";
    await expect.poll(async () => {
      const messages: any[] = (await who.request(`/api/threads/${bot.threadId}/messages`)).body.messages ?? [];
      const card = messages.find((item) => item.card?.requestId && !item.card.answered)?.card;
      if (card) {
        await who.request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId: bot.threadId, requestId: card.requestId, behavior: "allow" } });
        return false;
      }
      const done = messages.slice(before).reverse().find((item) => item.role === "bot" && (item.text ?? "").startsWith("Result:"));
      if (done) report = done.text;
      return Boolean(done);
    }, { timeout: 45_000, interval: 300 }).toBe(true);
    return report;
  };

  try {
    // (b) The founder desk before anyone signs up.
    const deskBefore = await owner("/api/config");
    const deskBot = (await owner("/api/bots", "POST", { name: "Desk Atlas" })).bot;

    // (a) Alice's own workspace offers a cloud computer and the browser.
    const alice = browser(base);
    await signIn(alice, ALICE);
    expect((await alice.request("/api/config")).body).toMatchObject({
      isProductOwner: false, personalWorkspace: true,
      features: { computers: true, browser: true, sharedComputers: false }, browserEngine: { kind: "engine" },
    });
    const hands = (await alice.request("/api/bots", { method: "POST", body: { name: "Alice Hands" } })).body.bot;
    // Where it works is hers to choose, but never this machine or an SSH computer.
    for (const body of [{ computer: "local" }, { computer: "vm" }, { cloudBackend: "vps" }]) {
      expect((await alice.request(`/api/bots/${hands.id}`, { method: "PATCH", body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await alice.request(`/api/bots/${hands.id}`, { method: "PATCH", body: { computer: "cloud", cloudBackend: "box" } })).status).toBe(200);
    await turn(alice, hands, "save alice-secret as note.txt");
    const aliceBox = boxes.find((box) => box.files.get("note.txt") === "alice-secret")!;
    expect(aliceBox.name).toMatch(/^ogb-[0-9a-f]{12}-/);
    expect(await turn(alice, hands, "show note.txt")).toContain("alice-secret");
    // What she sees of it: whether it runs, and its screen; never its identifiers.
    const status = await alice.request(`/api/bots/${hands.id}/computer`);
    expect(status.body).toEqual({ surface: "cloud", configured: true, state: "running" });
    expect(status.text).not.toContain(aliceBox.id);
    const picture = await alice.request(`/api/bots/${hands.id}/computer/screenshot`, { method: "POST", body: {} });
    expect(picture.status, picture.text).toBe(200);
    expect(Object.keys(picture.body).sort()).toEqual(["format", "png"]);
    // Sleep and Start are hers too, and answer with the state only: never the
    // machine's identifiers or its desktop link.
    const slept = await alice.request(`/api/bots/${hands.id}/computer/sleep`, { method: "POST", body: {} });
    expect(slept.body).toEqual({ ok: true });
    expect((await alice.request(`/api/bots/${hands.id}/computer`)).body).toMatchObject({ state: "archived" });
    const started = await alice.request(`/api/bots/${hands.id}/computer/provision`, { method: "POST", body: {} });
    expect(started.body).toEqual({ ok: true, state: "running" });
    // When the provider fails, she hears that in NATION's words, not its own.
    providerFailing = true;
    const failed = await alice.request(`/api/bots/${hands.id}/computer/screenshot`, { method: "POST", body: {} });
    providerFailing = false;
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ error: "The cloud computer is not responding right now. Try again in a minute." });
    for (const reply of [status, picture, slept, started, failed]) {
      expect(reply.text).not.toContain(aliceBox.id);
      expect(reply.text).not.toContain(aliceBox.name);
      expect(reply.text).not.toContain("desktop.invalid");
    }
    for (const step of ["join", "exec", "remove"]) {
      expect((await alice.request(`/api/bots/${hands.id}/computer/${step}`, { method: "POST", body: { command: "id" } })).status, step).toBe(403);
    }

    // (a) Her browser: web addresses only, behind the egress guard.
    const surfer = (await alice.request("/api/bots", { method: "POST", body: { name: "Alice Surfer" } })).body.bot;
    expect((await alice.request(`/api/bots/${surfer.id}`, { method: "PATCH", body: { computer: "browser", browser: true } })).status).toBe(200);
    expect(await turn(alice, surfer, "browse")).toContain("fixture browser agent_browser_open ok");
    expect(await turn(alice, surfer, "open a file")).toContain("Only web addresses");
    // A url for read, or a file path for a picture, is not in the schema she
    // is shown; a call carrying one is refused before the engine either way.
    expect(await turn(alice, surfer, "read the desk")).not.toContain("fixture browser");
    expect(await turn(alice, surfer, "keep a picture")).not.toContain("fixture browser");
    expect(await turn(alice, surfer, "take a picture")).toContain("fixture browser agent_browser_screenshot ok");
    const aliceRoot = workspaceRoot(ALICE);
    const aliceLog = jsonLines(join(aliceRoot, "fake-agent-browser.jsonl"));
    expect(aliceLog.filter((entry) => entry.call)).toEqual([
      { call: "agent_browser_open", arguments: { url: "https://example.test/" } },
      { call: "agent_browser_screenshot", arguments: { fullPage: true } },
    ]);
    const shown = modelRequests.map((request) => request.tools).find((tools) => tools.some((tool) => tool.function.name === "browser_agent_browser_open"))!;
    const tool = (name: string) => shown.find((item) => item.function.name === name)?.function.parameters.properties ?? null;
    expect(tool("browser_agent_browser_upload")).toBeNull();
    expect(Object.keys(tool("browser_agent_browser_open")!)).toEqual(["url"]);
    expect(Object.keys(tool("browser_agent_browser_read")!)).toEqual(["outline"]);
    expect(Object.keys(tool("browser_agent_browser_screenshot")!)).toEqual(["fullPage"]);
    const aliceLaunch = aliceLog.find((entry) => entry.args?.[0] === "mcp")!.launch;
    expect(aliceLaunch).toMatchObject({ AGENT_BROWSER_PROXY_BYPASS: "<-loopback>", AGENT_BROWSER_CDP: null, HOME: aliceRoot });
    expect(aliceLaunch.AGENT_BROWSER_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(aliceLaunch.AGENT_BROWSER_ARGS).toContain("disable_non_proxied_udp");
    expect(aliceLaunch.AGENT_BROWSER_SOCKET_DIR).toMatch(/^\/tmp\/nw-[0-9a-f]{12}\/s$/);
    expect(aliceLaunch.TMPDIR).toBe(aliceLaunch.AGENT_BROWSER_SOCKET_DIR.replace(/\/s$/, "/t"));
    // The guard her browser goes through refuses the founder desk and this machine.
    expect(await viaProxy(aliceLaunch.AGENT_BROWSER_PROXY, `http://127.0.0.1:${deskPort}/api/config`)).toBe(403);
    expect(await viaProxy(aliceLaunch.AGENT_BROWSER_PROXY, `http://localhost:${deskPort}/`)).toBe(403);
    expect(await tunnelStatus(aliceLaunch.AGENT_BROWSER_PROXY, `127.0.0.1:${deskPort}`)).toBe(403);

    // (d) Bob: his own computer and browser; Alice's are not there for him.
    const bob = browser(base);
    await signIn(bob, BOB);
    const bobHands = (await bob.request("/api/bots", { method: "POST", body: { name: "Bob Hands" } })).body.bot;
    expect((await bob.request(`/api/bots/${bobHands.id}`, { method: "PATCH", body: { computer: "cloud", cloudBackend: "box" } })).status).toBe(200);
    await turn(bob, bobHands, "save bob-secret as note.txt");
    const bobBox = boxes.find((box) => box.files.get("note.txt") === "bob-secret")!;
    expect(bobBox.id).not.toBe(aliceBox.id);
    // each workspace names its machines under its own installation scope
    expect(bobBox.name.slice(0, 17)).not.toBe(aliceBox.name.slice(0, 17));
    const bobReads = await turn(bob, bobHands, "show note.txt");
    expect(bobReads).toContain("bob-secret");
    expect(bobReads).not.toContain("alice-secret");
    expect(commands.filter((item) => item.box === aliceBox.id).map((item) => item.command).join("\n")).not.toContain("bob-secret");
    for (const [method, path] of [
      ["GET", `/api/bots/${hands.id}/computer`], ["POST", `/api/bots/${hands.id}/computer/screenshot`],
      ["POST", `/api/bots/${hands.id}/computer/sleep`], ["GET", `/api/bots/${surfer.id}/browser/live`],
      ["GET", `/api/threads/${hands.threadId}/messages`],
    ]) {
      expect((await bob.request(path, { method, ...(method === "POST" ? { body: {} } : {}) })).status, path).toBe(404);
    }
    const bobSurfer = (await bob.request("/api/bots", { method: "POST", body: { name: "Bob Surfer" } })).body.bot;
    expect((await bob.request(`/api/bots/${bobSurfer.id}`, { method: "PATCH", body: { computer: "browser", browser: true } })).status).toBe(200);
    await turn(bob, bobSurfer, "browse");
    const bobRoot = workspaceRoot(BOB);
    const bobLaunch = jsonLines(join(bobRoot, "fake-agent-browser.jsonl")).find((entry) => entry.args?.[0] === "mcp")!.launch;
    expect(bobLaunch.HOME).toBe(bobRoot);
    expect(bobLaunch.AGENT_BROWSER_SOCKET_DIR).not.toBe(aliceLaunch.AGENT_BROWSER_SOCKET_DIR);
    expect(bobLaunch.AGENT_BROWSER_PROXY).not.toBe(aliceLaunch.AGENT_BROWSER_PROXY);
    expect(jsonLines(join(aliceRoot, "fake-agent-browser.jsonl")).filter((entry) => entry.call)).toHaveLength(2);

    // (c) Still no provider key, engine, host computer or sharing for a member.
    for (const [method, path, body] of [
      ["PATCH", "/api/config", { box: { token: "member-token" } }],
      ["PUT", "/api/config", { box: { token: "member-token" } }],
      ["PATCH", "/api/config", { features: { sharedComputers: true } }],
      ["POST", "/api/instances", { id: "mine", driver: "openai-compat" }],
      ["POST", "/api/browser-engine/install", {}],
      ["GET", "/api/local-computer", undefined],
      ["POST", "/api/local-computer/run", {}],
      ["POST", `/api/bots/${hands.id}/local-computer/run`, {}],
      ["GET", "/api/computers", undefined],
      ["POST", "/api/team-computers", { name: "shared" }],
      ["POST", "/api/shared-computers/connect", {}],
      ["POST", `/api/bots/${hands.id}/computer/control`, { action: "take" }],
    ] as const) {
      const refused = await alice.request(path, { method, ...(body === undefined ? {} : { body }) });
      expect([403, 404], `${method} ${path} ${refused.status}`).toContain(refused.status);
    }
    expect((await alice.request("/api/workspace/preferences", { method: "PATCH", body: { features: { computers: false } } })).status).toBe(400);
    // A workspace answers no one by loopback: its own port needs a session.
    const alicePort = Number(/NATION server on http:\/\/127\.0\.0\.1:(\d+)/.exec(readFileSync(join(aliceRoot, "logs", "server.log"), "utf8"))![1]);
    expect((await fetch(`http://127.0.0.1:${alicePort}/api/config`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${alicePort}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    // NATION's cloud computer credential reaches no member and no workspace file.
    expect(seenByMembers.join("\n")).not.toContain(BOX_TOKEN);
    for (const root of [aliceRoot, bobRoot]) expect(readFileSync(join(root, "config.json"), "utf8")).not.toContain(BOX_TOKEN);

    // (b) The founder desk is as it was: its settings, its teammates, and its
    // own computer routes, which its owner still reaches.
    const deskAfter = await owner("/api/config");
    expect(deskAfter.features).toEqual(deskBefore.features);
    expect(deskAfter.box).toEqual(deskBefore.box);
    expect((await owner("/api/bots")).bots.map((bot: { id: string }) => bot.id)).toContain(deskBot.id);
    expect((await fetch(`${base}/api/local-computer`)).status).not.toBe(404);

    // Stopping ends each workspace's computers and browser with it.
    const runtimes = [aliceLaunch, bobLaunch].map((launch) => String(launch.AGENT_BROWSER_SOCKET_DIR).replace(/\/s$/, ""));
    expect(runtimes.every((dir) => existsSync(dir))).toBe(true);
    const stoppedBefore = stopped.length;
    await fixture.close();
    closed = true;
    for (const dir of runtimes) expect(existsSync(dir), dir).toBe(false);
    expect(stopped.slice(stoppedBefore)).toEqual(expect.arrayContaining([aliceBox.id, bobBox.id]));
  } finally {
    if (!closed) await fixture.close();
    await chain.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 300_000);
