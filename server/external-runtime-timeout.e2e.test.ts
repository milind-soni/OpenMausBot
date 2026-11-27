import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const TOKEN = "external-runtime-timeout-fixture-0123456789abcdef";

it("answers an external caller's long ask at once and lets it poll the slow peer's answer without waking its engine", async () => {
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

    const started = Date.now();
    const asked = await api("POST", "/api/internal/coordinate-bots", { botIds: [peer.id], message: "Only this long question.", consult: true }, true);
    // Immediate: the peer's turn is held open by the gate the whole time.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(asked).toMatchObject({ rootId: expect.any(String), receipts: [{ botId: peer.id, outcome: "queued", requestId: expect.any(String) }] });
    expect(asked.deprecation).toBeUndefined();
    expect(asked.text).toBeUndefined();
    expect(asked.timeout).toBeUndefined();
    const id: string = asked.receipts[0].requestId;
    const receipt = () => api("GET", `/api/internal/assignment-status?id=${id}`, undefined, true);
    await expect.poll(async () => (await receipt()).assignment.status, { timeout: 15_000 }).toBe("running");
    expect((await receipt()).assignment).toMatchObject({ id, botId: peer.id, mode: "consult", reply: "poll" });
    expect((await receipt()).deprecation).toBeUndefined();
    expect((await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === peer.id).busy).toBeTruthy();
    const workThread = readHandoffs(session.info.dataDir).find(node => node.id === id)!.threadId;
    expect(workThread).not.toBe(peer.activeTaskId);

    writeFileSync(gate, "release only the isolated provider");
    await expect.poll(async () => (await receipt()).assignment.status, { timeout: 15_000 }).toBe("completed");
    expect((await receipt()).assignment.result).toContain("Only this long question.");
    await expect.poll(() => readHandoffs(session.info.dataDir).find(node => node.id === asked.rootId)?.status, { timeout: 10_000 }).toBe("completed");
    expect(readHandoffs(session.info.dataDir).find(node => node.id === asked.rootId)).toMatchObject({ reply: "poll", threadId: sourceThread });
    expect((await control("wait", "--bot", source.id, "--task", sourceThread)).status).toBe("settled");
    const pinned: any[] = (await api("GET", `/api/threads/${sourceThread}/messages?limit=100`)).messages;
    expect(pinned.some(message => message.from?.botId === peer.id)).toBe(true);
    expect(pinned.filter(message => message.role === "bot" && message.turnId && !message.from)).toEqual([]);
  } finally {
    try { await fixture?.close(); }
    finally { await removeTempDir(scratch); }
  }
}, 60_000);
