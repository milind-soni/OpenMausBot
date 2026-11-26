import { describe, expect, it } from "vitest";

import type { CoordinatorHost, HandoffView, HostTurnResult } from "../coordinator.ts";
import { RuntimeCoordinator } from "../runtime-coordinator.ts";
import type { Message } from "../store.ts";
import { handoffResultRef, noticeQuiet, stopHandedOn, type HandoffStopDeps } from "./handoff-stop.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** A host whose every handed-off turn is a command that never ends by itself: only an abort ends it, as an interrupt does. */
/** `kept`: the work's result is withheld from the requester's conversation (a room reading one person's private work). */
/** `stallNow`: a quiet limit already passed, so the next tick stops the work as stalled. */
function rig(kept = false, stallNow = false) {
  const aborted: string[] = [];
  const reports: Array<{ child: HandoffView; parent?: HandoffView }> = [];
  const host: CoordinatorHost = {
    validate: () => undefined,
    busy: () => false,
    run: (node, _resumed, signal) => node.parentId === undefined ? Promise.resolve({ ok: true, text: "" })
      : new Promise<HostTurnResult>(resolve => signal.addEventListener("abort", () => { aborted.push(node.id); resolve({ ok: false, text: "Coordinated work was stopped" }); }, { once: true })),
    park: () => {},
    report: (child, parent) => { reports.push({ child, ...(parent ? { parent } : {}) }); },
    changed: () => {},
    names: (node, parent) => ({ requester: parent?.botId ?? "Rick", assignee: node.botId, person: "Rick" }),
    levelOf: () => ({ level: "full" }),
    chiefOf: () => false,
  };
  const coordinator = new RuntimeCoordinator({ dataDir: ":memory:", host, log: () => {}, ...(stallNow ? { runtimeLimits: { handoffQuietNoticeMs: -1, handoffQuietMaxMs: -1 } } : {}) });
  const rows: Array<{ threadId: string; row: Partial<Message> }> = [];
  const bots: Record<string, { id: string; name: string; color: string }> = {
    maus: { id: "maus", name: "MausBot", color: "#111" }, lead: { id: "lead", name: "Dev Lead", color: "#222" }, back: { id: "back", name: "Dev Back", color: "#333" },
  };
  const store = {
    bot: (id: string) => bots[id],
    appendMessage: (threadId: string, row: Partial<Message>) => { rows.push({ threadId, row }); return row; },
    taskByThread: (_botId: string, threadId: string) => threadId === "lead-work" ? { title: "Private: salary review" } : undefined,
  } as unknown as HandoffStopDeps["store"];
  const withheld = () => kept;
  coordinator.beginTurn({ id: "gen-maus", address: { botId: "maus", threadId: "maus-chat" }, brief: "Open the PR", level: "full", origin: { kind: "user", request: "Open the PR" } });
  const { node } = coordinator.enqueue({ botId: "maus", threadId: "maus-chat" }, "gen-maus", undefined, { botId: "lead", threadId: "lead-work" }, "Build the PR", {});
  coordinator.tick();
  return { coordinator, store, withheld, rows, aborted, reports, node };
}

describe("stopHandedOn: the bot that handed work on stops it", () => {
  it("interrupts the teammate's turn mid-command, ends it as stopped by that bot, and the requester hears it", async () => {
    const w = rig();
    expect(w.coordinator.node(w.node.id)?.status).toBe("running");
    const stopped = stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: w.node.id, why: "PARE AGORA" });
    expect(stopped).toMatchObject({ status: 200, body: { stopped: true, requestId: w.node.id, botName: "Dev Lead" } });
    expect(w.aborted).toEqual([w.node.id]);
    expect(w.coordinator.node(w.node.id)).toMatchObject({ status: "cancelled", outcome: "stopped", result: "Stopped by @MausBot, who handed this work on: PARE AGORA" });
    await flush();
    expect(w.reports.map(r => [r.child.id, r.parent?.id])).toEqual([[w.node.id, "gen-maus"]]);
    expect(w.rows).toEqual([expect.objectContaining({ threadId: "maus-chat", row: expect.objectContaining({ tool: expect.objectContaining({ name: "Stopped Dev Lead's work" }) }) })]);
  });

  it("refuses another bot, the requester from another conversation, an unknown id and work already ended, with what to do", () => {
    const w = rig();
    const other = stopHandedOn(w, { senderId: "back", senderName: "Dev Back", senderThreadId: "maus-chat", id: w.node.id, why: "" });
    expect(other).toMatchObject({ status: 403, body: { error: expect.stringContaining("Only the bot that handed") } });
    expect(stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "elsewhere", id: w.node.id, why: "" }).status).toBe(403);
    expect(stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: "nope", why: "" })).toMatchObject({ status: 404, body: { error: expect.stringContaining("requestId") } });
    expect(stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: "gen-maus", why: "" }).status).toBe(404);
    expect(w.aborted).toEqual([]);
    expect(stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: w.node.id, why: "" }).status).toBe(200);
    expect(stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: w.node.id, why: "" })).toMatchObject({ status: 409, body: { error: expect.stringContaining("already ended") } });
  });

  it("is not remembered as the person's stop: the requester may hand the same work on again", () => {
    const w = rig();
    stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: w.node.id, why: "" });
    const again = w.coordinator.enqueue({ botId: "maus", threadId: "maus-chat" }, "gen-maus", undefined, { botId: "lead", threadId: "lead-work" }, "Build the PR", { rework: true });
    expect(again.node.status).not.toBe("cancelled");
  });
});

