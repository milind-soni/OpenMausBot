import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openAppClient, type AppClient } from "./mcp-app-connections.ts";
import { MAX_REMOTE_MCP_BYTES } from "./mcp-http.ts";
import * as procs from "./procs.ts";

const clients: AppClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
});

async function connection() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: Array<{ id?: number; method?: string }> = [];
  const stdin = new Writable({ write(chunk, _encoding, done) { sent.push(JSON.parse(chunk.toString())); done(); } });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr }) as unknown as ReturnType<typeof procs.spawnCli>;
  vi.spyOn(procs, "spawnCli").mockReturnValue(child);
  const stop = vi.spyOn(procs, "killCliTree").mockResolvedValue(true);
  const notifications: string[] = [];
  const signal = new AbortController().signal;
  const opening = openAppClient({ command: "fixture", args: [], env: {} }, {
    onNotification: (method) => notifications.push(method),
  }, false, signal);
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: sent[0]!.id, result: { serverInfo: { name: "fixture" } } })}\n`);
  const client = await opening;
  clients.push(client);
  const request = () => {
    const promise = client.request("resources/read", { uri: "ui://fixture" }, signal);
    const id = sent.at(-1)!.id!;
    return { id, promise };
  };
  return { client, stdout, stop, notifications, request };
}

function reply(id: number, bytes: number, unit = "x"): Buffer {
  const prefix = `{"jsonrpc":"2.0","id":${id},"result":"`;
  const suffix = '"}\n';
  const payload = bytes - Buffer.byteLength(prefix + suffix);
  const unitBytes = Buffer.byteLength(unit);
  return Buffer.from(prefix + unit.repeat(Math.floor(payload / unitBytes)) + "x".repeat(payload % unitBytes) + suffix);
}

const receipt = (promise: Promise<unknown>) => promise.then(
  (value) => ({ status: "fulfilled", bytes: Buffer.byteLength(value as string) }),
  (error: Error) => ({ status: "rejected", message: error.message }),
);

describe("stdio app message byte budgets", () => {
  it.each(["x", "😀"])("keeps an unfinished %s frame counted after a notification in the same chunk", async (unit) => {
    const { client, stdout, notifications, request, stop } = await connection();
    const pending = request();
    const result = receipt(pending.promise);
    const frame = reply(pending.id, MAX_REMOTE_MCP_BYTES + 1, unit);
    const notification = Buffer.from('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n');
    stdout.write(Buffer.concat([notification, frame.subarray(0, 65)]));
    expect(notifications).toEqual(["notifications/tools/list_changed"]);
    stdout.write(frame.subarray(65));
    expect(await result).toMatchObject({ status: "rejected", message: expect.stringContaining("message too large") });
    expect(client.closed).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1_024])("accepts separate bounded frames when a chunk also finishes %i buffered bytes", async (remaining) => {
    const { client, stdout, request } = await connection();
    const first = request(), second = request();
    const results = Promise.all([receipt(first.promise), receipt(second.promise)]);
    const a = reply(first.id, MAX_REMOTE_MCP_BYTES);
    const b = reply(second.id, 2_048);
    if (remaining) stdout.write(a.subarray(0, a.length - remaining));
    stdout.write(Buffer.concat([remaining ? a.subarray(a.length - remaining) : a, b]));
    expect((await results).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(client.closed).toBe(false);
  });

  it("still rejects one oversized frame without any earlier line", async () => {
    const { client, stdout, request } = await connection();
    const pending = request();
    const result = receipt(pending.promise);
    stdout.write(reply(pending.id, MAX_REMOTE_MCP_BYTES + 1));
    expect(await result).toMatchObject({ status: "rejected", message: expect.stringContaining("message too large") });
    expect(client.closed).toBe(true);
  });

  it("accepts an exactly bounded UTF-8 frame split inside a code point", async () => {
    const { client, stdout, request } = await connection();
    const pending = request();
    const result = receipt(pending.promise);
    const frame = reply(pending.id, MAX_REMOTE_MCP_BYTES, "😀");
    const split = frame.indexOf(Buffer.from("😀")) + 1;
    stdout.write(frame.subarray(0, split));
    stdout.write(frame.subarray(split));
    const response = await result;
    expect(response).toEqual({ status: "fulfilled", bytes: MAX_REMOTE_MCP_BYTES - Buffer.byteLength(`{"jsonrpc":"2.0","id":${pending.id},"result":""}\n`) });
    expect(client.closed).toBe(false);
  });
});
