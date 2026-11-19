import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GROK_EXPORT_FORMAT } from "../shared/grok-import.ts";
import { GROK_LINK_SECRET_HEADER, linkKey, type LinkSecret } from "../shared/grok-link.ts";
import { createGrokMove, grokLinkBrokerUrl, type GrokMoveHost, type LinkSocketEvents } from "./grok-link.ts";
import { moveManifest } from "./grok-move-mcp.ts";

const BASE = "https://broker.test";
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** setImmediate stays real: the address key is hashed off the timer queue, and a test waits for it with `dialled`. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

interface Dialled { url: string; headers: Record<string, string>; events: LinkSocketEvents; sent: string[]; closed: boolean }

/** The service's end of the socket, driven by hand: each dial is recorded and opens when the test says so. */
function harness(options: { host?: GrokMoveHost; keyFile?: string | null; base?: string } = {}) {
  const keyFile = options.keyFile === null ? undefined : options.keyFile ?? join(dirs[dirs.push(mkdtempSync(join(tmpdir(), "omb-grok-link-"))) - 1]!, "grok-connector-key");
  const dials: Dialled[] = [];
  const deleted: Array<{ url: string; secret: string | null }> = [];
  const make = () => createGrokMove({
    ...(keyFile ? { keyFile } : {}),
    host: options.host,
    now: () => 7,
    brokerUrl: () => options.base ?? BASE,
    dial: (url, headers, events) => {
      const dialled: Dialled = { url, headers, events, sent: [], closed: false };
      dials.push(dialled);
      return { send: (text) => { dialled.sent.push(text); }, close: () => { dialled.closed = true; } };
    },
    fetch: (async (url: string, init: RequestInit) => {
      deleted.push({ url, secret: new Headers(init.headers).get(GROK_LINK_SECRET_HEADER) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const move = make();
  /** Turns the connector on with the service answering the first dial. */
  const dialled = async (count: number) => { while (dials.length < count) await new Promise((soon) => setImmediate(soon)); };
  const on = async () => {
    const connecting = move.connect();
    await dialled(1);
    dials[0]!.events.open();
    return connecting;
  };
  const frames = (dialled: Dialled) => dialled.sent.filter((text) => text.startsWith("{")).map((text) => JSON.parse(text) as { t: string; id?: string; status?: number; body?: { id: number; result: { content: Array<{ text: string }>; isError?: true } } });
  const call = (dialled: Dialled, id: string, name: string, args: unknown = {}) =>
    dialled.events.text(JSON.stringify({ t: "call", id, message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } }));
  const answered = (dialled: Dialled, id: string) => frames(dialled).find((frame) => frame.t === "answer" && frame.id === id);
  return { move, make, keyFile, dials, dialled, deleted, on, frames, call, answered };
}

describe("the Grok Bot link", () => {
  it("is off until asked for, then keeps a secret, shows the address made from it and tells the service what to say", async () => {
    const { move, keyFile, dials, on, frames } = harness();
    expect(move.look(0)).toEqual({ available: true, arrived: [], handoffs: [] });
    expect(dials).toEqual([]);
    const made = await on();
    const secret = readFileSync(keyFile!, "utf8").trim() as LinkSecret;
    expect(secret).toMatch(/^[\w-]{43}$/);
    if (process.platform !== "win32") expect(statSync(keyFile!).mode & 0o777).toBe(0o600);
    expect(made).toEqual({ available: true, link: { url: `${BASE}/mcp/move/${await linkKey(secret)}`, reach: "connected" }, arrived: [], handoffs: [] });
    expect(made.link!.url).not.toContain(secret);
    expect(dials[0]).toMatchObject({ url: "wss://broker.test/v1/grok-link", headers: { [GROK_LINK_SECRET_HEADER]: secret } });
    expect(frames(dials[0]!)).toEqual([{ t: "hello", manifest: JSON.parse(JSON.stringify(moveManifest())) }]);
    expect(await move.connect(), "asking again gives the link that is on").toEqual(made);
    expect(dials).toHaveLength(1);
  });

  it("comes back on by itself at the same address when the app starts again", async () => {
    const first = harness();
    const made = await first.on();
    const again = harness({ keyFile: first.keyFile });
    await again.dialled(1);
    expect(again.move.look(0).link).toEqual({ url: made.link!.url, reach: "connecting" });
    again.dials[0]!.events.open();
    expect(again.move.look(0).link).toEqual(made.link);
    expect(again.dials[0]!.headers).toEqual(first.dials[0]!.headers);
  });

  it("answers each call with a receipt at once and then the tool's own answer", async () => {
    const { move, dials, on, frames, call, answered } = harness();
    await on();
    call(dials[0]!, "c1", "send_export", { document: { format: GROK_EXPORT_FORMAT, version: 1, bots: [{ name: "Tango", memories: ["likes cheese"] }] } });
    expect(frames(dials[0]!)[1]).toEqual({ t: "got", id: "c1" });
    await vi.waitFor(() => expect(answered(dials[0]!, "c1")).toBeDefined());
    expect(answered(dials[0]!, "c1")).toMatchObject({ status: 200, body: { id: 1, result: { content: [{ text: expect.stringContaining("Arrived in MausBot. Tango") }] } } });
    const looked = move.look(0);
    expect(JSON.parse(looked.arrived[0]!.text)).toMatchObject({ bots: [{ name: "Tango" }] });
    expect(move.taken(looked.arrived[0]!.seq).arrived).toEqual([]);
    dials[0]!.events.text(JSON.stringify({ t: "call", id: "n1", message: { jsonrpc: "2.0", method: "notifications/initialized" } }));
    await vi.waitFor(() => expect(answered(dials[0]!, "n1")).toEqual({ t: "answer", id: "n1", status: 202 }));
    dials[0]!.events.text("not a frame");
    dials[0]!.events.text(JSON.stringify({ t: "hello" }));
    expect(frames(dials[0]!).filter((frame) => frame.t === "got")).toHaveLength(2);
  });

  it("holds a task_status without keeping other calls waiting, and turns away a ninth call at once", async () => {
    const held: Array<() => void> = [];
    const host: GrokMoveHost = {
      bots: () => [{ name: "MausBot" }],
      recent: () => [],
      handOff: async () => ({ taskId: "task_1", bot: "MausBot", title: "From Grok Bot: wait" }),
      status: (_taskId, waitMs) => (waitMs ? new Promise((done) => held.push(() => done({ title: "From Grok Bot: wait", state: "done", on: ["MausBot"], result: "Finished." }))) : Promise.resolve(null)),
    };
    const { dials, on, call, answered } = harness({ host });
    await on();
    const [socket] = dials;
    call(socket!, "h", "hand_off_task", { task: "wait" });
    await vi.waitFor(() => expect(answered(socket!, "h")).toBeDefined());
    for (let index = 0; index < 8; index += 1) call(socket!, `s${index}`, "task_status", { task_id: "task_1", wait_seconds: 25 });
    await vi.waitFor(() => expect(held).toHaveLength(8));
    call(socket!, "ninth", "move_status");
    await vi.waitFor(() => expect(answered(socket!, "ninth")).toBeDefined());
    expect(answered(socket!, "ninth")!.body!.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("still working on earlier calls") }] });
    held.shift()!();
    await vi.waitFor(() => expect(answered(socket!, "s0")).toBeDefined());
    expect(answered(socket!, "s0")!.body!.result.content[0]!.text).toContain("Finished.");
    expect(answered(socket!, "s1"), "the others still wait").toBeUndefined();
    call(socket!, "quick", "move_status");
    await vi.waitFor(() => expect(answered(socket!, "quick")).toBeDefined());
    expect(answered(socket!, "quick")!.body!.result.content[0]!.text).toContain("Connected to MausBot.");
    for (const done of held.splice(0)) done();
  });

  it("keeps its address and reaches the service again when the socket drops, sooner at first and at most a minute apart", async () => {
    const { move, dials, on } = harness();
    const made = await on();
    fakeTimers();
    dials[0]!.events.closed(1006);
    expect(move.look(0).link).toEqual({ url: made.link!.url, reach: "connecting" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dials).toHaveLength(2);
    for (let failed = 2; failed < 10; failed += 1) {
      dials.at(-1)!.events.closed(1006);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(dials).toHaveLength(failed + 1);
    }
    dials.at(-1)!.events.open();
    expect(move.look(0).link).toEqual(made.link);
    dials[0]!.events.closed(1006);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(dials, "a socket already let go asks for nothing").toHaveLength(10);
  });

  it("takes a socket that gives no pong for dead and dials again", async () => {
    fakeTimers();
    const { move, dials, dialled } = harness();
    const connecting = move.connect();
    await dialled(1);
    dials[0]!.events.open();
    await connecting;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dials[0]!.sent.at(-1)).toBe("ping");
    dials[0]!.events.text("pong");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dials[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials[0]!.closed).toBe(true);
    expect(move.look(0).link!.reach).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dials).toHaveLength(2);
  });

  it("stays away once another copy of the app took the link, until asked for again", async () => {
    const { move, dials, on } = harness();
    const made = await on();
    fakeTimers();
    dials[0]!.events.closed(4001);
    expect(move.look(0).link).toEqual({ url: made.link!.url, reach: "elsewhere" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dials).toHaveLength(1);
    const back = move.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toHaveLength(2);
    dials[1]!.events.open();
    expect(await back).toMatchObject({ link: made.link });
  });

  it("answers after ten seconds when the service cannot be reached, with the address and still trying", async () => {
    fakeTimers();
    const { move, dials, dialled } = harness();
    const connecting = move.connect();
    await dialled(1);
    dials[0]!.events.closed(1006);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await connecting).toMatchObject({ link: { url: expect.stringContaining("/mcp/move/"), reach: "connecting" } });
  });

  it("turns off for good: tells the service, forgets the secret, and makes a new address when turned on again", async () => {
    const { move, make, keyFile, dials, dialled, deleted, on } = harness();
    const made = await on();
    const secret = readFileSync(keyFile!, "utf8").trim();
    expect(await move.end()).toEqual({ available: true, arrived: [], handoffs: [] });
    expect(deleted).toEqual([{ url: `${BASE}/v1/grok-link`, secret }]);
    expect(existsSync(keyFile!)).toBe(false);
    expect(dials[0]!.closed).toBe(true);
    dials[0]!.events.closed(1006);
    expect(move.look(0).link).toBeUndefined();
    expect(make().look(0).link, "nothing comes back on").toBeUndefined();
    const connecting = move.connect();
    await dialled(2);
    dials[1]!.events.open();
    expect((await connecting).link!.url).not.toBe(made.link!.url);
    await move.end();
    expect(deleted).toHaveLength(2);
  });

  it("is unavailable without a connected-apps service, and reads only a whole secret from the file", async () => {
    const none = harness({ base: "" });
    expect(await none.move.connect()).toEqual({ available: false, arrived: [], handoffs: [] });
    expect(existsSync(none.keyFile!)).toBe(false);
    const junk = harness();
    writeFileSync(junk.keyFile!, "not-a-secret\n");
    expect(junk.make().look(0).link).toBeUndefined();
    await new Promise((later) => setTimeout(later, 20));
    expect(junk.dials).toEqual([]);

    expect(grokLinkBrokerUrl({})).toBe("");
    expect(grokLinkBrokerUrl({ OMB_COMPOSIO_BROKER_URL: "https://broker.example/" })).toBe("https://broker.example");
    expect(grokLinkBrokerUrl({ OMB_COMPOSIO_BROKER_URL: "http://127.0.0.1:8787" })).toBe("http://127.0.0.1:8787");
    expect(grokLinkBrokerUrl({ OMB_COMPOSIO_BROKER_URL: "http://broker.example" })).toBe("");
    expect(grokLinkBrokerUrl({ OMB_COMPOSIO_BROKER_URL: "https://broker.example", OMB_COMPOSIO_BROKER: "off" })).toBe("");
  });
});
