// Real server + injected MCP tools; only the provider's planning is scripted.
// Persisted Full grants below belong exclusively to this stopped fixture.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("applies requested Full Access workflows through MCP without duplicate approvals, while exact Ask tasks still wait", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: any[] }> = {};
  const evidence: unknown[] = [];
  let restarted: ChildProcess | undefined;
  const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(`${url}${path}`, { method,
      headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result });
    return result;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const bots = async () => (await api("GET", "/api/bots")).bots as any[];
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const unanswered = async (threadId: string) => (await messages(threadId)).filter(message => message.card && !message.card.answered && !message.card.dismissed);
  const step = (tool: string, args: unknown, expectError = false) => ({ tool, arguments: args, expectError });
  const run = async (bot: any, threadId: string, text: string, steps: any[], options: { pending?: boolean; resumeReply?: string } = {}) => {
    const before = providerTurns().length;
    const reply = `Fixture result ${before}: ${text}`;
    (plans[bot.id] ??= { turns: [] }).turns.push({ steps, reply });
    if (options.resumeReply) plans[bot.id].turns.push({ reply: options.resumeReply });
    writeFileSync(planPath, JSON.stringify(plans));
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
    const expectedTurns = options.resumeReply ? 3 : 1; // caller, requested teammate, caller's one summary
    await expect.poll(() => providerTurns().length, { timeout: 25_000 }).toBe(before + expectedTurns);
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "25")).status).toBe(options.pending ? "needs-user" : "settled");
    const turns = providerTurns().slice(before);
    const caller = turns.find(turn => turn.botId === bot.id);
    expect(caller.threadId).toBe(threadId);
    expect(caller.evidence.filter((entry: any) => entry.step)).toHaveLength(steps.length);
    for (const [index, call] of caller.evidence.filter((entry: any) => entry.step).entries()) {
      expect(Boolean(call.response.error || call.response.result?.isError)).toBe(Boolean(steps[index].expectError));
    }
    expect((await messages(threadId)).filter(message => message.role === "bot" && message.text === reply)).toHaveLength(1);
    if (!options.pending) expect(await unanswered(threadId)).toHaveLength(0);
    // A settled immediate tool result must not queue a later setup continuation.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(providerTurns()).toHaveLength(before + expectedTurns);
    return caller;
  };
  const restart = async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"].includes(key.toUpperCase()) && value) env[key.toUpperCase()] = value;
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1), PATH: dirname(process.execPath),
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: fixture.fixtureDumpPath,
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      expect(restarted?.exitCode, `see ${logPath}`).toBeNull();
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Operations")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvePeerComms: true });
    const ask = (await api("POST", `/api/bots/${chief.id}/tasks`, { title: "Ask sibling" }, 201)).task;
    const peer = (await cli("new-bot", "--name", "Ada", "--section", "Operations")).bot;
    const inverse = (await cli("new-bot", "--name", "Thread Full", "--section", "Private")).bot;
    const modelSelection = chief.modelSelection;
    await api("PATCH", "/api/config", { features: { skillAuthoring: true } });

    // This is fixture setup, not a production grant endpoint or bypass flag.
    // Stop the exact owned server before changing its disposable persisted data.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const savedBots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    const savedChief = savedBots.find((bot: any) => bot.id === chief.id);
    savedChief.approvalMode = "full"; savedChief.autoApprove = false;
    for (const task of savedChief.tasks) {
      task.approvalMode = task.threadId === ask.threadId ? "ask" : "full";
      task.autoApprove = false;
    }
    const savedInverse = savedBots.find((bot: any) => bot.id === inverse.id);
    savedInverse.approvalMode = "ask"; savedInverse.autoApprove = false;
    savedInverse.tasks.find((task: any) => task.threadId === inverse.activeTaskId).approvalMode = "full";
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(savedBots, null, 2));
    await restart();
    evidence.push({ setup: "fixture-only persisted modes", restartedPid: restarted?.pid, modes: [
      { botId: chief.id, default: "full", fullTask: chief.activeTaskId, askTask: ask.threadId },
      { botId: inverse.id, default: "ask", fullTask: inverse.activeTaskId },
    ] });

    const skill = (name: string, instruction: string) => `---\nname: ${name}\ndescription: Summarize fixture-only monthly activity.\n---\n\n# Monthly fixture review\n\n${instruction}\n`;
    const schedule = { type: "cron", expression: "0 9 1 * *", timeZone: "America/New_York" };
    const specialist = (name: string, section: string) => ({ action: "create", key: name,
      fields: { name, title: "Research specialist", soul: "Use only fixture evidence.", section, modelSelection } });
    const created = await run(chief, chief.activeTaskId,
      "Set up my monthly reporting profile, save its reusable skill, schedule 9am New York time on the first of each month, and create Mira in Research.", [
        step("propose_profile", { title: "Monthly reporting Chief", soul: "Report only verified fixture results.", reason: "Requested reporting profile" }),
        step("list_routines", {}),
        step("propose_routine", { name: "Monthly fixture report", instructions: "Summarize fixture-only monthly results.", schedule }),
        step("skills_list", {}),
        step("skill_manage", { action: "create", skill_md: skill("monthly-fixture-review", "Read fixture notes and summarize the month."), source: "conversation" }),
        step("list_team_setup", {}),
        step("propose_team_setup", { reason: "Requested Research specialist and Chief description", newTeams: ["Research"], operations: [
          specialist("Mira", "Research"), { action: "update", botId: chief.id, fields: { description: "Coordinates monthly fixture reports" } },
        ] }),
      ]);
    expect(created.permissionMode).toBe("bypassPermissions");
    for (const entry of created.evidence.filter((item: any) => ["propose_profile", "propose_routine", "skill_manage", "propose_team_setup"].includes(item.step?.tool))) {
      expect(entry.response.result.content[0].text).toContain("No additional confirmation is needed");
      expect(entry.response.result.content[0].text).not.toContain("End this turn and wait");
    }
    const updatedChief = (await bots()).find(bot => bot.id === chief.id);
    expect(updatedChief).toMatchObject({ title: "Monthly reporting Chief", description: "Coordinates monthly fixture reports", soul: "Report only verified fixture results.", approvalMode: "full", approvePeerComms: true, managedSections: ["Research"] });
    const mira = (await bots()).find(bot => bot.name === "Mira");
    expect(mira).toMatchObject({ section: "Research", approvalMode: "ask", autoApprove: false, composio: false });
    const routine = (await api("GET", "/api/routines")).routines.find((item: any) => item.name === "Monthly fixture report");
    expect(routine).toMatchObject({ botId: chief.id, enabled: true, schedule });
    expect((await api("GET", `/api/bots/${chief.id}/skills`)).skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: "monthly-fixture-review", enabled: true })]));

    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const lateToken = readFileSync(dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN_FILE, "utf8");
    await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "Late fixture token", operations: [specialist("Must not exist", "Operations")] } }, 401, lateToken);

    await run(chief, chief.activeTaskId, "Update the named monthly skill, pause the report, update Mira, then delete Mira as requested.", [
      step("skill_manage", { action: "update", skill_name: "monthly-fixture-review", skill_md: skill("monthly-fixture-review", "Read fixture notes, verify totals, and report missing data."), source: "conversation" }),
      step("list_routines", {}), step("propose_routine_action", { action: "pause", routine_id: routine.id }),
      step("propose_team_setup", { reason: "Requested Mira update", operations: [{ action: "update", botId: mira.id, fields: { title: "Verified research specialist" } }] }),
      step("propose_bot_deletion", { bot_id: mira.id, reason: "User explicitly requested removal after the fixture check" }),
      step("propose_team_setup", { reason: "Out-of-scope fixture check", operations: [{ action: "update", botId: inverse.id, fields: { title: "Must not apply" } }] }, true),
    ]);
    expect((await bots()).some(bot => bot.id === mira.id)).toBe(false);
    expect((await api("GET", "/api/routines")).routines.find((item: any) => item.id === routine.id)).toMatchObject({ enabled: false, nextRunAt: null, schedule });
    expect((await api("GET", `/api/bots/${chief.id}/skills/monthly-fixture-review`)).text).toContain("verify totals");
    const updatedSkills = await api("GET", `/api/bots/${chief.id}/skills`);
    expect(updatedSkills.skills).toEqual([expect.objectContaining({ name: "monthly-fixture-review", enabled: true })]);
    expect(updatedSkills.staged).toHaveLength(0);

    plans[peer.id] = { turns: [{ reply: "Fixture peer verified the reporting instructions." }] };
    await run(chief, chief.activeTaskId, "Have Ada independently verify the fixture reporting instructions and return the result.", [
      step("coordinate_bots", { bot_ids: [peer.id], request_key: "verify-monthly", message: "Verify the fixture reporting instructions and state your result." }),
    ], { resumeReply: "Ada verified the fixture reporting instructions; requested work is complete." });
    const handoffs = JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8"));
    expect(handoffs.every((node: any) => node.status === "completed")).toBe(true);
    expect(providerTurns().filter(turn => turn.botId === peer.id)).toHaveLength(1);

    const askTurn = await run(chief, ask.threadId, "Prepare a profile change, routine, named skill, and specialist for review in this Ask task.", [
      step("propose_profile", { title: "Pending Ask title", reason: "Ask task requires review" }),
      step("propose_routine", { name: "Pending Ask report", instructions: "Wait for review.", schedule }),
      step("skill_manage", { action: "create", skill_md: skill("pending-ask-review", "Wait for review before using this skill."), source: "conversation" }),
      step("propose_team_setup", { reason: "Ask task specialist review", operations: [specialist("Pending specialist", "Operations")] }),
    ], { pending: true });
    expect(askTurn.permissionMode).not.toBe("bypassPermissions");
    expect(await unanswered(ask.threadId)).toHaveLength(4);
    expect((await bots()).find(bot => bot.id === chief.id).title).toBe("Monthly reporting Chief");
    expect((await bots()).some(bot => bot.name === "Pending specialist")).toBe(false);
    expect((await api("GET", "/api/routines")).routines).toHaveLength(1);
    expect((await api("GET", `/api/bots/${chief.id}/skills`)).skills.some((item: any) => item.name === "pending-ask-review")).toBe(false);

    const inverseTurn = await run(inverse, inverse.activeTaskId, "Apply my requested title in this Full Access task even though my bot default is Ask.", [
      step("propose_profile", { title: "Applied from Full task", reason: "User requested this title" }),
    ]);
    expect(inverseTurn.permissionMode).toBe("bypassPermissions");
    expect((await bots()).find(bot => bot.id === inverse.id)).toMatchObject({ title: "Applied from Full task", approvalMode: "ask" });
    expect(await unanswered(chief.activeTaskId)).toHaveLength(0);
    expect(providerTurns()).toHaveLength(7);
    const persisted = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    expect(persisted.find((bot: any) => bot.id === chief.id)).toMatchObject({ title: "Monthly reporting Chief", approvalMode: "full" });
    expect(persisted.find((bot: any) => bot.id === chief.id).tasks.find((task: any) => task.threadId === ask.threadId).approvalMode).toBe("ask");
    expect(persisted.find((bot: any) => bot.id === inverse.id)).toMatchObject({ title: "Applied from Full task", approvalMode: "ask" });
    expect(persisted.find((bot: any) => bot.id === inverse.id).tasks.find((task: any) => task.threadId === inverse.activeTaskId).approvalMode).toBe("full");
    expect(JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8")).routines[0]).toMatchObject({ enabled: false, schedule });
    evidence.push({ persistedBots: persisted, routines: await api("GET", "/api/routines"), handoffs,
      fullMessages: await messages(chief.activeTaskId), askMessages: await messages(ask.threadId), inverseMessages: await messages(inverse.activeTaskId) });
    expect(readFileSync(logPath, "utf8")).not.toMatch(/ReferenceError|change listener threw|Unexpected extra fixture turn/);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    const evidencePath = `${logPath}.full-access.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, providerTurns: providerTurns().map(turn => ({
      botId: turn.botId, threadId: turn.threadId, turnIndex: turn.turnIndex, permissionMode: turn.permissionMode,
      resumed: turn.resumed, calls: turn.evidence.filter((entry: any) => entry.step),
    })) }, null, 2));
    console.info(JSON.stringify({ logPath, evidencePath }));
    await fixture.close();
  }
}, 150_000);
