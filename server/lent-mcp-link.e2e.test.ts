// A lent computer's MCP servers, reached from My Cloud over a real device link: My Cloud's DeviceLinks on a WebSocket
// server and the computer's own link client, with a stub door on the computer that answers by name or hands back a
// socket to a fake server.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runDeviceLink } from "../electron/device-link.mjs";
import type { McpOpen } from "../electron/device-link-protocol.mjs";
import { DeviceLinks } from "./device-links.ts";
import { json, readBody } from "./harness/http.ts";
import { createLentMcp, LENT_MCP_PATH, type LentMcpDeps } from "./lent-mcp.ts";
import { PASS } from "./routes/table.ts";
import { startFakeHttpMcp, type FakeHttpMcpOptions } from "./testing/fake-http-mcp-server.ts";

const PERSON = "cloud-home";
const COMPUTER = "mac-1";
const MAC = { environmentId: "11111111-1111-4111-8111-111111111111", label: "Ada's Mac" };
const TURN = { botId: "kiwi", threadId: "t-1", generation: "g-1" };
const FAKE_STDIO = fileURLToPath(new URL("./testing/fake-stdio-mcp.mjs", import.meta.url));
const HEADER_KEY = "mac-header-key";
const ENV_KEY = "mac-env-key";
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "1" } } };
const rpc = (method: string, params: unknown, id: number) => ({ jsonrpc: "2.0", id, method, params });

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const until = async (check: () => boolean, what: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${what}`);
};
const exited = (child: ChildProcess) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit"));

type Refusal = { refused: string } | { failed: string };

/** My Cloud and a lent Mac joined by a real link. `refuse` makes the Mac's door answer by name instead of opening;
 * `frames` is every text frame on the link, as either end sent it. */
async function linked(servers: Record<string, unknown>) {
  const opened: McpOpen[] = [];
  const children: ChildProcess[] = [];
  const stderr: string[] = [];
  const door = { refuse: undefined as (() => Refusal | undefined) | undefined };
  cleanups.push(() => { for (const child of children) child.kill(); });

  const links = new DeviceLinks({ pingMs: 100 });
  const cloud = createServer();
  cloud.on("upgrade", (req, socket, head) => links.accept({ req, socket: socket as Socket, head }, {
    key: "owner:mac", id: COMPUTER, person: PERSON, internet: false, chrome: false, mcp: true, live: () => true, seenAs: null,
  }));
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { links.close(); cloud.closeAllConnections(); cloud.close(() => resolve()); }));

  const frames: string[] = [];
  class Tapped extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener("message", ({ data }) => { if (typeof data === "string") frames.push(data); });
    }
    override send(data: Parameters<WebSocket["send"]>[0]): void {
      if (typeof data === "string") frames.push(data);
      super.send(data);
    }
  }
  const stop = new AbortController();
  const ended = runDeviceLink({
    url: `ws://127.0.0.1:${(cloud.address() as AddressInfo).port}/link`, signal: stop.signal, WebSocket: Tapped,
    lends: () => ({ internet: false, chrome: false, mcp: true }),
    mcp: {
      async open(asked) {
        const target = asked as McpOpen;
        opened.push(target);
        const refused = door.refuse?.();
        if (refused) return refused;
        if ("port" in target) return { socket: connect(target.port, "127.0.0.1") };
        const child = spawn(process.execPath, [FAKE_STDIO], { env: { ...process.env, FAKE_SECRET: ENV_KEY }, stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        child.stderr.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
        const socket = new Duplex({
          read() {},
          write(chunk, _encoding, done) { child.stdin.write(chunk, done); },
          final(done) { child.stdin.end(); done(); },
          destroy(error, done) { child.kill(); done(error); },
        });
        child.stdout.on("data", (chunk: Buffer) => socket.push(chunk));
        child.stdout.on("end", () => socket.push(null));
        child.on("exit", () => socket.destroy());
        return { socket };
      },
    },
  });
  cleanups.push(() => { stop.abort(); return ended; });
  await until(() => links.mcpRoute(PERSON, COMPUTER) !== null, "the link to offer the computer's MCP servers");

  const computers: LentMcpDeps["computers"] = {
    runsOn: () => ({ online: { id: COMPUTER, name: "Ada's Mac", platform: "darwin", terminal: false, mcpServers: true, mcpLink: true }, known: { name: "Ada's Mac", platform: "darwin", lent: true } }),
    mcpLenders: () => [],
    request: async () => { throw new Error("a job was queued"); },
  };
  const lent = createLentMcp({
    cfg: () => ({ mcpServers: servers }), computers, links, policy: (all: Record<string, object>) => all, bot: (id: string) => ({ id }), principal: () => PERSON,
    notice: () => null, refusal: () => null, mint: () => "turn-bearer", active: () => true, origin: "http://127.0.0.1:1", personal: true, place: "My Cloud",
  } as unknown as LentMcpDeps);
  const engine = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://cloud.test").pathname;
    void lent.route({ method: req.method ?? "GET", path, req, res, turn: TURN, readBody: () => readBody(req), json })
      .then((out) => { if (out === PASS) json(res, 404, {}); }, (error: { status?: number }) => json(res, error.status ?? 500, {}));
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { lent.close(); engine.closeAllConnections(); engine.close(); });
  const origin = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;

  const send = (name: string, method: string, body?: unknown, session?: string | null) => fetch(`${origin}${LENT_MCP_PATH}${name}`, {
    method,
    headers: { authorization: "Bearer turn-bearer", accept: "application/json, text/event-stream", "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const post = async (name: string, body: unknown, session?: string | null) => {
    const answer = await send(name, "POST", body, session);
    const text = await answer.text();
    return { status: answer.status, session: answer.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null };
  };
  return { door, opened, children, stderr, frames, origin, send, post };
}

/** An event stream read as it arrives. */
function watch(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  cleanups.push(() => reader.cancel().catch(() => {}));
  return {
    async until(text: string): Promise<string> {
      while (!seen.includes(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`the stream ended before ${text}: ${seen}`);
        seen += decoder.decode(value, { stream: true });
      }
      return seen;
    },
  };
}

const local = (url: string, type: "http" | "sse" = "http") => ({ type, url, headers: { authorization: `Bearer ${HEADER_KEY}` }, enabled: true, runsOn: MAC });
const notes = { command: "/Users/ada/bin/notes-mcp", args: [], env: { NOTES_TOKEN: ENV_KEY }, enabled: true, runsOn: MAC };
const fake = async (options: FakeHttpMcpOptions = {}) => {
  const server = await startFakeHttpMcp({ requireHeader: { name: "authorization", value: `Bearer ${HEADER_KEY}` }, ...options });
  cleanups.push(() => server.close());
  return server;
};

describe("MCP servers on a lent computer, over a real link", () => {
  it("two tools/call to one server run side by side over one link", async () => {
    let arrived!: () => void;
    const slowCall = new Promise<void>((resolve) => { arrived = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upstream = await fake({ tools: [{ name: "read_notes" }], holdCall: async (params) => {
      if ((params as { arguments?: { slow?: boolean } }).arguments?.slow) { arrived(); await gate; }
    } });
    const mac = await linked({ local: local(upstream.url) });
    const started = await mac.post("local", initialize);
    expect(started).toMatchObject({ status: 200, session: "fake-session" });

    let slowDone = false;
    const slow = mac.post("local", rpc("tools/call", { name: "read_notes", arguments: { slow: true } }, 2), started.session).then((answer) => { slowDone = true; return answer; });
    await slowCall;
    const fast = await mac.post("local", rpc("tools/call", { name: "read_notes", arguments: {} }, 3), started.session);
    expect(fast.body.result.content[0].text).toBe("remote execution recorded");
    expect(slowDone, "the second call answered while the first was still held").toBe(false);
    release();
    expect((await slow).body).toMatchObject({ id: 2, result: { content: [{ type: "text", text: "remote execution recorded" }] } });
    expect(mac.opened.map((target) => target.name)).toEqual(["local", "local", "local"]);
  });

  it("a command server's child lives between calls and ends on DELETE; its stderr never reaches My Cloud", async () => {
    const mac = await linked({ notes });
    const started = await mac.post("notes", initialize);
    expect(started.body.result.serverInfo).toEqual({ name: "fake-stdio" });
    expect((await mac.post("notes", { jsonrpc: "2.0", method: "notifications/initialized" }, started.session)).status).toBe(202);
    const texts = [] as string[];
    for (const [index, text] of ["one", "two"].entries()) {
      const called = await mac.post("notes", rpc("tools/call", { name: "echo", arguments: { text } }, index + 2), started.session);
      texts.push(called.body.result.content[0].text);
    }
    expect(texts).toEqual(["one", "two"]);
    expect(mac.opened, "one stream for the session, however many calls").toHaveLength(1);
    expect(mac.children).toHaveLength(1);
    const child = mac.children[0]!;
    expect(child.exitCode).toBeNull();

    expect((await mac.send("notes", "DELETE", undefined, started.session)).status).toBe(200);
    await exited(child);
    await until(() => mac.stderr.join("").includes("secret-in-stderr"), "the child's stderr to be read on the computer");
    expect(JSON.stringify([started, texts])).not.toContain("secret-in-stderr");
  });

  it("server-sent notifications reach the engine's GET stream", async () => {
    const mac = await linked({ notes });
    const started = await mac.post("notes", initialize);
    const stream = await mac.send("notes", "GET", undefined, started.session);
    expect(stream.status).toBe(200);
    const events = watch(stream);
    const called = await mac.post("notes", rpc("tools/call", { name: "echo", arguments: { text: "hi", notify: true } }, 2), started.session);
    expect(called.body.result.content[0].text).toBe("hi");
    const seen = await events.until("from the child");
    expect(seen).toContain(`"method":"notifications/message"`);
  });

  it("not-lent, needs-approval and declined from the door become the bot's plain words", async () => {
    const upstream = await fake({ tools: [{ name: "read_notes" }] });
    const mac = await linked({ local: local(upstream.url), notes });
    const lines: Record<string, Record<string, string>> = {
      "not-lent": {
        local: `local runs on your Mac (Ada's Mac), which isn't lending its MCP servers to My Cloud: turn on "Let My Cloud use your MCP servers on this Mac" from the OpenMausBot icon on that Mac.`,
        notes: `notes runs on your Mac (Ada's Mac), which isn't lending its MCP servers to My Cloud: turn on "Let My Cloud use your MCP servers on this Mac" from the OpenMausBot icon on that Mac.`,
      },
      "needs-approval": { local: "Allow local on your Mac (Ada's Mac): a prompt is waiting there. Then try again.", notes: "Allow notes on your Mac (Ada's Mac): a prompt is waiting there. Then try again." },
      declined: { local: "On your Mac (Ada's Mac), the person didn't allow local. Ask them before trying again.", notes: "On your Mac (Ada's Mac), the person didn't allow notes. Ask them before trying again." },
    };
    const problem = { "not-lent": "not-lending", "needs-approval": "needs-approval", declined: "declined" } as const;
    for (const [refused, byServer] of Object.entries(lines)) {
      mac.door.refuse = () => ({ refused });
      for (const [name, line] of Object.entries(byServer)) {
        const started = await mac.post(name, initialize);
        expect(started, `${refused} ${name}`).toMatchObject({ status: 200, session: `refused-${problem[refused as keyof typeof problem]}`, body: { result: { instructions: line } } });
        expect((await mac.post(name, rpc("tools/list", {}, 2), started.session)).body.result).toEqual({ tools: [] });
        expect((await mac.post(name, rpc("tools/call", { name: "read_notes" }, 3), started.session)).body.result).toEqual({ content: [{ type: "text", text: line }], isError: true });
      }
    }

    // A session that was open when the person withdrew: the call and the listing carry the words.
    mac.door.refuse = undefined;
    const open = await mac.post("local", initialize);
    mac.door.refuse = () => ({ refused: "declined" });
    const called = await mac.post("local", rpc("tools/call", { name: "read_notes" }, 4), open.session);
    expect(called.body.result).toEqual({ content: [{ type: "text", text: lines.declined!.local }], isError: true });
    const listed = await mac.post("local", rpc("tools/list", {}, 5), open.session);
    expect(listed.body.error).toEqual({ code: -32603, message: lines.declined!.local });
    expect(upstream.calls, "no call reached the server once it was refused").toEqual([]);
  });

  it("an old-SSE server's endpoint POSTs come back through the door", async () => {
    const upstream = await fake({ transport: "sse", tools: [{ name: "read_notes" }] });
    const mac = await linked({ old: local(upstream.url, "sse") });
    const stream = await mac.send("old", "GET");
    expect(stream.status).toBe(200);
    const events = watch(stream);
    const endpoint = /event: endpoint\ndata: (\S+)\n/.exec(await events.until("data: /"))![1]!;
    expect(endpoint).toBe(`${LENT_MCP_PATH}old/messages`);
    const posted = await fetch(`${mac.origin}${endpoint}`, {
      method: "POST", headers: { authorization: "Bearer turn-bearer", "content-type": "application/json" }, body: JSON.stringify(rpc("tools/list", {}, 7)),
    });
    expect(posted.status).toBe(202);
    const seen = await events.until(`"id":7`);
    expect(seen).toContain(`"tools":[{"name":"read_notes"}]`);
    expect(new Set(upstream.seenPaths)).toEqual(new Set(["/sse", "/messages"]));
    expect(upstream.seenHeaders.every((headers) => headers.authorization === `Bearer ${HEADER_KEY}`), "the saved header, never the turn's bearer").toBe(true);
    expect(mac.opened.every((target) => "port" in target && target.port === Number(new URL(upstream.url).port))).toBe(true);
  });

  it("no env value, header value or child stderr appears in any link control frame", async () => {
    const upstream = await fake({ tools: [{ name: "read_notes" }] });
    const mac = await linked({ local: local(upstream.url), notes });
    const web = await mac.post("local", initialize);
    expect((await mac.post("local", rpc("tools/call", { name: "read_notes", arguments: {} }, 2), web.session)).status).toBe(200);
    const program = await mac.post("notes", initialize);
    expect((await mac.post("notes", rpc("tools/call", { name: "echo", arguments: { text: "hi" } }, 2), program.session)).status).toBe(200);
    await mac.send("notes", "DELETE", undefined, program.session);
    await until(() => mac.stderr.join("").includes(`secret-in-stderr ${ENV_KEY}`), "the child's stderr to be read on the computer");
    await exited(mac.children[0]!);

    const crossed = mac.frames.join("\n");
    expect(crossed, "the capture saw the opens").toContain(`"notes"`);
    expect(crossed).toContain(`"local"`);
    for (const secret of [ENV_KEY, HEADER_KEY, "secret-in-stderr"]) expect(crossed, secret).not.toContain(secret);
  });
});
