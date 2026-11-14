// A disposable board fixture: the real server, the real HTTP routes and the real event stream, no example data.
// `node --experimental-strip-types scripts/verify-board.ts`
import { launchVerificationServer } from "./control-omb.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const fixture = await launchVerificationServer(process.env);
  const { url } = fixture.info;
  const headers = { "content-type": "application/json", origin: url };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json() as Record<string, unknown>;
    return { status: response.status, json };
  };
  try {
    const listed = await (await fetch(`${url}/api/bots`, { headers: { origin: url } })).json() as { bots: Array<{ id: string; threadId: string }> };
    const bot = listed.bots[0];
    assert(bot?.id && bot.threadId, "fixture did not seed a starter bot with a conversation");

    const empty = await call("GET", "/api/board");
    assert(empty.status === 200 && (empty.json as { version: number }).version === 0, "a fresh board is empty");

    const projectResponse = await call("POST", "/api/board/projects", {
      name: "验证看板", owner: "朱明跃", goal: "交付", acceptance: "上线", visibility: "everyone",
    });
    assert(projectResponse.status === 201, `create project: ${projectResponse.status}`);
    const project = (projectResponse.json.board as { projects: Array<{ id: string; owner: string; goal: string; acceptance: string }> }).projects[0]!;
    assert(project.owner === "朱明跃" && project.goal === "交付" && project.acceptance === "上线", "project accountability fields persist");

    const subResponse = await call("POST", "/api/board/subprojects", {
      projectId: project.id, name: "财税", phase: "test", phaseEvidence: "联调完成", owner: "唐僧", deliverable: "办理卡", acceptance: "双账号验收",
    });
    assert(subResponse.status === 201, `create subproject: ${subResponse.status}`);
    const subproject = (subResponse.json.board as { subprojects: Array<{ id: string; phase: string; owner: string }> }).subprojects[0]!;
    assert(subproject.phase === "test" && subproject.owner === "唐僧", "subproject phase and owner persist");

    const milestoneResponse = await call("POST", "/api/board/milestones", {
      projectId: project.id, subprojectId: subproject.id, title: "上线", acceptance: "生产验收", owner: "唐僧",
    });
    assert(milestoneResponse.status === 201, `create milestone: ${milestoneResponse.status}`);
    const milestone = (milestoneResponse.json.board as { milestones: Array<{ id: string }> }).milestones[0]!;
    const acceptedMilestone = await call("PATCH", `/api/board/milestones/${milestone.id}`, { status: "accepted", verdict: "通过", evidence: "回执" });
    assert(acceptedMilestone.status === 200, `accept milestone: ${acceptedMilestone.status}`);
    assert((acceptedMilestone.json.board as { milestones: Array<{ acceptedBy: string }> }).milestones[0]!.acceptedBy, "milestone acceptance is named");

    const attributed = await call("PUT", `/api/board/tasks/${bot.threadId}`, {
      botId: bot.id, projectId: project.id, subprojectId: subproject.id, phase: "build", status: "in_progress", owner: "Lin",
      ownerEmail: "lin@example.com", blocked: true, blockedReason: "等待账号",
    });
    assert(attributed.status === 200, `attribute: ${attributed.status}`);
    assert((attributed.json.board as { tasks: Array<{ blockedReason: string }> }).tasks[0]!.blockedReason === "等待账号", "task blocked reason persists");

    const created = await call("POST", `/api/bots/${bot.id}/tasks`, {
      title: "看板归属验证", board: { projectId: project.id, phase: "build", status: "in_progress" },
    });
    const createdThread = (created.json.task as { threadId?: string }).threadId;
    assert(created.status === 201 && createdThread, `create with board: ${created.status}`);
    assert((created.json.board as { tasks: Array<{ threadId: string }> }).tasks.some((task) => task.threadId === createdThread), "the new conversation is on the board");

    const before = (await (await fetch(`${url}/api/bots/${bot.id}?messages=0`, { headers: { origin: url } })).json() as { bot: { tasks: unknown[] } }).bot.tasks.length;
    const refusedCreate = await call("POST", `/api/bots/${bot.id}/tasks`, { title: "坏归属", board: { projectId: "p_missing" } });
    assert(refusedCreate.status === 400 && refusedCreate.json.error === "BOARD_INVALID", `refused create: ${refusedCreate.status}`);
    const after = (await (await fetch(`${url}/api/bots/${bot.id}?messages=0`, { headers: { origin: url } })).json() as { bot: { tasks: unknown[] } }).bot.tasks.length;
    assert(after === before, "a failed board attribution leaves no conversation behind");

    const stale = await call("POST", "/api/board/projects", { name: "旧版本", owner: "朱明跃", goal: "交付", acceptance: "上线", version: 0 });
    assert(stale.status === 409 && stale.json.error === "BOARD_VERSION_CONFLICT", "a stale version is refused");

    const ready = await call("POST", "/api/board/tasks/not-a-thread/verdict", { decision: "accepted", evidence: "x" });
    assert(ready.status === 400 && ready.json.error === "BOARD_INVALID", "an unknown conversation is refused");

    // The event stream is the other half of the contract: one whole board per write.
    const controller = new AbortController();
    const events = await fetch(`${url}/api/events`, { headers: { origin: url, accept: "text/event-stream" }, signal: controller.signal });
    assert(events.ok && events.body, `events: ${events.status}`);
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const boardFrame = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream closed before a board frame");
        seen += decoder.decode(value, { stream: true });
        if (seen.includes('"kind":"board"')) return seen;
      }
    })();

    const accepted = await call("POST", `/api/board/tasks/${bot.threadId}/verdict`, { decision: "accepted", evidence: "真实 HTTP 与 SSE 均通过" });
    assert(accepted.status === 200, `verdict: ${accepted.status}`);
    assert((accepted.json.task as { phase: string; status: string }).status === "done", "accepted moves the task status to done");
    assert((accepted.json.task as { phase: string }).phase === "build", "task acceptance leaves the product phase alone");
    const refusedPhase = await call("PUT", `/api/board/tasks/${bot.threadId}`, { botId: bot.id, phase: "done" });
    assert(refusedPhase.status === 422 && refusedPhase.json.error === "BOARD_NEEDS_EVIDENCE", "a done phase needs evidence");
    const phased = await call("PUT", `/api/board/tasks/${bot.threadId}`, {
      botId: bot.id, phase: "done", phaseEvidence: "https://example.test/release",
    });
    assert(phased.status === 200, `phase evidence: ${phased.status}`);

    const frame = await Promise.race([boardFrame, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no board SSE frame in 5s")), 5_000))]);
    controller.abort();
    assert(frame.includes('"version"') && frame.includes('"tasks"'), "the board frame carries the whole board");

    const final = await call("GET", "/api/board");
    assert(final.status === 200 && (final.json.tasks as Array<{ phase: string; status: string }>)[0]!.status === "done", "the board kept the verdict");
    assert((final.json.tasks as Array<{ phase: string }>)[0]!.phase === "done", "the explicit product phase persisted");
    const counts = final.json.counts as { tasks: number; topLevel: number; subtasks: number };
    assert(counts.tasks === 2 && counts.topLevel === 2 && counts.subtasks === 0, "counts do not double count");
    const audit = await call("GET", "/api/board/audit?limit=20");
    assert(audit.status === 200 && (audit.json.audit as unknown[]).length >= 5, "audit records the writes");

    console.log(JSON.stringify({
      ok: true,
      url,
      dataDir: fixture.info.dataDir,
      logPath: fixture.info.logPath,
      boardVersion: (final.json as { version: number }).version,
      taskPhase: (final.json.tasks as Array<{ phase: string }>)[0]!.phase,
      taskStatus: (final.json.tasks as Array<{ status: string }>)[0]!.status,
      checks: ["empty board", "create project with owner/goal/acceptance", "subproject phase/owner/deliverable", "named milestone acceptance", "attribute with blocked reason", "create with board", "failed attribution rolls back", "stale version 409", "unknown thread 400", "accepted verdict leaves phase", "phase done needs evidence", "explicit phase evidence", "SSE board frame", "counts", "audit", "persisted snapshot"],
    }, null, 2));
  } finally {
    await fixture.close();
  }
}

await main();
