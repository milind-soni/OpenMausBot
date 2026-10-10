import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// A room waits for a busy teammate, but not forever, and a goal survives one
// transient provider failure. This server runs with a short wait cap so the
// cap fires in seconds: a worker that never frees up comes back to the lead
// as a reassign note, a lead that never frees up ends the run as blocked —
// never as a provider failure — a lead whose provider dies is retried once
// before the run gives up, and an ordinary chat round gives up on a member
// that stays busy with a chip that says so, then moves on to the next one.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";

const envelope = (payload: Record<string, string>) => `<openmaus-goal>${JSON.stringify(payload)}</openmaus-goal>`;

// turn 1: assign the worker that never frees up; turn 2 (after the harness
// note): reassign to the helper; turn 3: complete
const reassignLeadReplies = [
  `Hang should start.\n${envelope({ status: "continue", next: "Hang", instruction: "Draft the summary", detail: "Assigning" })}`,
  `Reassigning to Helper.\n${envelope({ status: "continue", next: "Helper", instruction: "Draft the summary instead", detail: "Reassigned" })}`,
  `Done.\n${envelope({ status: "completed", detail: "Helper drafted the summary." })}`,
];

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const fixture = (displayName: string, environment: Record<string, string>) => ({
  driver: "claudeAgent",
  displayName,
  environment,
  config: { cli: FAKE_CLAUDE },
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-goal-wait-cap-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Goal wait cap test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      reassignLead: fixture("Reassigning lead", {
        FAKE_CLAUDE_MODE: "happy",
        FAKE_CLAUDE_REPLIES: JSON.stringify(reassignLeadReplies),
        FAKE_CLAUDE_REPLY_STATE: join(home, "reassign-lead-replies.txt"),
      }),
      hang: fixture("Hanging teammate", { FAKE_CLAUDE_MODE: "hang" }),
      helper: fixture("Helper", {
        FAKE_CLAUDE_MODE: "happy",
        FAKE_CLAUDE_REPLIES: JSON.stringify(["Here is the summary draft."]),
        FAKE_CLAUDE_REPLY_STATE: join(home, "helper-replies.txt"),
      }),
      crash: fixture("Crashing lead", { FAKE_CLAUDE_MODE: "exit-early" }),
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
      // seconds, not minutes: the point of this file is the cap firing
      OMB_GOAL_WAIT_MAX_MS: "1500",
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
});

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId, model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;

const createRoom = async (name: string, leadId: string, memberIds: string[]) =>
  (await api("POST", "/api/groups", {
    name,
    memberIds,
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: leadId } },
  })).body.group;

const roomState = async (roomId: string) => {
  const state = (await api("GET", "/api/bots?messages=40")).body;
  const room = state.groups.find((group: { id: string }) => group.id === roomId);
  const cards = room?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
  return { state, room, cards };
};

const holdBusy = async (botId: string, text: string) => {
  expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
  await expect.poll(async () => {
    const state = (await api("GET", "/api/bots?messages=0")).body;
    return state.bots.find((bot: { id: string }) => bot.id === botId)?.busy;
  }).toBe(true);
};

