import { describe, expect, it } from "vitest";

import "../server-line-packs.ts";
import { CLOUD_OUTSIDE_KEY } from "../cloud-sharing.ts";
import type { HandoffView } from "../coordinator.ts";
import type { RoutineRun } from "../routines.ts";
import { createOutsideLineage, type OutsideLineageDeps } from "./outside-lineage.ts";

function world(over: Partial<OutsideLineageDeps> = {}) {
  const tasks = new Map<string, { threadId: string; outside?: true }>();
  for (const threadId of ["chat", "hook-run", "teammate", "results", "person-work"]) tasks.set(threadId, { threadId });
  const lines = new Map<string, Array<Record<string, unknown>>>();
  const rooms = new Set<string>();
  const nodes = new Map<string, HandoffView>();
  const runs = new Map<string, RoutineRun>();
  const store = {
    botByThread: (threadId: string) => (tasks.has(threadId) ? { id: "bot" } : null),
    taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
    patchTask: (_botId: string, threadId: string, patch: { outside?: true }) => { Object.assign(tasks.get(threadId)!, patch); },
    messagesFor: (threadId: string) => lines.get(threadId) ?? [],
    groupByThread: (threadId: string) => (rooms.has(threadId) ? { id: threadId } : undefined),
    appendMessage: (threadId: string, row: Record<string, unknown>) => { lines.set(threadId, [...(lines.get(threadId) ?? []), row]); return row; },
  } as unknown as OutsideLineageDeps["store"];
  const lineage = createOutsideLineage({
    home: true, team: true, solo: () => false, store, confinedNow: () => false,
    activeRun: (threadId) => runs.get(threadId) ?? null, writer: () => undefined, starters: () => [], guestOpened: () => false, ownerPerson: () => false,
    node: (id) => nodes.get(id), active: () => [...nodes.values()], language: () => undefined, ...over,
  });
  return { lineage, tasks, lines, rooms, nodes, runs };
}
const webhookRun = (threadId: string, more: Partial<RoutineRun> = {}) => ({ id: "run-1", routineId: "hook", routineName: "Inbox", botId: "bot", threadId, status: "running", triggerSource: "webhook", ...more }) as RoutineRun;

