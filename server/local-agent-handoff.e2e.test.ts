import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

it("dispatches tracked local CLI results to their owner and projects outstanding activity", async () => {
  const sockets = new Map<string, Socket>();
  const gate = createServer(socket => socket.once("data", data => sockets.set(String(data).trim(), socket)));
  await new Promise<void>(resolve => gate.listen(0, "127.0.0.1", resolve));
  const address = gate.address();
  if (!address || typeof address === "string") throw new Error("fixture gate did not bind");
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, undefined, true);
  const { dataDir, url, logPath } = fixture.info;
  console.info("Local agent fixture:", logPath);
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const agent = fileURLToPath(new URL("./testing/fake-external-agent.mjs", import.meta.url));
  const uiModule = "../src/components/SidebarBotActivity.tsx";
  const { attentionHasRunningWork, attentionRowStatus, crossBotAttentionThreads, SidebarBotActivity } = await import(uiModule);
  const planPath = join(dataDir, "room-plan.json");
  const evidence: unknown[] = [];
  try {
    for (const [variant, exitCode, action, delegated] of [["codex", 0, "finish", false], ["claude", 7, "finish", true], ["unknown", 0, "unknown", false], ["cancelled", 0, "cancel", false], ["revoked", 0, "revoke", false], ["revoked-validation", 0, "revoke-validation", false]] as const) {
      const { bot: worker } = await control("new-bot", "--name", `Worker ${variant}`, "--section", "Team");
      const { bot: owner } = delegated ? await control("new-bot", "--name", `Owner ${variant}`, "--section", "Team") : { bot: worker };
      await api("PATCH", `/api/bots/${worker.id}`, { approvalMode: "full", computer: "off", browser: false });
      if (delegated) await api("PATCH", `/api/bots/${owner.id}`, { chiefOfStaff: true, managedSections: ["Team"], acknowledgePeerScope: true, approvalMode: "full", computer: "off", browser: false });
      const artifact = join(dataDir, "workspaces", worker.id, `result-${variant}.json`);
      const start = { tool: "start_external_agent", arguments: { executable: process.execPath, args: [agent, String(address.port), variant, String(exitCode), artifact] } };
      const validate = { tool: "attach_file", arguments: { path: artifact } };
      const ready = join(dataDir, `validation-ready-${variant}`), release = join(dataDir, `validation-release-${variant}`);
      const validationReply = action === "unknown" ? "External agent status is unknown" : exitCode === 0 ? "Validated exit 0" : `External agent failed with exit ${exitCode}`;
      const revoke = () => {
        const folder = join(dataDir, "workspaces", worker.id, ".claude");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "settings.json"), JSON.stringify({ permissions: { deny: ["Bash"] } }));
      };
      const workerPlan = { script: [
        { key: `start-${variant}`, match: [`Run fixture ${variant}`], steps: [start], reply: "The external process is running." },
        { key: `validate-${variant}`, match: [action === "unknown" ? "A background command for this task has an unknown status." : "A background command for this task ended."], expectContextIncludes: ["terminal result · information only", "exitCode"], steps: action === "unknown" ? [] : [validate], readyFile: ready, gateFile: release, reply: validationReply },
      ] };
      writeFileSync(planPath, JSON.stringify(delegated ? {
        [owner.id]: { steps: [{ arguments: { bot_ids: [worker.id], message: `Run fixture ${variant}` } }], reply: "Assigned", resumeReply: `Owner checked ${variant}` },
        [worker.id]: workerPlan,
      } : { [worker.id]: workerPlan }));
      await control("send", "--bot", owner.id, "--task", owner.activeTaskId, "--text", `Run fixture ${variant}`);
      await expect.poll(() => readHandoffs(dataDir).find(n => n.botId === worker.id)?.status, { timeout: 30_000 }).toBe("waiting");
      await expect.poll(() => sockets.has(variant), { timeout: 10_000 }).toBe(true);
      const row = readHandoffs(dataDir).find(n => n.botId === worker.id)!;
      const bots = (await api("GET", "/api/bots")).bots;
      const visible = bots.find((bot: any) => bot.id === worker.id);
      const task = visible.tasks.find((item: any) => item.threadId === row.threadId);
      expect(task).toMatchObject({ waitingForExternalAgent: true, busy: false });
      const attention = crossBotAttentionThreads(bots, {}).filter((entry: { kind: string; task: { threadId: string } }) => entry.kind === "bot" && entry.task.threadId === row.threadId);
      expect(attentionHasRunningWork(attention)).toBe(true);
      expect(attentionRowStatus(attention[0]!.task).label).toBe("Waiting for an external agent");
      const markup = renderToStaticMarkup(createElement(SidebarBotActivity, { bot: visible, rowThreadId: "", density: "comfortable", pendingQueued: {}, dispatch: () => {} }));
      expect(markup).toContain("Waiting for an external agent");
      if (action === "cancel" || action === "revoke") {
        if (action === "cancel") await control("interrupt", "--bot", worker.id, "--task", row.threadId);
        else revoke();
        await expect.poll(() => readHandoffs(dataDir).find(n => n.id === row.id)?.status, { timeout: 10_000 }).toBe(action === "cancel" ? "cancelled" : "failed");
        await expect.poll(() => sockets.get(variant)!.destroyed || sockets.get(variant)!.writableEnded, { timeout: 10_000 }).toBe(true);
      } else {
        sockets.get(variant)!.write("finish");
        await expect.poll(() => existsSync(ready), { timeout: 40_000 }).toBe(true);
        await expect.poll(async () => {
          const current = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === worker.id);
          return current.tasks.find((item: any) => item.threadId === row.threadId)?.busy;
        }, { timeout: 10_000 }).toBe(true);
        if (action === "revoke-validation") revoke();
        else writeFileSync(release, "continue");
        await expect.poll(() => readHandoffs(dataDir).find(n => n.id === row.id)?.status, { timeout: 40_000 }).toBe(action === "revoke-validation" ? "failed" : "completed");
        if (action !== "unknown") expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual({ variant, exitCode });
        const finished = readHandoffs(dataDir).find(n => n.id === row.id)!;
        if (action !== "revoke-validation") expect(finished).toMatchObject({ executions: 2, result: validationReply });
        if (action === "unknown") {
          const messages = await control("messages", "--bot", worker.id, "--task", row.threadId, "--limit", "30");
          expect(JSON.stringify(messages)).toContain("External agent status is unknown. Check its work before retrying.");
        }
      }
      await expect.poll(async () => {
        const updated = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === worker.id);
        return updated.tasks.find((item: any) => item.threadId === row.threadId)?.waitingForExternalAgent;
      }, { timeout: 10_000 }).toBe(false);
      evidence.push({ variant, exitCode, action, delegated, row, attention });
    }
    const plans = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(plans.filter(turn => String(turn.planKey).startsWith("validate-"))).toHaveLength(3);
    const successContext = JSON.stringify(plans.find(turn => turn.planKey === "validate-codex")).replaceAll("\\", "");
    expect(successContext).toContain('"stdoutTruncated":true');
    const failedContext = JSON.stringify(plans.find(turn => turn.planKey === "validate-claude")).replaceAll("\\", "");
    expect(failedContext).toContain('(From a person · approval');
    expect(failedContext).toContain('"exitCode":7');
    expect(plans.filter(turn => turn.unplanned)).toEqual([]);
    writeFileSync(`${logPath}.local-agent.json`, JSON.stringify({ evidence, plans }, null, 2));
  } finally {
    for (const socket of sockets.values()) socket.destroy();
    await fixture.close();
    await new Promise<void>(resolve => gate.close(() => resolve()));
  }
}, 150_000);
