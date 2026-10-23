import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

it("dispatches a native direct assignment with its recorded Auto grant while preserving the recipient's saved Ask mode", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  try {
    const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, {
        method, headers: { origin: url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json() as any;
      expect(response.status, JSON.stringify(value)).toBeLessThan(300);
      return value;
    };
    const chief = (await cli("new-bot", "--name", "Native fixture Chief", "--section", "Engineering")).bot;
    const worker = (await cli("new-bot", "--name", "Native fixture Worker", "--section", "Engineering")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvalMode: "auto", acknowledgeLocalAuto: true });
    await api("PATCH", `/api/bots/${worker.id}`, { approvalMode: "ask" });
    const plan = join(dataDir, "room-plan.json");
    writeFileSync(plan, JSON.stringify({
      [chief.id]: { script: [
        { key: "delegate", match: ["NATIVE_DELEGATION"], steps: [{ arguments: { bot_ids: [worker.id], message: "Return the synthetic status NATIVE_DONE." } }], reply: "Assignment queued." },
        { key: "resume", match: ["Your downstream room requests have settled."], reply: "The synthetic result arrived." },
      ] },
      [worker.id]: { reply: "NATIVE_DONE" },
    }));
    const turns = (): any[] => existsSync(`${plan}.evidence.jsonl`)
      ? readFileSync(`${plan}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "NATIVE_DELEGATION: ask the fixture Worker for the synthetic status.");
    await expect.poll(() => turns().find(turn => turn.botId === worker.id), { timeout: 25_000 }).toBeDefined();
    const dispatched = turns().find(turn => turn.botId === worker.id);
    expect(dispatched.permissionMode).toBe("auto");
    const assignment = readHandoffs(dataDir).find(row => row.botId === worker.id && row.parentId);
    expect(assignment).toMatchObject({ level: "auto", mode: "work" });
    expect((await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "25")).status).toBe("settled");
    const saved = (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === worker.id);
    expect(saved.approvalMode).toBe("ask");
    expect(saved.tasks.every((task: any) => task.approvalMode !== "auto")).toBe(true);
  } finally { await fixture.close(); }
}, 60_000);
