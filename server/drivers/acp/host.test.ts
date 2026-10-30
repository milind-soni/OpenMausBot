import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { AcpHost, type AcpInbound } from "./host.ts";

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, pid: undefined });
  const written: any[] = [];
  child.stdin.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) written.push(JSON.parse(line)); });
  const say = (msg: unknown) => child.stdout.write(JSON.stringify(msg) + "\n");
  return { child: child as unknown as ChildProcessWithoutNullStreams, written, say };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function hostWith(key: string | null) {
  const { child, written, say } = fakeChild();
  const refused: any[] = [];
  const host = new AcpHost(child, key, { source: "test.acp", logMessage: (msg) => msg, keepStderr: true, unrouted: (msg) => refused.push(msg) });
  const heard = new Map<string, any[]>();
  const link = (threadId: string, sessionId: string | null) => {
    const linked = host.link(threadId);
    linked.sessionId = sessionId;
    const inbox: any[] = [];
    heard.set(threadId, inbox);
    linked.inbound = { request: (msg) => inbox.push(msg), notification: (msg) => inbox.push(msg), exit: () => {}, error: () => {}, busy: () => false } satisfies AcpInbound;
    return linked;
  };
  return { host, written, say, refused, heard, link };
}

describe("one ACP process for several threads", () => {
  it("gives each thread only its own session's traffic, and refuses a request for a session no thread holds", async () => {
    const h = hostWith("shared");
    const a = h.link("a", "s-a");
    h.link("b", "s-b");
    h.say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-b", update: { sessionUpdate: "agent_message_chunk" } } });
    h.say({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "s-a" } });
    await flush();
    expect(h.heard.get("a")!.map((msg) => msg.id ?? msg.params.sessionId)).toEqual([7]);
    expect(h.heard.get("b")!.map((msg) => msg.params.sessionId)).toEqual(["s-b"]);
    a.close();
    h.say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-a", update: { sessionUpdate: "agent_message_chunk" } } });
    h.say({ jsonrpc: "2.0", id: 8, method: "session/request_permission", params: { sessionId: "s-a" } });
    await flush();
    expect(h.heard.get("b")!).toHaveLength(1);
    expect(h.refused.map((msg) => msg.id)).toEqual([8]);
  });

  it("answers each request to the thread that asked, and fails only that thread's requests when it leaves", async () => {
    const h = hostWith("shared");
    const a = h.link("a", "s-a");
    const b = h.link("b", "s-b");
    const fromA = a.request("session/prompt", { sessionId: "s-a" });
    const fromB = b.request("session/prompt", { sessionId: "s-b" });
    await flush();
    const ids = h.written.map((msg) => msg.id);
    h.say({ jsonrpc: "2.0", id: ids[1], result: { stopReason: "end_turn" } });
    await expect(fromB).resolves.toEqual({ stopReason: "end_turn" });
    a.close();
    await expect(fromA).rejects.toThrow("session closed");
  });

  it("keeps a single thread's process routing everything to it, as before sharing", async () => {
    const h = hostWith(null);
    h.link("only", "s-1");
    h.say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agent-renamed", update: {} } });
    h.say({ jsonrpc: "2.0", method: "session/update", params: { update: {} } });
    await flush();
    expect(h.heard.get("only")).toHaveLength(2);
  });
});
