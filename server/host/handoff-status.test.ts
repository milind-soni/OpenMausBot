import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { HandoffStatusLine } from "../../shared/handoff-status.ts";
import { createHandoffStatus, handoffLine, HANDOFF_LINES_FILE, type HandoffNode, type HandoffStatusDeps } from "./handoff-status.ts";

const MIRA = "p_mmmmmmmmmmmmmmmmmmmmmm";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const node = (over: Partial<HandoffNode> = {}): HandoffNode => ({ id: "a1", status: "queued", botId: "coder", threadId: "work", result: "", ...over });

describe("handoffLine", () => {
  it("maps the record's status to claimed, working, waiting, done and failed", () => {
    const at = 5;
    expect(handoffLine(node({ status: "queued" }), { waitingBots: [] }, at)).toEqual({ id: "a1", state: "claimed", at });
    expect(handoffLine(node({ status: "running" }), { waitingBots: [] }, at).state).toBe("working");
    expect(handoffLine(node({ status: "resume" }), { waitingBots: [] }, at).state).toBe("working");
    expect(handoffLine(node({ status: "waiting" }), { waitingBots: ["Writer"] }, at)).toMatchObject({ state: "waiting", waitingOn: { kind: "bot", name: "Writer" } });
    expect(handoffLine(node({ status: "waiting" }), { waitingBots: ["A", "B", "C"] }, at).waitingOn).toEqual({ kind: "bot", name: "A, B +1" });
    expect(handoffLine(node({ status: "completed", result: "Built it." }), { waitingBots: [] }, at)).toEqual({ id: "a1", state: "done", at });
    expect(handoffLine(node({ status: "failed", outcomeDetail: "The engine stalled\nsecond line" }), { waitingBots: [] }, at)).toMatchObject({ state: "failed", why: "The engine stalled second line" });
    expect(handoffLine(node({ status: "cancelled", outcome: "stopped" }), { waitingBots: [] }, at)).toMatchObject({ state: "failed", why: "Stopped" });
  });

  it("waits on the person when it parked on a question: by name on a team, as you elsewhere", () => {
    expect(handoffLine(node({ status: "waiting", question: "Which account?" }), { waitingBots: [] }, 1).waitingOn).toEqual({ kind: "person" });
    expect(handoffLine(node({ status: "waiting", question: "Which account?" }), { waitingBots: [], askedPerson: "Mira", forPerson: { name: "Mira" } }, 1))
      .toMatchObject({ waitingOn: { kind: "person", name: "Mira" }, forPerson: { name: "Mira" } });
  });

  it("never carries the question, and keeps a private failure's words out of a shared place", () => {
    const line = handoffLine(node({ status: "waiting", question: "the secret plan?" }), { waitingBots: [] }, 1);
    expect(JSON.stringify(line)).not.toContain("secret");
    expect(handoffLine(node({ status: "failed", outcomeDetail: "Mira's salary sheet was locked" }), { waitingBots: [], forPerson: { name: "Mira", private: true } }, 1))
      .toEqual({ id: "a1", state: "failed", forPerson: { name: "Mira", private: true }, at: 1 });
  });
});

