import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const TOKEN = "external-runtime-busy-fixture-0123456789abcdef";

it.each(["already busy", "became busy during approval"])(
  "drains an idle external caller's ask when the peer %s, without losing or repeating approval",
  async scenario => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-external-busy-"));
    const gate = join(scratch, "finish-peer");
    const prompts = join(scratch, "prompts.jsonl");
    let fixture: VerificationServer | undefined;
    const evidence: unknown[] = [];
    try {
      fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow",
        FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_PROMPTS: prompts });
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
      const peer = (await control("new-bot", "--name", "Occupied peer")).bot;
      const sourceThread = source.activeTaskId;
      const peerThread = peer.activeTaskId;
      const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
      const sourceCards = async () => (await messages(sourceThread)).filter(message => ["ask_bot", "delegate_bot"].includes(message.card?.tool));
      const peerRequests = async () => (await messages(peerThread)).filter(message => message.role === "user" && message.peerAsk?.botId === source.id);
      const sourceState = async () => (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === source.id);
      const receipt = (id: string) => api("GET", `/api/internal/delegations/${id}`, undefined, true);
      const withholdAfterRevocation = async (id: string) => {
        await api("PATCH", `/api/bots/${source.id}`, { peers: [] });
        const response = await fetch(`${session.info.url}/api/internal/delegations/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "Result withheld: team access changed while the teammate was working" });
        await api("PATCH", `/api/bots/${source.id}`, { peers: [peer.id], acknowledgePeerScope: true });
      };
      const waiting = (id: string) => {
        const path = join(session.info.dataDir, "delegations.json");
        return existsSync(path) && JSON.parse(readFileSync(path, "utf8"))[sourceThread]?.find((item: any) => item.id === id)?.waitingOnBusy === true;
      };
      await api("PATCH", `/api/bots/${source.id}`, { approvePeerComms: true });
      writeFileSync(join(session.info.dataDir, "external-runtimes.json"), JSON.stringify({ [source.id]: { token: TOKEN, threadId: sourceThread } }), { mode: 0o600 });
      const requestText = `Only this queued request: ${scenario}`;
      const occupy = async () => {
        await control("send", "--bot", peer.id, "--task", peerThread, "--text", "Keep this unrelated turn running until the fixture gate opens.");
        await expect.poll(() => existsSync(prompts) && readFileSync(prompts, "utf8").includes("Keep this unrelated turn running"), { timeout: 15_000 }).toBe(true);
      };
      const approve = async (card: any) => api("POST", `/api/threads/${sourceThread}/respond`, { requestId: card.card.requestId, behavior: "allow" });
      let queued: any;
      if (scenario === "already busy") {
        await occupy();
        queued = await api("POST", "/api/internal/ask-bot", { toBotId: peer.id, message: requestText }, true);
        expect(await sourceCards()).toHaveLength(0);
      } else {
        // Attach a rejection handler immediately: fixture teardown must not
        // turn a failed assertion into an unhandled in-flight HTTP rejection.
        const pendingAsk = api("POST", "/api/internal/ask-bot", { toBotId: peer.id, message: requestText }, true)
          .then(value => ({ value }), error => ({ error }));
        await expect.poll(async () => (await sourceCards()).length, { timeout: 15_000 }).toBe(1);
        const [card] = await sourceCards();
        expect(card.card.tool).toBe("ask_bot");
        expect(await peerRequests()).toHaveLength(0);
        await occupy();
        await approve(card);
        const outcome = await pendingAsk;
        if ("error" in outcome) throw outcome.error;
        queued = outcome.value;
      }
      expect(queued).toMatchObject({ busy: true, taskId: expect.any(String) });
      evidence.push({ scenario, queued, sourceThread, peerThread });
      // This is the lost-wakeup boundary: merely storing a fresh queue item
      // does not subscribe it to the target's next idle transition.
      await expect.poll(() => waiting(queued.taskId), { timeout: 5_000 }).toBe(true);
      expect(await peerRequests()).toHaveLength(0);
      expect((await sourceState()).busy).toBeFalsy();
      expect((await messages(sourceThread)).filter(message => message.role === "user")).toHaveLength(0);
      await withholdAfterRevocation(queued.taskId);
      evidence.push({ scenario, queued, waitingOnBusy: true, beforeRelease: await sourceCards() });

      writeFileSync(gate, "release only the isolated provider");
      if (scenario === "already busy") {
        await expect.poll(async () => (await sourceCards()).length, { timeout: 15_000 }).toBe(1);
        const [card] = await sourceCards();
        expect(card.card.tool).toBe("delegate_bot");
        expect(card.card.answered).toBeFalsy();
        expect(await peerRequests()).toHaveLength(0);
        await approve(card);
      }
      await expect.poll(async () => (await receipt(queued.taskId)).status, { timeout: 20_000 }).toBe("done");
      expect((await receipt(queued.taskId)).result).toContain(requestText);
      expect((await control("wait", "--bot", peer.id, "--task", peerThread)).status).toBe("settled");
      const requests = await peerRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].text).toContain(requestText);
      expect((await sourceCards()).map(card => ({ tool: card.card.tool, answered: card.card.answered })))
        .toEqual([{ tool: scenario === "already busy" ? "delegate_bot" : "ask_bot", answered: "allow" }]);
      await withholdAfterRevocation(queued.taskId);
      evidence.push({ receipt: await receipt(queued.taskId), sourceMessages: await messages(sourceThread), peerMessages: await messages(peerThread) });
    } finally {
      try {
        if (fixture) {
          const bots = await fetch(`${fixture.info.url}/api/bots?messages=0`).then(response => response.json()).catch(() => null);
          evidence.push({ finalBots: bots });
          writeFileSync(`${fixture.info.logPath}.external-busy.json`, JSON.stringify(evidence, null, 2));
          console.info("External runtime busy evidence saved.");
        }
      } finally {
        try { await fixture?.close(); }
        finally { await removeTempDir(scratch); }
      }
    }
  },
  60_000,
);