describe("handoffResultRef: the result row when handed-off work ends", () => {
  /** The work ends as the requester's stop or the quiet limit ends it; the result row reaches the requester's conversation. */
  async function ended(kept: boolean, how: "stopped" | "stalled") {
    const w = rig(kept, how === "stalled");
    if (how === "stopped") stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: w.node.id, why: "enough" });
    else w.coordinator.tick();
    await flush();
    const report = w.reports.find(r => r.child.id === w.node.id)!;
    expect(report.child).toMatchObject(how === "stopped" ? { status: "cancelled", outcome: "stopped" } : { status: "failed", outcome: "stalled" });
    return handoffResultRef(w, report.child, report.parent!);
  }

  it.each(["stopped", "stalled"] as const)("names no title or link where the work's result is withheld, after it is %s", async (how) => {
    const ref = await ended(true, how);
    expect(ref).toEqual({});
    expect(JSON.stringify(ref)).not.toMatch(/salary|lead-work/);
  });

  it.each(["stopped", "stalled"] as const)("links the work by its title where the requester reads its result, after it is %s", async (how) => {
    expect(await ended(false, how)).toEqual({ threadRef: { botId: "lead", threadId: "lead-work", title: "Private: salary review" } });
  });
});

describe("noticeQuiet: handed-off work that shows nothing", () => {
  it("shows it in the requester's conversation and hands its running turn a note on how to stop it", async () => {
    const w = rig();
    const steered: Array<{ threadId: string; text: string }> = [];
    const parent = { ...w.coordinator.node("gen-maus")!, status: "running" as const };
    noticeQuiet({ ...w, command: () => ({ command: "pnpm test", minutes: 45 }), steer: async (threadId, text) => { steered.push({ threadId, text }); return true; } },
      w.coordinator.node(w.node.id)!, parent, 20 * 60_000, 40 * 60_000);
    expect(w.rows).toEqual([expect.objectContaining({ threadId: "maus-chat", row: expect.objectContaining({
      tool: { name: "Dev Lead has shown no progress for 20 min", ok: true, output: "Still running: pnpm test (45 min). It is stopped in 40 min if nothing moves." } }) })]);
    expect(steered).toHaveLength(1);
    expect(steered[0]!.threadId).toBe("maus-chat");
    expect(steered[0]!.text).toContain(`stop "${w.node.id}"`);
    expect(steered[0]!.text).toContain(JSON.stringify("pnpm test"));
  });

  it("names no title, command or link where the work's result is withheld from the requester's conversation", async () => {
    const w = rig(true);
    const steered: string[] = [];
    noticeQuiet({ ...w, command: () => ({ command: "cat private-notes.md", minutes: 45 }), steer: async (_threadId, text) => { steered.push(text); return true; } },
      w.coordinator.node(w.node.id)!, { ...w.coordinator.node("gen-maus")!, status: "running" }, 20 * 60_000, 40 * 60_000);
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]!.row).not.toHaveProperty("threadRef");
    expect(w.rows[0]!.row.tool).toEqual({ name: "Dev Lead has shown no progress for 20 min", ok: true, output: "It is stopped in 40 min if nothing moves." });
    expect(steered).toHaveLength(1);
    expect(steered[0]).toContain(`stop "${w.node.id}"`);
    expect(JSON.stringify([w.rows, steered])).not.toMatch(/private-notes|salary/);
    stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: w.node.id, why: "enough" });
    expect(w.rows[1]!.row).not.toHaveProperty("threadRef");
    expect(JSON.stringify(w.rows)).not.toMatch(/salary/);
  });

  it("links the work by its title, with its command, where the requester's conversation reads its result", () => {
    const w = rig();
    noticeQuiet({ ...w, command: () => ({ command: "pnpm test", minutes: 45 }), steer: async () => true },
      w.coordinator.node(w.node.id)!, { ...w.coordinator.node("gen-maus")!, status: "waiting" }, 20 * 60_000, 40 * 60_000);
    stopHandedOn(w, { senderId: "maus", senderName: "MausBot", senderThreadId: "maus-chat", id: w.node.id, why: "enough" });
    expect(w.rows.map(r => r.row.threadRef)).toEqual([0, 1].map(() => ({ botId: "lead", threadId: "lead-work", title: "Private: salary review" })));
    expect(w.rows[0]!.row.tool?.output).toContain("Still running: pnpm test");
  });

  it("steers nothing when the requester has no turn running", () => {
    const w = rig();
    const steered: string[] = [];
    noticeQuiet({ ...w, command: () => null, steer: async (_threadId, text) => { steered.push(text); return true; } },
      w.coordinator.node(w.node.id)!, { ...w.coordinator.node("gen-maus")!, status: "waiting" }, 20 * 60_000, 40 * 60_000);
    expect(w.rows).toHaveLength(1);
    expect(steered).toEqual([]);
  });
});
