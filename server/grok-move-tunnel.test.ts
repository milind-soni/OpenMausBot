import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GROK_EXPORT_FORMAT, GROK_EXPORT_MAX_CHARS } from "../shared/grok-import.ts";
import { createGrokMove, grokMoveCloudflared, type GrokMove, type GrokMoveHost } from "./grok-move-tunnel.ts";

const ADDRESS = "https://quiet-test-words.trycloudflare.com";
const moves: GrokMove[] = [];
afterEach(() => {
  for (const move of moves.splice(0)) move.end();
});

/** A stand-in cloudflared: a real child process that prints what cloudflared prints and then stays up. */
function harness(options: { says?: string; startTimeoutMs?: number; now?: () => number; host?: GrokMoveHost } = {}) {
  const children: ChildProcess[] = [];
  const started: string[][] = [];
  const says = options.says ?? `INF |  ${ADDRESS}  |\\nINF Registered tunnel connection connIndex=0`;
  const move = createGrokMove({
    binary: () => "/fake/cloudflared",
    spawn: ((_binary: string, args: string[], spawnOptions: object) => {
      started.push(args);
      const child = spawn(process.execPath, ["-e", `process.stderr.write("${says}\\n"); setInterval(() => {}, 1000);`], spawnOptions);
      children.push(child);
      return child;
    }) as unknown as typeof spawn,
    ...options,
  });
  moves.push(move);
  /** The listener cloudflared was pointed at, reached the way cloudflared reaches it. */
  const post = (connectorUrl: string, body: unknown, init: { method?: string; type?: string; path?: string } = {}) =>
    fetch(`${started.at(-1)!.at(-1)}${init.path ?? new URL(connectorUrl).pathname}`, {
      method: init.method ?? "POST",
      ...(init.method === "GET" ? {} : { headers: { "content-type": init.type ?? "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { move, children, started, post };
}
const send = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_export", arguments: { document: { format: GROK_EXPORT_FORMAT, version: 1, bots: [{ name, memories: ["likes cheese"] }] } } } });
const gone = (child: ChildProcess) => new Promise<void>((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())));

describe("the Grok Bot link", () => {
  it("opens one quick tunnel to a listener of its own, hands over what a Bot sent, and closes both when ended", async () => {
    const { move, children, started, post } = harness();
    expect(move.look(0)).toEqual({ available: true, arrived: [], handoffs: [] });
    const [made, again] = await Promise.all([move.connect(), move.connect()]);
    expect(made.connectorUrl).toMatch(new RegExp(`^${ADDRESS}/mcp/move/[\\w-]{43}$`));
    expect(again).toEqual(made);
    expect(await move.connect()).toEqual(made);
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual(["--config", expect.stringMatching(/config\.yml$/), "tunnel", "--no-autoupdate", "--url", expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);

    const sent = await post(made.connectorUrl!, send("Tango"));
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(await sent.json()).toMatchObject({ result: { content: [{ text: expect.stringContaining("Arrived in MausBot. Tango") }] } });
    expect((await post(made.connectorUrl!, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const looked = move.look(0);
    expect(looked).toMatchObject({ connectorUrl: made.connectorUrl, arrived: [{ seq: 1 }] });
    expect(JSON.parse(looked.arrived[0]!.text)).toMatchObject({ bots: [{ name: "Tango", memories: ["likes cheese"] }] });
    expect(move.look(1).arrived).toEqual([]);

    expect(move.end()).toEqual({ available: true, arrived: [], handoffs: [] });
    await gone(children[0]!);
    await expect(post(made.connectorUrl!, send("Late"))).rejects.toThrow();
  });

  it("answers the public address only at the keyed path, only to a JSON POST, and only up to the size cap", async () => {
    const { move, post } = harness();
    const { connectorUrl } = await move.connect();
    const path = new URL(connectorUrl!).pathname;
    for (const wrong of ["/", "/mcp/move/", `/mcp/move/${"A".repeat(43)}`, `${path}/`, `${path}x`, path.slice(0, -1), "/api/status", "/api/setup-import/grok/connector", `/x${path}`]) {
      const answer = await post(connectorUrl!, send("Tango"), { path: wrong });
      expect(answer.status, wrong).toBe(404);
      expect(await answer.json()).toEqual({ error: "not found" });
    }
    expect((await post(connectorUrl!, "", { method: "GET", path: "/" })).status).toBe(404);
    for (const method of ["GET", "DELETE", "PUT"]) {
      const answer = await post(connectorUrl!, send("Tango"), { method });
      expect(answer.status, method).toBe(405);
      expect(answer.headers.get("allow")).toBe("POST");
    }
    expect((await post(connectorUrl!, send("Tango"), { type: "text/plain" })).status).toBe(415);
    expect(await (await post(connectorUrl!, "{not json")).json()).toMatchObject({ error: { code: -32700 } });
    const huge = await post(connectorUrl!, JSON.stringify(send("x".repeat(GROK_EXPORT_MAX_CHARS + 70_000))));
    expect(huge.status).toBe(413);
    expect(move.look(0).arrived).toEqual([]);
    // The query is no part of the key.
    expect((await post(connectorUrl!, send("Tango"), { path: `${path}?x=1` })).status).toBe(200);
  });

  it("says the link stopped when cloudflared exits, keeps what arrived, and numbers a new link's arrivals after the old", async () => {
    const { move, children, post } = harness();
    const first = await move.connect();
    await post(first.connectorUrl!, send("Tango"));
    children[0]!.kill();
    await gone(children[0]!);
    await new Promise((done) => setTimeout(done, 20));
    expect(move.look(0)).toMatchObject({ available: true, stopped: true, arrived: [{ seq: 1 }] });
    expect(move.look(0).connectorUrl).toBeUndefined();
    await expect(post(first.connectorUrl!, send("Late"))).rejects.toThrow();

    const second = await move.connect();
    expect(second.connectorUrl).not.toBe(first.connectorUrl);
    expect(second).toMatchObject({ available: true, arrived: [] });
    expect(second.stopped).toBeUndefined();
    await post(second.connectorUrl!, send("Maus"));
    expect(move.look(1).arrived.map((arrival) => arrival.seq)).toEqual([2]);
  });

  it("stays up however long the app runs, and lets go of what the person imported without closing", async () => {
    let clock = Date.UTC(2030, 0, 1);
    const { move, children, post } = harness({ now: () => clock });
    const { connectorUrl } = await move.connect();
    await post(connectorUrl!, send("Tango"));
    await post(connectorUrl!, send("Maus"));
    clock += 30 * 24 * 60 * 60 * 1000;
    expect(move.look(0)).toMatchObject({ connectorUrl, arrived: [{ seq: 1 }, { seq: 2 }] });
    expect(move.taken(1)).toMatchObject({ connectorUrl, arrived: [{ seq: 2 }] });
    expect(move.look(0).arrived.map((arrival) => arrival.seq)).toEqual([2]);
    expect((await post(connectorUrl!, send("Later"))).status).toBe(200);
    expect(move.taken(3)).toMatchObject({ connectorUrl, arrived: [] });
    expect(children[0]!.exitCode).toBeNull();
    expect(await move.connect()).toMatchObject({ connectorUrl });
  });

  it("hands a task to the place behind it, holds a status read while it waits, and shows the app its last handoffs", async () => {
    let release = () => {};
    const host: GrokMoveHost = {
      bots: () => [{ name: "MausBot", job: "Chief of Staff" }],
      handOff: async ({ task }) => ({ taskId: "task_a", bot: "MausBot", title: `From Grok Bot: ${task}` }),
      status: (_id, waitMs) => new Promise((answer) => { release = () => answer({ title: "From Grok Bot: Tidy up", state: "done", on: ["MausBot"], result: `waited ${waitMs}` }); }),
      recent: () => [{ title: "From Grok Bot: Tidy up", state: "working", botId: "b1", threadId: "t1", at: 5 }],
    };
    const { move, post } = harness({ host });
    const { connectorUrl, handoffs } = await move.connect();
    expect(handoffs).toEqual([{ title: "From Grok Bot: Tidy up", state: "working", botId: "b1", threadId: "t1", at: 5 }]);
    const tool = (name: string, args: unknown) => post(connectorUrl!, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).then((answer) => answer.json());
    expect(await tool("move_status", {})).toMatchObject({ result: { content: [{ text: expect.stringContaining("MausBot's bots: MausBot (Chief of Staff).") }] } });
    expect(await tool("hand_off_task", { task: "Tidy up" })).toMatchObject({ result: { content: [{ text: expect.stringContaining("task_id: task_a.") }] } });
    const reading = tool("task_status", { task_id: "task_a", wait_seconds: 20 });
    await new Promise((done) => setTimeout(done, 50));
    release();
    expect(await reading).toMatchObject({ result: { content: [{ text: expect.stringContaining("Result:\nwaited 20000") }] } });
  });

  it("makes no link without cloudflared, and fails plainly, with nothing left running, when the tunnel never opens", async () => {
    const none = createGrokMove({ binary: () => null });
    expect(await none.connect()).toEqual({ available: false, arrived: [], handoffs: [] });
    // Packaged, only the copy shipped in Resources counts.
    const resources = mkdtempSync(join(tmpdir(), "omb-grok-move-test-"));
    const shipped = join(resources, "cloudflared", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    expect(grokMoveCloudflared({ PATH: dirname(process.execPath), OMB_CLOUDFLARED_PATH: process.execPath, OMB_RESOURCES_PATH: resources }, false)).toBeNull();
    mkdirSync(dirname(shipped));
    writeFileSync(shipped, "");
    expect(grokMoveCloudflared({ OMB_RESOURCES_PATH: resources }, false)).toBe(shipped);
    rmSync(resources, { recursive: true, force: true });
    expect(grokMoveCloudflared({ PATH: "/nonexistent", OMB_CLOUDFLARED_PATH: process.execPath }, true)).toBe(process.execPath);

    const silent = harness({ says: "INF Requesting new quick Tunnel", startTimeoutMs: 300 });
    await expect(silent.move.connect()).rejects.toThrow("The link could not be made: cloudflared did not open a tunnel in time.");
    await gone(silent.children[0]!);
    expect(silent.move.look(0)).toEqual({ available: true, arrived: [], handoffs: [] });

    const ended = harness();
    const opening = ended.move.connect();
    ended.move.end();
    expect(await opening).toEqual({ available: true, arrived: [], handoffs: [] });
    await gone(ended.children[0]!);
  });
});
