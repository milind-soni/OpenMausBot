// A person's steer in a one-at-a-time room where the lead handed out jobs: it never folds into a member's job,
// and nothing stops; the lead takes the line, on an isolated fixture with the real coordination proxy.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

it("with parallel room jobs off, an unnamed steer while a member works a handed job stays queued for the lead and stops nothing", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { OPENMAUSBOT_URL: session.info.url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, headers: { Origin: session.info.url }, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    // Side-by-side room jobs (the default) run a handed job in its own thread, so the person's line goes to
    // the lead at once; the one-at-a-time room is where a steer could fold into a member's job.
    expect((await api("/api/config", { features: { parallelRoomJobs: false } }, "PATCH")).features.parallelRoomJobs).toBe(false);
    const lead = (await cli("new-bot", "--name", "Lead", "--section", "A")).bot;
    const first = (await cli("new-bot", "--name", "First", "--section", "A")).bot;
    const second = (await cli("new-bot", "--name", "Second", "--section", "A")).bot;
    const room = (await api("/api/groups", {
      name: "Studio", memberIds: [lead.id, first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).group;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const gate = join(session.info.dataDir, "first.gate");
    const ready = join(session.info.dataDir, "first.ready");
    writeFileSync(planPath, JSON.stringify({
      [lead.id]: { steps: [{ arguments: { bot_ids: [first.id, second.id], message: "Each of you, cut one part" } }], reply: "Assigned", resumeReply: "All parts reviewed" },
      [first.id]: { reply: "First part cut", gateFile: gate, readyFile: ready, echoSteered: true },
      [second.id]: { reply: "Second part cut" },
    }));
    await cli("send-channel", "--channel", room.id, "--text", "Split the work");
    await expect.poll(() => existsSync(ready), { timeout: 30_000 }).toBe(true);

    const queued = await api(`/api/groups/${room.id}/messages`, { text: "Change of plan: drop the second part" });
    expect(queued).toMatchObject({ ok: true, queued: true });
    const steer = await api(`/api/groups/${room.id}/queue/${queued.queueId}/steer`, { threadId: room.threadId });
    expect(steer).toMatchObject({ ok: true, queued: true, blockedBy: "addressee" });

    writeFileSync(gate, "release");
    expect((await cli("wait", "--channel", room.id, "--timeout", "60")).status).toBe("settled");
    const jobs = readHandoffs(session.info.dataDir).filter((n: any) => n.parentId && n.text === "Each of you, cut one part");
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.every((n: any) => n.status === "completed")).toBe(true);

    const messages = (await api(`/api/threads/${room.threadId}/messages`, undefined, "GET")).messages;
    expect(JSON.stringify(messages)).not.toContain("+ steered");
    expect(messages.find((m: any) => m.text === "Change of plan: drop the second part")?.steered).toBeUndefined();
    const turns = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const tookIt = turns.find((t: any) => JSON.stringify(t.prompt ?? "").includes("Change of plan: drop the second part"));
    expect(tookIt?.botId).toBe(lead.id);
  } finally {
    await session.close();
  }
}, 120_000);
