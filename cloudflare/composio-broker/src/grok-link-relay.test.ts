import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GROK_LINK_ANSWER_MAX, type LinkManifest } from "../../../shared/grok-link";
import { LinkRelay, type RelaySocket, type RelayStore } from "./grok-link-relay";

const told = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });
const MANIFEST: LinkManifest = {
  versions: ["2025-06-18", "2024-11-05"],
  initialize: { capabilities: { tools: {} }, serverInfo: { name: "MausBot" } },
  tools: { tools: [{ name: "move_status" }] },
  offline: told("MausBot isn't open."),
  late: told("MausBot didn't answer in time."),
};
const rpc = (method: string, params?: unknown, id: number | null = 1) => JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });
const toolCall = (id = 1) => rpc("tools/call", { name: "move_status", arguments: {} }, id);

function fixture(limits = { helloMs: 2_000, pickupMs: 5_000, answerMs: 40_000, inFlight: 8 }) {
  let stored: LinkManifest | null = null;
  const store: RelayStore = { read: async () => stored, write: async (manifest) => { stored = manifest; }, clear: async () => { stored = null; } };
  const open: Array<RelaySocket & { sent: Array<{ t: string; id: string; message: unknown }>; closedWith?: number }> = [];
  const make = () => new LinkRelay(store, () => open, limits);
  let relay = make();
  const socket = () => {
    const made = {
      sent: [] as Array<{ t: string; id: string; message: unknown }>,
      closedWith: undefined as number | undefined,
      send(text: string) { made.sent.push(JSON.parse(text)); },
      close(code: number, _reason?: string) { made.closedWith = code; open.splice(open.indexOf(made), 1); },
    };
    open.push(made);
    relay.attach(made);
    return made;
  };
  const desktop = async () => {
    const made = socket();
    await relay.received(made, JSON.stringify({ t: "hello", manifest: MANIFEST }));
    return made;
  };
  return { relay: () => relay, asleep: () => { relay = make(); }, socket, desktop, stored: () => stored };
}
const read = async (response: Response | Promise<Response>) => {
  const answer = await response;
  return { status: answer.status, body: (answer.status === 202 ? null : await answer.json()) as Record<string, any> };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("one Grok Bot link's relay", () => {
  it("answers nothing but 503 until a desktop has said hello, and waits two seconds for one that just attached", async () => {
    const { relay, socket } = fixture();
    expect((await read(relay().call(rpc("initialize")))).status).toBe(503);
    const attached = socket();
    const silent = read(relay().call(toolCall()));
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await silent).status).toBe(503);
    const overtook = read(relay().call(rpc("tools/list")));
    await vi.advanceTimersByTimeAsync(100);
    await relay().received(attached, JSON.stringify({ t: "hello", manifest: MANIFEST }));
    expect((await overtook).body).toEqual({ jsonrpc: "2.0", id: 1, result: MANIFEST.tools });
  });

  it("shakes hands and lists the tools from the desktop's manifest, with or without the desktop", async () => {
    const { relay, desktop, asleep } = fixture();
    const attached = await desktop();
    for (const [asked, given] of [["2024-11-05", "2024-11-05"], ["1999-01-01", "2025-06-18"], [undefined, "2025-06-18"]]) {
      expect(await read(relay().call(rpc("initialize", { protocolVersion: asked })))).toEqual({
        status: 200, body: { jsonrpc: "2.0", id: 1, result: { ...MANIFEST.initialize, protocolVersion: given } },
      });
    }
    attached.close(1000, "quit");
    relay().closed(attached);
    asleep();
    expect((await read(relay().call(rpc("tools/list")))).body).toEqual({ jsonrpc: "2.0", id: 1, result: MANIFEST.tools });
    expect((await read(relay().call(rpc("ping")))).body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect((await read(relay().call(rpc("notifications/initialized", undefined, null)))).status).toBe(202);
    expect((await read(relay().call(rpc("resources/list")))).body.error.code).toBe(-32601);
    expect(await read(relay().call("{not json"))).toMatchObject({ status: 400, body: { error: { code: -32700 } } });
    expect(await read(relay().call("[1]"))).toMatchObject({ status: 400, body: { error: { code: -32600 } } });
    expect(attached.sent, "none of it reached the desktop").toEqual([]);
  });

  it("relays a tool call as the caller sent it and answers with what the desktop said", async () => {
    const { relay, desktop } = fixture();
    const attached = await desktop();
    const body = toolCall(7);
    const answer = relay().call(body);
    await vi.advanceTimersByTimeAsync(0);
    const [frame] = attached.sent;
    expect(frame).toMatchObject({ t: "call", message: JSON.parse(body) });
    await relay().received(attached, JSON.stringify({ t: "got", id: frame!.id }));
    await vi.advanceTimersByTimeAsync(30_000);
    await relay().received(attached, JSON.stringify({ t: "answer", id: frame!.id, status: 200, body: { jsonrpc: "2.0", id: 7, result: { content: [] } } }));
    expect(await read(answer)).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 7, result: { content: [] } } });
    expect(attached.closedWith).toBeUndefined();
  });

  it("says the app isn't open when no desktop is attached, and after the object slept still finds the one that is", async () => {
    const { relay, desktop, asleep } = fixture();
    const attached = await desktop();
    attached.close(1000, "quit");
    relay().closed(attached);
    expect((await read(relay().call(toolCall(3)))).body).toEqual({ jsonrpc: "2.0", id: 3, result: MANIFEST.offline });
    const again = await desktop();
    asleep();
    const answer = relay().call(toolCall(4));
    await vi.advanceTimersByTimeAsync(0);
    await relay().received(again, JSON.stringify({ t: "answer", id: again.sent[0]!.id, status: 200, body: { ok: true } }));
    expect((await read(answer)).body).toEqual({ ok: true });
  });

  it("takes a desktop that gives no receipt in 5 seconds for asleep: closes it and says the app isn't open", async () => {
    const { relay, desktop } = fixture();
    const attached = await desktop();
    const answer = relay().call(toolCall());
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await read(answer)).body.result).toEqual(MANIFEST.offline);
    expect(attached.closedWith).toBe(4003);
    expect((await read(relay().call(toolCall()))).body.result).toEqual(MANIFEST.offline);
  });

  it("says the app was late when it took the call and gave no answer in 40 seconds, and stays attached", async () => {
    const { relay, desktop } = fixture();
    const attached = await desktop();
    const answer = relay().call(toolCall());
    await vi.advanceTimersByTimeAsync(0);
    await relay().received(attached, JSON.stringify({ t: "got", id: attached.sent[0]!.id }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await read(answer)).body.result).toEqual(MANIFEST.late);
    expect(attached.closedWith).toBeUndefined();
    await relay().received(attached, JSON.stringify({ t: "answer", id: attached.sent[0]!.id, status: 200, body: {} }));
  });

  it("fails every call sent on a socket the moment it closes", async () => {
    const { relay, desktop } = fixture();
    const attached = await desktop();
    const answers = [relay().call(toolCall(1)), relay().call(toolCall(2))];
    await vi.advanceTimersByTimeAsync(0);
    relay().closed(attached);
    expect((await Promise.all(answers.map(read))).map((answer) => answer.body)).toEqual([
      { jsonrpc: "2.0", id: 1, result: MANIFEST.offline }, { jsonrpc: "2.0", id: 2, result: MANIFEST.offline },
    ]);
  });

  it("runs 8 calls at a time and turns the ninth away", async () => {
    const { relay, desktop } = fixture();
    const attached = await desktop();
    const running = Array.from({ length: 8 }, (_, index) => relay().call(toolCall(index)));
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(relay().call(toolCall(9)))).toMatchObject({ status: 429, body: { id: 9, error: { code: -32000 } } });
    for (const frame of attached.sent) await relay().received(attached, JSON.stringify({ t: "answer", id: frame.id, status: 200, body: {} }));
    await Promise.all(running);
    const next = relay().call(toolCall(10));
    await vi.advanceTimersByTimeAsync(0);
    expect(attached.sent).toHaveLength(9);
    relay().closed(attached);
    await next;
  });

  it("lets the newest desktop take the link: the older one is closed as replaced and its calls fail", async () => {
    const { relay, desktop } = fixture();
    const first = await desktop();
    const waiting = relay().call(toolCall());
    await vi.advanceTimersByTimeAsync(0);
    const second = await desktop();
    expect(first.closedWith).toBe(4001);
    expect((await read(waiting)).body.result).toEqual(MANIFEST.offline);
    const answer = relay().call(toolCall());
    await vi.advanceTimersByTimeAsync(0);
    expect(second.sent).toHaveLength(1);
    await relay().received(second, JSON.stringify({ t: "answer", id: second.sent[0]!.id, status: 200, body: {} }));
    await answer;
  });

  it("closes a socket that sends what is not a frame, an oversized one among them, and ignores an answer to no call", async () => {
    const { relay, desktop } = fixture();
    for (const junk of ["nope", JSON.stringify({ t: "call", id: "x", message: {} }), JSON.stringify({ t: "answer", id: "x", status: 200, body: "x".repeat(GROK_LINK_ANSWER_MAX) })]) {
      const attached = await desktop();
      await relay().received(attached, junk);
      expect(attached.closedWith, junk.slice(0, 20)).toBe(4002);
    }
    const attached = await desktop();
    await relay().received(attached, JSON.stringify({ t: "answer", id: "never-asked", status: 200, body: {} }));
    expect(attached.closedWith).toBeUndefined();
  });

  it("forgets everything when the link is turned off", async () => {
    const { relay, desktop, stored } = fixture();
    const attached = await desktop();
    await relay().purge();
    expect(attached.closedWith).toBe(4004);
    expect(stored()).toBeNull();
    expect((await read(relay().call(rpc("tools/list")))).status).toBe(503);
  });
});
