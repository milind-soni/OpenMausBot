import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let stopScopedWorkerFinishGate = "";
let busyWorkerFinishGate = "";
let base = "";
let stderr = "";

const completeReplies = [
  [
    "Scout should verify the draft.\n<openmaus-goal>{\"status\":\"continue\",",
    "\"next\":\"Scout\",\"instruction\":\"Verify the draft and report evidence\",\"detail\":\"Draft prepared\"}</openmaus-goal>",
  ],
  "The draft is accurate and the cited evidence checks out.",
  "The verified draft is ready to ship.\n<openmaus-goal>{\"status\":\"completed\",\"detail\":\"Draft produced and independently verified.\"}</openmaus-goal>",
];

const loopReplies = Array.from({ length: 13 }, (_, index) =>
  index % 2 === 0
    ? `More work is needed.\n<openmaus-goal>{"status":"continue","next":"Looper","instruction":"Try approach ${index / 2 + 1}","detail":"Still working"}</openmaus-goal>`
    : `Approach ${Math.ceil(index / 2)} did not finish the task.`,
);

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-goal-run-"));
  stopScopedWorkerFinishGate = join(home, "stop-scoped-worker-finish");
  busyWorkerFinishGate = join(home, "busy-worker-finish");
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Goal run test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      complete: {
        driver: "claudeAgent",
        displayName: "Completing fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify(completeReplies),
          FAKE_CLAUDE_REPLY_STATE: join(home, "complete-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      loop: {
        driver: "claudeAgent",
        displayName: "Looping fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify(loopReplies),
          FAKE_CLAUDE_REPLY_STATE: join(home, "loop-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      crash: {
        driver: "claudeAgent",
        displayName: "Failing fixture",
        environment: { FAKE_CLAUDE_MODE: "exit-early" },
        config: { cli: FAKE_CLAUDE },
      },
      slow: {
        driver: "claudeAgent",
        displayName: "Queue fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify(["first response", "second response"]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "slow-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      busyGoal: {
        driver: "claudeAgent",
        displayName: "Busy goal fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "The unrelated direct task is complete.",
            "The queued team goal is complete.\n<openmaus-goal>{\"status\":\"completed\",\"detail\":\"Waited for the lead, then completed normally.\"}</openmaus-goal>",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "busy-goal-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      busyWorkerLead: {
        driver: "claudeAgent",
        displayName: "Busy worker lead fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "I am delegating the research.\n<openmaus-goal>{\"status\":\"continue\",\"next\":\"Busy specialist\",\"instruction\":\"Research the answer and report evidence\",\"detail\":\"Waiting for specialist research.\"}</openmaus-goal>",
            "The specialist's evidence resolves the goal.\n<openmaus-goal>{\"status\":\"completed\",\"detail\":\"Specialist research incorporated after their direct task finished.\"}</openmaus-goal>",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "busy-worker-lead-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      busyWorker: {
        driver: "claudeAgent",
        displayName: "Busy worker fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_SLOW_FINISH_GATE: busyWorkerFinishGate,
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "The unrelated direct research is complete.",
            "Evidence gathered for the coordinator.",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "busy-worker-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      stopScopedLead: {
        driver: "claudeAgent",
        displayName: "Stop-scoped lead fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "I am delegating this scheduled goal.\n<openmaus-goal>{\"status\":\"continue\",\"next\":\"Delayed worker\",\"instruction\":\"Finish the scheduled analysis\",\"detail\":\"Waiting for the delayed worker.\"}</openmaus-goal>",
            "This is unrelated direct work and should be stopped.",
            "The scheduled analysis is now complete.\n<openmaus-goal>{\"status\":\"completed\",\"detail\":\"Scheduled goal survived the coordinator's direct Stop.\"}</openmaus-goal>",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "stop-scoped-lead-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      stopScopedWorker: {
        driver: "claudeAgent",
        displayName: "Stop-scoped worker fixture",
        environment: {
          FAKE_CLAUDE_MODE: "background-result",
          FAKE_CLAUDE_FINISH_GATE: stopScopedWorkerFinishGate,
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "The worker's unrelated direct task completed naturally.",
            "Scheduled analysis returned to the coordinator.",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "stop-scoped-worker-replies.txt"),
          FAKE_CLAUDE_TRANSIENTS: "1",
          FAKE_CLAUDE_STATE: join(home, "stop-scoped-worker-launches.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      directHang: {
        driver: "claudeAgent",
        displayName: "Direct hang fixture",
        environment: { FAKE_CLAUDE_MODE: "hang" },
        config: { cli: FAKE_CLAUDE },
      },
      routineGoal: {
        driver: "claudeAgent",
        displayName: "Routine goal fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "The scheduled review is complete.\n<openmaus-goal>{\"status\":\"completed\",\"detail\":\"Scheduled team review completed.\"}</openmaus-goal>",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "routine-goal-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("goal-driven channel runs", () => {
  it("returns to the lead until the goal is completed and appends a clean receipt", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Lead",
      modelSelection: { instanceId: "complete", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const scout = (await api("POST", "/api/bots", {
      name: "Scout",
      modelSelection: { instanceId: "complete", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Launch team",
      memberIds: [lead.id, scout.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    const sent = await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Produce and verify the launch draft",
      mode: "goal",
      sendId: "goal_send_1234567890",
    });
    expect(sent.status).toBe(202);
    expect(sent.body.message).toMatchObject({ channelMode: "goal" });

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=30")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    }, { timeout: 10_000 }).toMatchObject({
      status: "completed",
      coordinatorBotId: lead.id,
      turnCount: 3,
      detail: "Draft produced and independently verified.",
    });

    const state = (await api("GET", "/api/bots?messages=30")).body;
    const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
    expect(current.messages.find((message: { kind: string }) => message.kind === "goal.run")?.text)
      .toBe("Goal completed: Draft produced and independently verified.");
    expect(current.working).toBe(false);
    expect(current.messages.filter((message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot")
      .map((message: { from?: { name?: string } }) => message.from?.name)).toEqual(["Lead", "Scout", "Lead"]);
    expect(JSON.stringify(current.messages)).not.toContain("<openmaus-goal>");
  });

  it("waits for a busy coordinator without spending a goal turn, then completes on the same card", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Patient lead",
      modelSelection: { instanceId: "busyGoal", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Patient goal team",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    try {
      expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "Finish this direct task first" })).status)
        .toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
      }).toBe(true);

      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Complete this goal after your current work",
        mode: "goal",
      })).status).toBe(202);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          count: cards.length,
          status: cards[0]?.goalRun?.status,
          detail: cards[0]?.goalRun?.detail,
          turnCount: cards[0]?.goalRun?.turnCount,
          busyBotId: current?.busyBotId,
        };
      }).toMatchObject({
        count: 1,
        status: "working",
        detail: expect.stringMatching(/finishing another conversation/i),
        turnCount: 0,
        busyBotId: null,
      });

      const waitingState = (await api("GET", "/api/bots?messages=30")).body;
      const waitingRoom = waitingState.groups.find((group: { id: string }) => group.id === room.id);
      const cardId = waitingRoom.messages.find((message: { kind: string }) => message.kind === "goal.run").id;

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          working: current?.working,
          count: cards.length,
          id: cards[0]?.id,
          status: cards[0]?.goalRun?.status,
          detail: cards[0]?.goalRun?.detail,
          turnCount: cards[0]?.goalRun?.turnCount,
        };
      }, { timeout: 10_000 }).toEqual({
        working: false,
        count: 1,
        id: cardId,
        status: "completed",
        detail: "Waited for the lead, then completed normally.",
        turnCount: 1,
      });
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("waits for a busy delegated worker, preserves its direct turn, then resumes the goal", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Worker coordinator",
      modelSelection: { instanceId: "busyWorkerLead", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const worker = (await api("POST", "/api/bots", {
      name: "Busy specialist",
      modelSelection: { instanceId: "busyWorker", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Busy specialist team",
      memberIds: [lead.id, worker.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    try {
      expect((await api("POST", `/api/bots/${worker.id}/messages`, {
        text: "Complete this unrelated direct research first",
      })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy;
      }).toBe(true);

      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Research and resolve the team question",
        mode: "goal",
      })).status).toBe(202);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
        return {
          status: card?.goalRun?.status,
          detail: card?.goalRun?.detail,
          turnCount: card?.goalRun?.turnCount,
          roomBusyBotId: current?.busyBotId,
          workerDirectBusy: state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy,
        };
      }).toMatchObject({
        status: "working",
        detail: expect.stringMatching(/Busy specialist is finishing another conversation/i),
        turnCount: 1,
        roomBusyBotId: null,
        workerDirectBusy: true,
      });

      // Keep the worker occupied until the waiting state is observed, even
      // when CI takes longer than the fake driver's default 800 ms turn.
      writeFileSync(busyWorkerFinishGate, "release");

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const currentWorker = state.bots.find((bot: { id: string }) => bot.id === worker.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          roomWorking: current?.working,
          cards: cards.length,
          status: cards[0]?.goalRun?.status,
          detail: cards[0]?.goalRun?.detail,
          turnCount: cards[0]?.goalRun?.turnCount,
          speakers: current?.messages
            .filter((message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot")
            .map((message: { from?: { name?: string } }) => message.from?.name)
            .filter((name: string | undefined, index: number, names: Array<string | undefined>) =>
              name !== names[index - 1]
            ),
          workerDirectBusy: currentWorker?.busy,
          directFinishedNaturally: currentWorker?.messages.some((message: { text?: string }) =>
            message.text?.includes("reply to:")
          ),
        };
      }, { timeout: 10_000 }).toEqual({
        roomWorking: false,
        cards: 1,
        status: "completed",
        detail: "Specialist research incorporated after their direct task finished.",
        turnCount: 3,
        speakers: ["Worker coordinator", "Busy specialist", "Worker coordinator"],
        workerDirectBusy: false,
        directFinishedNaturally: true,
      });
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${worker.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${worker.id}`).catch(() => undefined);
    }
  });

  it("stops a waiting goal without interrupting unrelated direct work, and chat waits for busy bots the same way", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Occupied lead",
      modelSelection: { instanceId: "directHang", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Scoped stop team",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    const chips = (messages: Array<{ kind: string; role?: string; tool?: { name?: string; ok?: boolean } }>) => ({
      waiting: messages.some((message) =>
        message.kind === "activity" &&
        /finishing another conversation — will reply here when free/i.test(message.tool?.name ?? "") &&
        message.tool?.ok === undefined
      ),
      skipped: messages.some((message) => /skipped this round/i.test(message.tool?.name ?? "")),
      replies: messages.filter((message) => message.kind === "text" && message.role === "bot").length,
    });

    try {
      expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "Keep this direct task running" })).status)
        .toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
      }).toBe(true);

      // ordinary chat: the round parks on the busy lead — visibly working,
      // nobody named as speaker, one neutral note, and no skip
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Ordinary room chat" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        return { working: current?.working, busyBotId: current?.busyBotId, ...chips(current?.messages ?? []) };
      }).toEqual({ working: true, busyBotId: null, waiting: true, skipped: false, replies: 0 });

      // Stop releases the parked chat round quietly: no reply, no skip chip,
      // and the lead's unrelated direct turn is untouched
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          working: current?.working,
          directBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
          ...chips(current?.messages ?? []),
        };
      }).toEqual({ working: false, directBusy: true, waiting: true, skipped: false, replies: 0 });

      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Wait and run this as a goal",
        mode: "goal",
      })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
        return {
          roomWorking: current?.working,
          roomBusyBotId: current?.busyBotId,
          status: card?.goalRun?.status,
          detail: card?.goalRun?.detail,
          turnCount: card?.goalRun?.turnCount,
        };
      }).toMatchObject({
        roomWorking: true,
        roomBusyBotId: null,
        status: "working",
        detail: expect.stringMatching(/finishing another conversation/i),
        turnCount: 0,
      });

      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          roomWorking: current?.working,
          cards: cards.length,
          status: cards[0]?.goalRun?.status,
          turnCount: cards[0]?.goalRun?.turnCount,
          directBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }).toEqual({
        roomWorking: false,
        cards: 1,
        status: "stopped",
        turnCount: 0,
        directBusy: true,
      });
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("stops a detached scheduled goal from the active room and cancels its routine run", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Detached scheduled lead",
      modelSelection: { instanceId: "directHang", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Detached stop team",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    const originalThreadId = room.threadId;

    try {
      const created = await api("POST", "/api/routines", {
        name: "Hanging scheduled goal",
        prompt: "Keep this scheduled team goal running",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        runOn: "maus",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      let backgroundThreadId = "";
      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const running = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        backgroundThreadId = running?.threadId ?? "";
        return {
          runStatus: running?.status,
          detached: Boolean(running?.threadId && running.threadId !== originalThreadId),
          activeThreadId: current?.threadId,
          hasBackgroundTask: current?.tasks.some(
            (task: { threadId: string }) => task.threadId === running?.threadId,
          ),
          roomWorking: current?.working,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }, { timeout: 10_000 }).toEqual({
        runStatus: "running",
        detached: true,
        activeThreadId: originalThreadId,
        hasBackgroundTask: true,
        roomWorking: true,
        leadBusy: true,
      });

      // No task switch and no explicit thread: the ordinary room Stop must
      // discover the detached operation rather than targeting the visible task.
      expect((await api("POST", `/api/groups/${room.id}/interrupt`)).status).toBe(200);

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const stopped = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          runStatus: stopped?.status,
          runThreadId: stopped?.threadId,
          activeThreadId: current?.threadId,
          roomWorking: current?.working,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }, { timeout: 10_000 }).toEqual({
        runStatus: "cancelled",
        runThreadId: backgroundThreadId,
        activeThreadId: originalThreadId,
        roomWorking: false,
        leadBusy: false,
      });

      const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
      expect(opened.status).toBe(200);
      expect(opened.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
        .toEqual([
          expect.objectContaining({
            goalRun: expect.objectContaining({ runId, status: "stopped", detail: "Stopped by you." }),
          }),
        ]);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("stops a detached scheduled goal from the coordinator's ordinary Stop", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Detached bot-stop lead",
      modelSelection: { instanceId: "directHang", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Detached bot-stop team",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    const originalThreadId = room.threadId;

    try {
      const created = await api("POST", "/api/routines", {
        name: "Coordinator-stopped scheduled goal",
        prompt: "Keep this detached goal running until the coordinator is stopped",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        runOn: "maus",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      let backgroundThreadId = "";
      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const running = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        backgroundThreadId = running?.threadId ?? "";
        return {
          runStatus: running?.status,
          detached: Boolean(running?.threadId && running.threadId !== originalThreadId),
          activeThreadId: current?.threadId,
          roomWorking: current?.working,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }, { timeout: 10_000 }).toEqual({
        runStatus: "running",
        detached: true,
        activeThreadId: originalThreadId,
        roomWorking: true,
        leadBusy: true,
      });

      // The visible room still points at originalThreadId. Bot Stop must use
      // the detached operation's exact speaker thread, not that visible task.
      expect((await api("POST", `/api/bots/${lead.id}/interrupt`)).status).toBe(200);

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const stopped = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          runStatus: stopped?.status,
          runThreadId: stopped?.threadId,
          activeThreadId: current?.threadId,
          roomWorking: current?.working,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }, { timeout: 10_000 }).toEqual({
        runStatus: "cancelled",
        runThreadId: backgroundThreadId,
        activeThreadId: originalThreadId,
        roomWorking: false,
        leadBusy: false,
      });

      const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
      expect(opened.status).toBe(200);
      expect(opened.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
        .toEqual([
          expect.objectContaining({
            goalRun: expect.objectContaining({ runId, status: "stopped", detail: "Stopped by you." }),
          }),
        ]);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("stops the coordinator's direct turn without cancelling a routine goal waiting on its worker", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Stop-scoped coordinator",
      modelSelection: { instanceId: "stopScopedLead", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const worker = (await api("POST", "/api/bots", {
      name: "Delayed worker",
      modelSelection: { instanceId: "stopScopedWorker", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Coordinator stop scope team",
      memberIds: [lead.id, worker.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    try {
      expect((await api("POST", `/api/bots/${worker.id}/messages`, {
        text: "Finish this unrelated worker task first",
      })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy;
      }).toBe(true);

      const created = await api("POST", "/api/routines", {
        name: "Worker-gated scheduled goal",
        prompt: "Complete the scheduled analysis as a team",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        runOn: "maus",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      let backgroundThreadId = "";
      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const running = calendar.runs.find((run: { id: string }) => run.id === runId);
        backgroundThreadId = running?.threadId ?? "";
        return { status: running?.status, threadId: running?.threadId };
      }, { timeout: 10_000 }).toMatchObject({ status: "running", threadId: expect.any(String) });

      const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
      expect(opened.status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
        return {
          activeThreadId: current?.threadId,
          roomWorking: current?.working,
          status: card?.goalRun?.status,
          detail: card?.goalRun?.detail,
          turnCount: card?.goalRun?.turnCount,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
          workerBusy: state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy,
        };
      }, { timeout: 10_000 }).toMatchObject({
        activeThreadId: backgroundThreadId,
        roomWorking: true,
        status: "working",
        detail: expect.stringMatching(/Delayed worker is finishing another conversation/i),
        turnCount: 1,
        leadBusy: false,
        workerBusy: true,
      });

      expect((await api("POST", `/api/bots/${lead.id}/messages`, {
        text: "Start unrelated coordinator work",
      })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const currentLead = state.bots.find((bot: { id: string }) => bot.id === lead.id);
        return {
          busy: currentLead?.busy,
          directReplyStarted: currentLead?.messages.some((message: { text?: string }) =>
            message.text?.includes("This is unrelated direct work and should be stopped.")
          ),
        };
      }).toEqual({ busy: true, directReplyStarted: true });

      // The ordinary bot Stop belongs to the direct claim made above. The
      // coordinator is no longer an active participant in the waiting room
      // operation, so this must not cancel the scheduled team goal.
      expect((await api("POST", `/api/bots/${lead.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      // The worker may settle and advance the room while Stop is in flight.
      // Either in-progress or already-completed is valid; cancellation/stopped
      // is the regression this snapshot must exclude.
      const afterStopCalendar = (await api("GET", "/api/routines")).body;
      const afterStopRun = afterStopCalendar.runs.find((run: { id: string }) => run.id === runId);
      const afterStopState = (await api("GET", "/api/bots?messages=30")).body;
      const afterStopRoom = afterStopState.groups.find((group: { id: string }) => group.id === room.id);
      const afterStopCard = afterStopRoom.messages.find((message: { kind: string }) => message.kind === "goal.run");
      expect(["running", "completed"]).toContain(afterStopRun.status);
      expect(["working", "completed"]).toContain(afterStopCard.goalRun.status);
      expect(afterStopCard.goalRun.status).not.toBe("stopped");

      writeFileSync(stopScopedWorkerFinishGate, "finish");
      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const completed = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          runStatus: completed?.status,
          output: completed?.output,
          roomWorking: current?.working,
          cards: cards.length,
          goalStatus: cards[0]?.goalRun?.status,
          detail: cards[0]?.goalRun?.detail,
          turnCount: cards[0]?.goalRun?.turnCount,
        };
      }, { timeout: 15_000 }).toEqual({
        runStatus: "completed",
        output: "Scheduled goal survived the coordinator's direct Stop.",
        roomWorking: false,
        cards: 1,
        goalStatus: "completed",
        detail: "Scheduled goal survived the coordinator's direct Stop.",
        turnCount: 3,
      });
    } finally {
      writeFileSync(stopScopedWorkerFinishGate, "finish");
      await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${worker.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${worker.id}`).catch(() => undefined);
    }
  });

  it("runs a routine as a goal in a new background room task", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Scheduled lead",
      modelSelection: { instanceId: "routineGoal", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Scheduled review team",
      memberIds: [lead.id],
      setup: { bulletin: "Review carefully.", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    const originalThreadId = room.threadId;

    try {
      const created = await api("POST", "/api/routines", {
        name: "Daily team review",
        prompt: "Review the release as a team",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        runOn: "maus",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      expect(created.body.routine).toMatchObject({
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
      });

      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const running = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const backgroundRoom = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          status: running?.status,
          threadId: running?.threadId,
          activeThreadId: backgroundRoom?.threadId,
          hasTask: backgroundRoom?.tasks.some(
            (task: { threadId: string }) => task.threadId === running?.threadId,
          ),
          working: backgroundRoom?.working,
        };
      }).toMatchObject({
        status: "running",
        threadId: expect.any(String),
        activeThreadId: originalThreadId,
        hasTask: true,
        working: true,
      });

      const runningCalendar = (await api("GET", "/api/routines")).body;
      const running = runningCalendar.runs.find((run: { id: string }) => run.id === runId);
      const openedWhileWorking = await api("POST", `/api/groups/${room.id}/tasks/${running.threadId}`);
      expect(openedWhileWorking.status).toBe(200);
      expect(openedWhileWorking.body.group).toMatchObject({
        threadId: running.threadId,
        working: true,
      });

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        return calendar.runs.find((run: { id: string }) => run.id === runId);
      }, { timeout: 10_000 }).toMatchObject({
        id: runId,
        status: "completed",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        output: "Scheduled team review completed.",
        threadId: expect.any(String),
      });

      const calendar = (await api("GET", "/api/routines")).body;
      const completedRun = calendar.runs.find((run: { id: string }) => run.id === runId);
      const state = (await api("GET", "/api/bots?messages=0")).body;
      const backgroundRoom = state.groups.find((group: { id: string }) => group.id === room.id);
      expect(backgroundRoom.threadId).toBe(completedRun.threadId);
      expect(backgroundRoom.tasks).toContainEqual(expect.objectContaining({
        threadId: completedRun.threadId,
        title: "Daily team review",
      }));

      const switched = await api("POST", `/api/groups/${room.id}/tasks/${completedRun.threadId}`);
      expect(switched.status).toBe(200);
      expect(switched.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
        .toEqual([
          expect.objectContaining({
            goalRun: expect.objectContaining({
              runId,
              status: "completed",
              coordinatorBotId: lead.id,
              detail: "Scheduled team review completed.",
            }),
          }),
        ]);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("pauses a non-converging team at the hard turn limit", async () => {
    const looper = (await api("POST", "/api/bots", {
      name: "Looper",
      modelSelection: { instanceId: "loop", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Bounded team",
      memberIds: [looper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: looper.id } },
    })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Keep trying forever",
      mode: "goal",
    })).status).toBe(202);

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=40")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    }, { timeout: 15_000 }).toMatchObject({ status: "limit-reached", turnCount: 13, maxTurns: 13 });
  });

  it("never treats a failed provider turn as a completed goal", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Failing lead",
      modelSelection: { instanceId: "crash", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Failure checks",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Do not claim this succeeded",
      mode: "goal",
    })).status).toBe(202);

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=20")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    // the failed attempt is retried once, and a retry is a model call that
    // costs a turn like any other — so the honest count is two, still failed
    }, { timeout: 10_000 }).toMatchObject({ status: "failed", turnCount: 2 });
  });

  it("validates mode and binds it to the send id", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Mode checks",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hello", mode: "forever" })).status).toBe(400);
    const body = { text: "quiet note", mode: "chat", sendId: "mode_send_1234567890" };
    expect((await api("POST", `/api/groups/${room.id}/messages`, body)).status).toBe(202);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { ...body, mode: "goal" })).status).toBe(409);

    const dm = (await api("GET", "/api/bots?messages=0")).body.groups.find((group: { dm?: boolean }) => group.dm);
    if (dm) expect((await api("POST", `/api/groups/${dm.id}/messages`, { text: "goal", mode: "goal" })).status).toBe(400);
  });

  it("automatically dispatches channel messages queued during a running turn", async () => {
    const bot = (await api("POST", "/api/bots", {
      name: "Queue worker",
      modelSelection: { instanceId: "slow", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Queue checks",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const firstSendId = "channel_queue_first_1234";
    const secondSendId = "channel_queue_second_123";

    const first = await api("POST", `/api/groups/${room.id}/messages`, {
      text: "first request",
      sendId: firstSendId,
    });
    expect(first.status).toBe(202);
    expect(first.body.message).toMatchObject({ role: "user", text: "first request", sendId: firstSendId });

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=0")).body;
      return state.groups.find((candidate: { id: string }) => candidate.id === room.id)?.working;
    }).toBe(true);

    const queuedBody = { text: "second request", sendId: secondSendId };
    const queued = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ queued: true, threadId: room.threadId });
    expect(queued.body.queueId).toEqual(expect.any(String));
    expect(queued.body.message).toBeUndefined();

    const retryWhileQueued = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
    expect(retryWhileQueued.body).toMatchObject({ queued: true, queueId: queued.body.queueId });

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=30")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      const userLines = current?.messages.filter((message: { role?: string }) => message.role === "user") ?? [];
      return {
        working: current?.working,
        sends: userLines.map((message: { sendId?: string }) => message.sendId),
      };
    }, { timeout: 10_000 }).toEqual({ working: false, sends: [firstSendId, secondSendId] });

    const state = (await api("GET", "/api/bots?messages=30")).body;
    const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
    const firstUserAt = current.messages.findIndex((message: { sendId?: string }) => message.sendId === firstSendId);
    const secondUserAt = current.messages.findIndex((message: { sendId?: string }) => message.sendId === secondSendId);
    const firstReplyAt = current.messages.findIndex(
      (message: { role?: string }, index: number) => index > firstUserAt && message.role === "bot",
    );
    const secondReplyAt = current.messages.findIndex(
      (message: { role?: string }, index: number) => index > secondUserAt && message.role === "bot",
    );
    expect(firstUserAt).toBeGreaterThanOrEqual(0);
    expect(firstReplyAt).toBeGreaterThan(firstUserAt);
    expect(secondUserAt).toBeGreaterThan(firstReplyAt);
    expect(secondReplyAt).toBeGreaterThan(secondUserAt);
    expect(current.messages[secondUserAt]).toMatchObject({ queueId: queued.body.queueId });

    const retryAfterDrain = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
    expect(retryAfterDrain.body.message).toMatchObject({
      sendId: secondSendId,
      queueId: queued.body.queueId,
    });
  });
});
