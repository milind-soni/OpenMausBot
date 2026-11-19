// A hand-off's status where people already look: Lead hands Coder a page, Coder hands Writer the copy, and Lead's "Sent
// to Coder" row moves through claimed, working, waiting on Writer and done, while Coder's work conversation (what the
// inbox lists) carries the same status. The scripted engine makes the real coordinate_bots calls through the agents
// server; nobody presses anything.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

it("moves the Sent-to row through claimed, working, waiting on a teammate and done, and the work conversation shows the same", async () => {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, init?: { method: string; body: unknown }) =>
    request(path, init ? { method: init.method, body: JSON.stringify(init.body) } : {}, session.info.url) as Promise<any>;
  const plan = join(session.info.dataDir, "room-plan.json");
  const coderGate = join(session.info.dataDir, "coder-gate"), writerGate = join(session.info.dataDir, "writer-gate");
  try {
    const lead = (await cli("new-bot", "--name", "Lead", "--section", "Team")).bot;
    const coder = (await cli("new-bot", "--name", "Coder", "--section", "Team")).bot;
    const writer = (await cli("new-bot", "--name", "Writer", "--section", "Team")).bot;
    await api(`/api/bots/${lead.id}`, { method: "PATCH", body: { chiefOfStaff: true, managedSections: ["Team"], acknowledgePeerScope: true } });
    writeFileSync(plan, JSON.stringify({
      [lead.id]: { steps: [{ arguments: { bot_ids: [coder.id], message: "Build the page" } }], reply: "Asked Coder", resumeReply: "All done" },
      [coder.id]: { steps: [{ arguments: { bot_ids: [writer.id], message: "Write the copy" } }], gateFile: coderGate, reply: "Asked Writer", resumeReply: "Page built" },
      [writer.id]: { gateFile: writerGate, reply: "Copy written" },
    }));

    const seen: string[] = [];
    const sentRow = async () => {
      const rows = (await api(`/api/threads/${lead.activeTaskId}/messages?limit=100`)).messages as any[];
      const row = rows.find((message) => message.threadRef?.botId === coder.id);
      const state = row?.handoff ? (row.handoff.waitingOn ? `${row.handoff.state}:${row.handoff.waitingOn.name ?? row.handoff.waitingOn.kind}` : row.handoff.state) : undefined;
      if (state && seen.at(-1) !== state) seen.push(state);
      return { row, state };
    };
    const coderTask = async () => {
      const bots = (await api("/api/bots")).bots as any[];
      return (bots.find((bot) => bot.id === coder.id)?.tasks ?? []).find((task: any) => task.handoff);
    };

    await cli("send", "--bot", lead.id, "--task", lead.activeTaskId, "--text", "Get the landing page built.");
    await expect.poll(async () => (await sentRow()).state, { timeout: 30_000, interval: 100 }).toBe("working");
    expect((await coderTask())?.handoff).toMatchObject({ state: "working" });

    writeFileSync(coderGate, "go");
    await expect.poll(async () => (await sentRow()).state, { timeout: 30_000, interval: 100 }).toBe("waiting:Writer");
    expect((await coderTask())?.handoff).toMatchObject({ state: "waiting", waitingOn: { kind: "bot", name: "Writer" } });

    writeFileSync(writerGate, "go");
    await expect.poll(async () => (await sentRow()).state, { timeout: 30_000, interval: 100 }).toBe("done");
    const { row } = await sentRow();
    expect(row.handoff).toEqual({ id: expect.any(String), state: "done", at: expect.any(Number) });
    expect(row.handoff.forPerson).toBeUndefined();
    expect(seen.filter((state) => state !== "claimed")).toEqual(["working", "waiting:Writer", "done"]);
    expect((await coderTask())?.handoff).toMatchObject({ state: "done" });
    const rows = (await api(`/api/threads/${lead.activeTaskId}/messages?limit=100`)).messages as any[];
    expect(rows.filter((message) => message.kind === "options" && !message.card?.answered)).toEqual([]);
  } finally {
    await session.close();
  }
}, 120_000);