describe("work from outside stays with that work", () => {
  it("keeps a conversation confined after its run has ended, for good", () => {
    const w = world();
    w.runs.set("hook-run", webhookRun("hook-run"));
    expect(w.lineage.cloudGuestDriven("hook-run")).toBe(true);
    w.lineage.mark("hook-run");
    w.runs.delete("hook-run");
    expect(w.lineage.cloudGuestDriven("hook-run")).toBe(true);
    expect(w.lineage.outsideDrivenThread("hook-run")).toBe(true);
    expect(w.lineage.cloudGuestDriven("chat")).toBe(false);
  });

  it("carries the record to what a marked conversation hands on, and no further than that", () => {
    const w = world();
    w.lineage.mark("hook-run");
    w.lineage.carry("hook-run", "teammate");
    expect(w.tasks.get("teammate")?.outside).toBe(true);
    w.lineage.carry("chat", "person-work");
    expect(w.tasks.get("person-work")?.outside).toBeUndefined();
  });

  it("lets confined work reach only what is confined already, and everything else reach anything", () => {
    const w = world();
    w.lineage.mark("hook-run");
    w.lineage.mark("teammate");
    expect(w.lineage.mayReach("hook-run", "person-work")).toBe(false);
    expect(w.lineage.mayReach("hook-run", "teammate")).toBe(true);
    expect(w.lineage.mayReach("chat", "hook-run")).toBe(true);
    expect(w.lineage.mayReach("chat", "person-work")).toBe(true);
  });

  it("counts a routine outside work wrote as confined on every kind of Cloud, and a person's only on a shared personal one when it is not the owner's", () => {
    const team = world({ writer: (id) => (id === "made" ? CLOUD_OUTSIDE_KEY : "p_someone") });
    expect(team.lineage.routineRunsConfined("made")).toBe(true);
    expect(team.lineage.routineRunsConfined("persons")).toBe(false);
    const shared = world({ team: false, writer: (id) => (id === "owners" ? "owner" : "guest"), ownerPerson: (key) => key === "owner" });
    expect(shared.lineage.routineRunsConfined("owners")).toBe(false);
    expect(shared.lineage.routineRunsConfined("guests")).toBe(true);
  });

  it("confines a run of a routine outside work wrote on a Team Cloud, and a conversation it opened", () => {
    const run = world({ writer: () => CLOUD_OUTSIDE_KEY });
    run.runs.set("chat", { ...webhookRun("chat"), triggerSource: "manual" } as RoutineRun);
    expect(run.lineage.cloudGuestDriven("chat")).toBe(true);
    expect(world({ starters: (id) => (id === "chat" ? [CLOUD_OUTSIDE_KEY] : []) }).lineage.cloudGuestDriven("chat")).toBe(true);
  });

  it("keeps a personal Cloud's webhook run at its bot's level, as the owner's", () => {
    const solo = world({ team: false, solo: () => true });
    solo.lineage.mark("hook-run");
    expect(solo.lineage.outsideDrivenThread("hook-run")).toBe(true);
    expect(solo.lineage.cloudGuestDriven("hook-run")).toBe(false);
    expect(solo.lineage.handsNoLevel("hook-run")).toBe(true);
  });

  it("off a Cloud nothing is confined, and the record only stops a level travelling", () => {
    const desktop = world({ home: false, team: false });
    desktop.lineage.mark("hook-run");
    expect(desktop.lineage.cloudGuestDriven("hook-run")).toBe(false);
    expect(desktop.lineage.mayReach("hook-run", "person-work")).toBe(true);
    expect(desktop.lineage.handsNoLevel("hook-run")).toBe(true);
    expect(desktop.lineage.handsNoLevel("chat")).toBe(false);
  });

  it("settles at each start from what ran before: own run threads, an event's own chat, work still handed on", () => {
    const w = world();
    w.nodes.set("root", { id: "root", rootId: "root", threadId: "hook-run", botId: "bot", status: "waiting" } as HandoffView);
    w.nodes.set("kid", { id: "kid", rootId: "root", parentId: "root", threadId: "teammate", botId: "bot", status: "queued" } as HandoffView);
    w.lineage.settle([webhookRun("hook-run")], () => "results");
    expect(w.tasks.get("hook-run")?.outside).toBe(true);
    expect(w.tasks.get("results")?.outside).toBe(true);
    expect(w.tasks.get("teammate")?.outside).toBe(true);
    expect(w.tasks.get("person-work")?.outside).toBeUndefined();
  });

  it("settling off a Cloud leaves the chat a wait's follow-up ran in as it was", () => {
    const desktop = world({ home: false, team: false });
    desktop.lineage.settle([webhookRun("chat", { eventSource: "wait" })], () => undefined);
    expect(desktop.tasks.get("chat")?.outside).toBeUndefined();
    const cloud = world();
    cloud.lineage.settle([webhookRun("hook-run", { eventSource: "wait" })], () => undefined);
    expect(cloud.tasks.get("hook-run")?.outside).toBe(true);
  });

  it("tells a person once why the bot works without its shell here, and only on a Team Cloud", () => {
    const w = world();
    w.lineage.mark("hook-run");
    w.lineage.personLineConfined("hook-run");
    w.lineage.personLineConfined("hook-run");
    expect(w.lines.get("hook-run")).toHaveLength(1);
    w.lineage.personLineConfined("chat");
    expect(w.lines.get("chat")).toBeUndefined();
    const solo = world({ team: false, solo: () => true });
    solo.lineage.mark("hook-run");
    solo.lineage.personLineConfined("hook-run");
    expect(solo.lines.get("hook-run")).toBeUndefined();
  });

  it("names outside work in its own words when the engine can't run confined", () => {
    const w = world();
    w.lineage.mark("hook-run");
    expect(w.lineage.guestEngineRefusal("hook-run")).toContain("Work from outside came into this conversation");
  });
});

describe("confinement explanations follow the conversation language without choosing branches by translated text", () => {
  it.each([
    ["en", "Work from outside came into this conversation", "This bot's AI can't run it that way.", "This conversation is from before the Cloud was only yours"],
    ["pt-br", "Esta conversa recebeu trabalho de fora", "A IA deste bot não pode trabalhar dessa forma.", "Esta conversa é de antes de o Cloud ser só seu"],
    ["de", "Arbeit von außerhalb ist in diese Unterhaltung gelangt", "Die KI dieses Bots kann so nicht arbeiten.", "Diese Unterhaltung stammt aus der Zeit, bevor die Cloud nur dir gehörte"],
  ])("keeps both refusal branches in %s", (language, outside, prefix, old) => {
    const w = world({ language: () => language });
    w.lineage.mark("hook-run");
    expect(w.lineage.confinedWhy("hook-run")).toContain(outside);
    expect(w.lineage.guestEngineRefusal("hook-run")).toContain(prefix);
    expect(w.lineage.guestEngineRefusal("hook-run")).toContain(outside);
    expect(w.lineage.guestEngineRefusal("chat")).toContain(old);
    expect(w.lineage.guestEngineRefusal("chat")).not.toContain(prefix);
  });
});
