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

    const projectResponse = await call("POST", "/api/board/projects", { name: "验证看板" });
    assert(projectResponse.status === 201, `create project: ${projectResponse.status}`);
    const project = (projectResponse.json.board as { projects: Array<{ id: string }> }).projects[0]!;

    const attributed = await call("PUT", `/api/board/tasks/${bot.threadId}`, {
      botId: bot.id, projectId: project.id, phase: "build", status: "in_progress", owner: "Lin",
    });
    assert(attributed.status === 200, `attribute: ${attributed.status}`);

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

    const stale = await call("POST", "/api/board/projects", { name: "旧版本", version: 0 });
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
    assert((accepted.json.task as { phase: string }).phase === "done", "accepted moves the task to done");

    const frame = await Promise.race([boardFrame, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no board SSE frame in 5s")), 5_000))]);
    controller.abort();
    assert(frame.includes('"version"') && frame.includes('"tasks"'), "the board frame carries the whole board");

    const final = await call("GET", "/api/board");
    assert(final.status === 200 && (final.json.tasks as Array<{ phase: string }>)[0]!.phase === "done", "the board kept the verdict");

    console.log(JSON.stringify({
      ok: true,
      url,
      dataDir: fixture.info.dataDir,
      logPath: fixture.info.logPath,
      boardVersion: (final.json as { version: number }).version,
      taskPhase: (final.json.tasks as Array<{ phase: string }>)[0]!.phase,
      checks: ["empty board", "create project", "attribute conversation", "create with board", "failed attribution rolls back", "stale version 409", "unknown thread 400", "accepted verdict", "SSE board frame", "persisted snapshot"],
    }, null, 2));
  } finally {
    await fixture.close();
  }
}

await main();