function harness(over: Partial<HandoffStatusDeps> = {}, dir = mkdtempSync(join(tmpdir(), "omb-handoff-status-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const nodes = new Map<string, HandoffNode>();
  const rows = new Map<string, { id: string; threadRef?: { botId: string; threadId: string; title: string }; handoff?: HandoffStatusLine }>();
  const republished: string[] = [];
  let clock = 100;
  const status = createHandoffStatus({
    dataDir: dir, now: () => clock,
    node: (id) => nodes.get(id),
    children: (parent) => [...nodes.values()].filter((child) => child.parentId === parent.id),
    botName: (botId) => ({ coder: "Coder", writer: "Writer" })[botId],
    store: {
      messagesFor: (() => [...rows.values()]) as never,
      patchMessage: ((_threadId: string, id: string, patch: Record<string, unknown>) => { rows.set(id, { ...rows.get(id)!, ...patch }); }) as never,
    },
    republish: (botId) => republished.push(botId),
    log: () => {},
    ...over,
  });
  return { dir, nodes, rows, republished, status, tick: (ms: number) => { clock += ms; } };
}

describe("createHandoffStatus", () => {
  it("updates the Sent-to row through claimed, working, waiting on a bot and done, and the work conversation's task with it", () => {
    const h = harness();
    h.nodes.set("a1", node());
    h.rows.set("m1", { id: "m1", threadRef: { botId: "coder", threadId: "work", title: "Build the page" } });
    h.status.track("a1", "lead-chat", "m1");
    const seen = [h.rows.get("m1")!.handoff!.state];
    for (const next of [{ status: "running" as const }, { status: "waiting" as const }]) {
      h.nodes.set("a1", node(next));
      if (next.status === "waiting") h.nodes.set("c1", node({ id: "c1", parentId: "a1", status: "running", botId: "writer", threadId: "w2" }));
      h.tick(10);
      h.status.refresh();
      seen.push(h.rows.get("m1")!.handoff!.state);
    }
    expect(h.rows.get("m1")!.handoff!.waitingOn).toEqual({ kind: "bot", name: "Writer" });
    expect(h.status.forWork("work")).toEqual({ handoff: h.rows.get("m1")!.handoff });
    h.nodes.set("a1", node({ status: "completed" }));
    h.status.refresh();
    seen.push(h.rows.get("m1")!.handoff!.state);
    expect(seen).toEqual(["claimed", "working", "waiting", "done"]);
    expect(h.status.tracking()).toEqual([]);
    expect(h.republished.every((botId) => botId === "coder")).toBe(true);
    expect(h.rows.get("m1")!.threadRef!.title).toBe("Build the page");
  });

  it("patches only on a change", () => {
    const h = harness();
    h.nodes.set("a1", node({ status: "running" }));
    h.rows.set("m1", { id: "m1" });
    h.status.track("a1", "lead-chat", "m1");
    const before = h.republished.length;
    h.status.refresh();
    h.status.refresh();
    expect(h.republished.length).toBe(before);
  });

  it("keeps tracking across a restart and drops what the records no longer hold", () => {
    const first = harness();
    first.nodes.set("a1", node({ status: "running" }));
    first.nodes.set("a2", node({ id: "a2", status: "running" }));
    first.rows.set("m1", { id: "m1" });
    first.rows.set("m2", { id: "m2" });
    first.status.track("a1", "lead-chat", "m1");
    first.status.track("a2", "lead-chat", "m2");
    expect(JSON.parse(readFileSync(join(first.dir, HANDOFF_LINES_FILE), "utf8")).lines).toHaveLength(2);
    const again = harness({}, first.dir);
    again.rows.set("m1", { id: "m1" });
    again.nodes.set("a1", node({ status: "completed" }));
    again.status.refresh();
    expect(again.rows.get("m1")!.handoff!.state).toBe("done");
    expect(again.status.tracking()).toEqual([]);
    expect(JSON.parse(readFileSync(join(first.dir, HANDOFF_LINES_FILE), "utf8")).lines).toEqual([]);
  });

  it("on a team names the asker, and hides a private chat's title from a shared row", () => {
    const h = harness({ team: { personName: (person) => (person === MIRA ? "Mira" : undefined), privateTo: (threadId) => (threadId === "work" ? MIRA : null) } });
    h.nodes.set("a1", node({ status: "running", origin: { kind: "user", request: "x", person: MIRA } }));
    h.rows.set("m1", { id: "m1", threadRef: { botId: "coder", threadId: "work", title: "Mira's raise" } });
    h.status.track("a1", "shared-chat", "m1");
    expect(h.rows.get("m1")).toMatchObject({ handoff: { state: "working", forPerson: { name: "Mira", private: true } }, threadRef: { title: "" } });
    const own = harness({ team: { personName: () => "Mira", privateTo: () => MIRA } });
    own.nodes.set("a1", node({ status: "running", origin: { kind: "user", request: "x", person: MIRA } }));
    own.rows.set("m1", { id: "m1", threadRef: { botId: "coder", threadId: "work", title: "Mira's raise" } });
    own.status.track("a1", "miras-chat", "m1");
    expect(own.rows.get("m1")).toMatchObject({ handoff: { forPerson: { name: "Mira" } }, threadRef: { title: "Mira's raise" } });
    expect(own.rows.get("m1")!.handoff!.forPerson!.private).toBeUndefined();
  });

  it("names nobody off a team", () => {
    const h = harness();
    h.nodes.set("a1", node({ status: "waiting", question: "Which?", origin: { kind: "user", request: "x", person: MIRA } }));
    h.rows.set("m1", { id: "m1" });
    h.status.track("a1", "chat", "m1");
    expect(h.rows.get("m1")!.handoff).toEqual({ id: "a1", state: "waiting", waitingOn: { kind: "person" }, at: 100 });
  });
});
