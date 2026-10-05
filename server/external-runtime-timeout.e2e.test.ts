import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const TOKEN = "external-runtime-timeout-fixture-0123456789abcdef";

// An external caller's ask can outlive the synchronous wait and become a
// delegation it polls. The peer's later answer reaches the receipt and the
// pinned thread; it never starts a turn on the caller's own engine.
it("converts an external caller's long ask into a polled delegation without waking its engine", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-external-timeout-"));
  const gate = join(scratch, "finish-peer");
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
    const session = fixture;
    const control = (...args: string[]) => runControlOmb([...args, "--url", session.info.url]) as Promise<any>;
    const api = async (method: string, path: string, body?: unknown, runtime = false): Promise<any> => {
      const response = await fetch(session.info.url + path, {
        method, headers: { "content-type": "application/json", ...(runtime ? { authorization: `Bearer ${TOKEN}` } : { origin: session.info.url }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
      return value;
    };
    const source = (await control("new-bot", "--name", "External gateway")).bot;
    const peer = (await control("new-bot", "--name", "Slow peer")).bot;
    const sourceThread = source.activeTaskId;
    writeFileSync(join(session.info.dataDir, "external-runtimes.json"), JSON.stringify({ [source.id]: { token: TOKEN, threadId: sourceThread } }), { mode: 0o600 });

    const converted = await api("POST", "/api/internal/ask-bot", { toBotId: peer.id, message: "Only this long question." }, true);
    expect(converted).toMatchObject({ timeout: true, taskId: expect.any(String) });
    writeFileSync(gate, "release only the isolated provider");
    const receipt = () => api("GET", `/api/internal/delegations/${converted.taskId}`, undefined, true);
    await expect.poll(async () => (await receipt()).status, { timeout: 15_000 }).toBe("done");
    expect((await receipt()).result).toContain("Only this long question.");
    expect((await control("wait", "--bot", source.id, "--task", sourceThread)).status).toBe("settled");
    const pinned: any[] = (await api("GET", `/api/threads/${sourceThread}/messages?limit=100`)).messages;
    expect(pinned.some(message => message.from?.botId === peer.id)).toBe(true);
    expect(pinned.filter(message => message.role === "bot" && message.turnId && !message.from)).toEqual([]);
  } finally {
    try { await fixture?.close(); }
    finally { await removeTempDir(scratch); }
  }
}, 60_000);