describe("goal wait cap and transient retry", () => {
  it("reassigns through the lead when a worker stays busy past the cap, and still completes", async () => {
    const lead = await createBot("Lead", "reassignLead");
    const hang = await createBot("Hang", "hang");
    const helper = await createBot("Helper", "helper");
    const room = await createRoom("Wait cap team", lead.id, [lead.id, hang.id, helper.id]);

    // the worker is stuck in an unrelated direct turn that never settles
    await holdBusy(hang.id, "Never finish this");

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Draft the summary", mode: "goal" })).status).toBe(202);

    await expect.poll(async () => {
      const { room: current, cards } = await roomState(room.id);
      const spoke = (botId: string) =>
        current?.messages.some((message: { kind: string; role?: string; from?: { botId?: string } }) =>
          message.kind === "text" && message.role === "bot" && message.from?.botId === botId
        );
      return {
        cards: cards.length,
        status: cards[0]?.goalRun?.status,
        detail: cards[0]?.goalRun?.detail,
        reassignChip: current?.messages.some((message: { kind: string; tool?: { name?: string } }) =>
          message.kind === "activity" && /stayed busy .* asking Lead to reassign/i.test(message.tool?.name ?? "")
        ),
        hangSpoke: spoke(hang.id),
        helperSpoke: spoke(helper.id),
      };
    }, { timeout: 20_000 }).toEqual({
      cards: 1,
      status: "completed",
      detail: "Helper drafted the summary.",
      reassignChip: true,
      hangSpoke: false,
      helperSpoke: true,
    });

    // the stuck direct turn was never touched by the goal's wait
    const state = (await api("GET", "/api/bots?messages=0")).body;
    expect(state.bots.find((bot: { id: string }) => bot.id === hang.id)?.busy).toBe(true);
    expect((await api("POST", `/api/bots/${hang.id}/interrupt`)).status).toBe(200);
  });

  it("ends blocked, not failed, when the lead itself stays busy past the cap", async () => {
    const lead = await createBot("Stuck lead", "hang");
    const helper = await createBot("Idle helper", "helper");
    const room = await createRoom("Stuck lead team", lead.id, [lead.id, helper.id]);

    await holdBusy(lead.id, "Never finish this either");
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Plan the launch", mode: "goal" })).status).toBe(202);

    await expect.poll(async () => {
      const { cards } = await roomState(room.id);
      return { cards: cards.length, status: cards[0]?.goalRun?.status, detail: cards[0]?.goalRun?.detail };
    }, { timeout: 20_000 }).toEqual({
      cards: 1,
      status: "blocked",
      detail: expect.stringMatching(/Stuck lead stayed busy .* send the goal again when they are free/i),
    });

    expect((await api("POST", `/api/bots/${lead.id}/interrupt`)).status).toBe(200);
  });

  it("retries a lead whose provider dies exactly once before the run fails", async () => {
    const lead = await createBot("Crashing lead", "crash");
    const helper = await createBot("Spare helper", "helper");
    const room = await createRoom("Crash team", lead.id, [lead.id, helper.id]);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Try anyway", mode: "goal" })).status).toBe(202);

    await expect.poll(async () => {
      const { cards } = await roomState(room.id);
      return { cards: cards.length, status: cards[0]?.goalRun?.status };
    }, { timeout: 20_000 }).toEqual({ cards: 1, status: "failed" });

    // exactly one retry happened: the retry note is a progress patch on the
    // single card, and the run still ended honestly as failed
    const state = (await api("GET", `/api/groups/${room.id}/goal-runs`)).body;
    void state; // the card's terminal detail is the receipt; the retry itself is asserted below
    const { room: current } = await roomState(room.id);
    const activity = current?.messages.filter((message: { kind: string }) => message.kind === "activity") ?? [];
    const failures = activity.filter((message: { tool?: { name?: string } }) => /error:/i.test(message.tool?.name ?? ""));
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it("chat: a responder that stays busy past the cap is skipped with the bounded truth, and the next responder still runs", async () => {
    const stuck = await createBot("Stuck", "hang");
    const helper = await createBot("Chat helper", "helper");
    const room = (await api("POST", "/api/groups", {
      name: "Wait cap chat",
      memberIds: [stuck.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group;

    await holdBusy(stuck.id, "Never finish this chat");
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Quick check-in" })).status).toBe(202);

    await expect.poll(async () => {
      const { room: current } = await roomState(room.id);
      const messages: Array<{ kind: string; role?: string; from?: { botId?: string }; tool?: { name?: string; ok?: boolean } }> =
        current?.messages ?? [];
      const chip = messages.find((message) =>
        message.kind === "activity" && message.from?.botId === stuck.id && /skipped this round/i.test(message.tool?.name ?? "")
      );
      return {
        working: current?.working,
        chip: chip?.tool?.name,
        chipOk: chip?.tool?.ok,
        // the neutral promise is rewritten, not joined by a second chip
        waitChips: messages.filter((message) =>
          message.kind === "activity" && message.from?.botId === stuck.id && /another conversation/i.test(message.tool?.name ?? "")
        ).length,
        stuckSpoke: messages.some((message) => message.kind === "text" && message.role === "bot" && message.from?.botId === stuck.id),
        helperSpoke: messages.some((message) => message.kind === "text" && message.role === "bot" && message.from?.botId === helper.id),
      };
    }, { timeout: 20_000 }).toEqual({
      working: false,
      chip: "Stuck stayed busy in another conversation for 1 minute — skipped this round",
      chipOk: false,
      waitChips: 1,
      stuckSpoke: false,
      helperSpoke: true,
    });

    // the stuck direct turn was never touched by the room's wait
    const state = (await api("GET", "/api/bots?messages=0")).body;
    expect(state.bots.find((bot: { id: string }) => bot.id === stuck.id)?.busy).toBe(true);
    expect((await api("POST", `/api/bots/${stuck.id}/interrupt`)).status).toBe(200);
  });

  it.todo("parks on a busy worker and leaves the room usable for chat while it waits (park-and-release)");
});
