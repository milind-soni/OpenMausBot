import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("Clive reviews multi-provider teams once, continues after each decision, and preserves existing threads through setup and deletion", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-team-setup-gates-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string, fromApp = true) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json",
      ...(fromApp ? { origin: fixture.info.url } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    // Never record provider environment/capabilities. Keep actions and safe results.
    evidence.push({ method, path, body, authority: token ? "turn capability" : fromApp ? "app review" : "originless loopback", status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected); return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result }); return result;
  };
  try {
    const catalog = (await api("GET", "/api/instances")).instances;
    const claude = catalog.find((item: any) => item.instanceId === "claude");
    const codex = catalog.find((item: any) => item.instanceId === "codex");
    expect(codex).toBeDefined();
    const selection = (instance: any) => ({ instanceId: instance.instanceId, model: instance.models.default });
    const chief = (await api("POST", "/api/bots", { name: "Clive", title: "Chief of Staff", section: "Operations", modelSelection: selection(claude) }, 201)).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const state = async () => (await api("GET", "/api/bots")).bots;
    let previousPid: number | undefined;
    const start = async (text: string) => {
      if (existsSync(gate)) unlinkSync(gate);
      await control("send", "--bot", chief.id, "--task", chief.threadId, "--text", text);
      await expect.poll(() => {
        if (!existsSync(fixture.fixtureDumpPath)) return false;
        return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid !== previousPid;
      }, { timeout: 15_000 }).toBe(true);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); previousPid = dump.pid;
      return dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;
    };
    const finish = async () => {
      writeFileSync(gate, "finish");
      await expect.poll(async () => !(await state()).find((bot: any) => bot.id === chief.id).busy, { timeout: 20_000 }).toBe(true);
    };
    const continueOnce = async (requestId: string) => {
      await expect.poll(async () => {
        const bot = (await state()).find((bot: any) => bot.id === chief.id);
        return !bot.busy && bot.messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.text?.includes(`team setup decision ${requestId}:`)).length;
      }, { timeout: 20_000 }).toBe(1);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); previousPid = dump.pid;
      evidence.push({ continuation: { requestId, prompt: dump.prompt, provider: "fixture claude", exactlyOneReply: true } });
    };
    const stopWithoutResume = async (requestId: string, threadId: string, target: "--bot" | "--channel", id: string) => {
      const stoppedPid = previousPid;
      await control("interrupt", target, id, "--task", threadId);
      writeFileSync(gate, "finish");
      await control("wait", target, id, "--task", threadId, "--timeout", "15");
      // Allow an erroneously queued provider handshake/reply to become visible.
      await new Promise((resolve) => setTimeout(resolve, 350));
      await api("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" });
      const messages = (await api("GET", `/api/threads/${threadId}/messages`)).messages;
      expect(messages.some((message: any) => message.text?.includes(`team setup decision ${requestId}:`))).toBe(false);
      expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid).toBe(stoppedPid);
      expect((await state()).find((bot: any) => bot.id === chief.id).busy).toBe(false);
      evidence.push({ cancellation: { requestId, threadId, noNewProviderGeneration: true, noContinuationReply: true } });
    };
    const build = (name: string, team: string, modelSelection: unknown) => ({ action: "create", key: name, fields: {
      name, title: `${team} specialist`, soul: `Own ${team.toLowerCase()} work. Return evidence and state uncertainty.`, section: team, modelSelection,
    } });
    const plan = { reason: "Set up Research, Engineering and Growth specialists as requested", newTeams: ["Research", "Engineering", "Growth"], operations: [
      build("Mira", "Research", selection(claude)), build("Patch", "Engineering", selection(codex)), build("Quill", "Growth", selection(claude)),
      { action: "create", key: "Patch", fields: { title: "Implementation and verification engineer" } },
    ] };
    let token = await start("Clive, review this setup while you are working.");
    const stopped = await api("POST", "/api/internal/team-setup-requests", { plan }, 201, token);
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: stopped.requestId, behavior: "deny" });
    await stopWithoutResume(stopped.requestId, chief.threadId, "--bot", chief.id);
    token = await start("Clive, set up Research, Engineering and Growth specialists with suitable engines and models.");
    const tools = await api("GET", "/api/internal/team-setup-catalog", undefined, 200, token);
    expect(tools.instances.map((item: any) => item.instanceId)).toEqual(expect.arrayContaining(["claude", "codex"]));
    await api("POST", "/api/internal/team-setup-requests", { plan: { ...plan, operations: [build("Bad", "Research", { instanceId: "codex", model: "invented-model" })] } }, 400, token);
    await api("POST", "/api/internal/team-setup-requests", { fromBotId: "foreign", plan }, 403, token);
    const denied = await api("POST", "/api/internal/team-setup-requests", { plan }, 201, token);
    expect((await state()).filter((bot: any) => ["Mira", "Patch", "Quill"].includes(bot.name))).toHaveLength(0);
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: denied.requestId, behavior: "deny" });
    await finish(); await continueOnce(denied.requestId);
    expect((await state()).find((bot: any) => bot.id === chief.id).managedSections).toBeUndefined();

    token = await start("Apply the reviewed Research, Engineering and Growth setup.");
    const proposed = await api("POST", "/api/internal/team-setup-requests", { plan }, 201, token);
    const before = (await state()).find((bot: any) => bot.id === chief.id);
    const card = before.messages.find((message: any) => message.card?.requestId === proposed.requestId).card;
    expect(card.teamSetupRequest.operations).toHaveLength(3);
    expect(card.subtitle).toContain("Authorize @Clive");
    // Origin is forgeable by an active bot shell: it cannot self-grant teams.
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" }, 403);
    expect((await state()).some((bot: any) => bot.name === "Patch")).toBe(false);
    await finish();
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" }, 403, undefined, false);
    const approved = await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" });
    expect(approved.result.state).toBe("applied"); await continueOnce(proposed.requestId);
    const saved = await state();
    const engineer = saved.find((bot: any) => bot.name === "Patch");
    expect(engineer).toMatchObject({ title: "Implementation and verification engineer", section: "Engineering", modelSelection: selection(codex), approvalMode: "ask", autoApprove: false, composio: false });
    expect(saved.find((bot: any) => bot.id === chief.id).managedSections).toEqual(expect.arrayContaining(plan.newTeams));
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" });
    expect((await state()).filter((bot: any) => bot.name === "Patch")).toHaveLength(1);
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid).toBe(previousPid);

    token = await start("Move Patch to Growth and switch its default engine to Claude; retain its existing thread.");
    const updated = await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "Requested default and team change", operations: [
      { action: "update", botId: engineer.id, fields: { section: "Growth", modelSelection: selection(claude) } },
      { action: "update", botId: engineer.id, fields: { description: "Shared delivery specialist" } },
    ] } }, 201, token);
    await finish(); await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: updated.requestId, behavior: "allow" }); await continueOnce(updated.requestId);
    const changed = (await state()).find((bot: any) => bot.id === engineer.id);
    expect(changed).toMatchObject({ section: "Growth", modelSelection: selection(claude), description: "Shared delivery specialist" });
    expect(changed.tasks.find((task: any) => task.threadId === engineer.threadId).modelSelection).toEqual(selection(codex));

    token = await start("Review another profile change for Patch.");
    const stale = await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "Review stale behavior", operations: [
      { action: "update", botId: engineer.id, fields: { title: "Stale title" } },
    ] } }, 201, token);
    await api("PATCH", `/api/bots/${engineer.id}`, { title: "Newer user title" });
    await finish();
    expect((await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: stale.requestId, behavior: "allow" })).result.state).toBe("cancelled");
    await continueOnce(stale.requestId);
    expect((await state()).find((bot: any) => bot.id === engineer.id).title).toBe("Newer user title");

    token = await start("Delete Patch as a separately confirmed cleanup.");
    const deletion = await api("POST", "/api/internal/bot-deletion-requests", { targetBotId: engineer.id, reason: "User explicitly requested deletion" }, 201, token);
    expect(deletion.detail).toContain("Permanently removes");
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: deletion.requestId, behavior: "allow" }, 403);
    expect((await state()).some((bot: any) => bot.id === engineer.id)).toBe(true);
    await finish();
    expect((await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: deletion.requestId, behavior: "allow" })).result.bots).toEqual([{ id: engineer.id, name: "Patch", action: "deleted" }]);
    await continueOnce(deletion.requestId);
    expect((await state()).some((bot: any) => bot.id === engineer.id)).toBe(false);
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: deletion.requestId, behavior: "allow" });
    const room = (await control("new-channel", "--name", "Chief review", "--members", chief.id)).channel;
    unlinkSync(gate);
    await control("send-channel", "--channel", room.id, "--task", room.activeTaskId, "--text", "@Clive Review another setup, then wait.");
    await expect.poll(() => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid, { timeout: 15_000 }).not.toBe(previousPid);
    const groupDump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); previousPid = groupDump.pid;
    const groupStopped = await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "Check room Stop", operations: [
      build("NoRestart", "Operations", selection(claude)),
    ] } }, 201, groupDump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN);
    await api("POST", `/api/threads/${room.activeTaskId}/respond`, { requestId: groupStopped.requestId, behavior: "deny" });
    await stopWithoutResume(groupStopped.requestId, room.activeTaskId, "--channel", room.id);
    expect((await state()).some((bot: any) => bot.name === "NoRestart")).toBe(false);
    await control("messages", "--bot", chief.id, "--task", chief.threadId, "--limit", "30");
    await control("wait", "--bot", chief.id, "--task", chief.threadId, "--timeout", "15");
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toMatch(/ReferenceError|change listener threw/);
  } finally {
    const evidencePath = `${fixture.info.logPath}.team-setup.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    await fixture.close(); await removeTempDir(gates);
  }
}, 150_000);
