import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { persistBotUpdate, type Bot, type InstanceInfo } from "@/state/store";
import { EFFORT_LEVELS } from "../../shared/wire";
import {
  applyTeamPlan,
  planNeedsLocalAutoConsent,
  planTeamChange,
  TEAM_APPROVAL_MODES,
  teamBots,
  teamEffortChoices,
  teamModelChoices,
  teamResultCounts,
} from "./team-bulk-settings";
import { TeamSettingsRows } from "@/components/TeamSettingsDialog";
import { TeamMenuItems } from "@/components/Sidebar";

vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

const engine = (instanceId: string, driverKind: string, models: string[], extra: Partial<InstanceInfo> = {}) => ({
  instanceId, driverKind, displayName: instanceId[0]!.toUpperCase() + instanceId.slice(1), enabled: true,
  snapshot: { state: "available" },
  models: { default: models[0]!, options: models.map((id) => ({ id, label: id })) },
  ...extra,
}) as unknown as InstanceInfo;

const instances = [
  engine("claude", "claudeAgent", ["opus", "sonnet"], { capabilities: { effortLevels: ["low", "medium", "high", "max"] } }),
  engine("codex", "codex", ["gpt-5", "gpt-5-mini"], { capabilities: { effortLevels: ["low", "medium", "high", "xhigh"] } }),
  engine("pi", "pi", ["local"], { capabilities: { modelVariants: true } }),
];

const bot = (id: string, fields: Partial<Bot> = {}) => ({
  id, threadId: `${id}-t`, name: id, title: "", description: "", notifications: true, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "opus" }, section: "Editing Team", ...fields,
}) as Bot;

describe("team-wide settings", () => {
  it("collects a team's visible bots, General being the bots without a team", () => {
    const bots = [bot("a"), bot("b", { section: " Editing Team " }), bot("c", { hidden: true }), bot("d", { section: undefined })];
    expect(teamBots(bots, "Editing Team").map((b) => b.id)).toEqual(["a", "b"]);
    expect(teamBots(bots, "").map((b) => b.id)).toEqual(["d"]);
  });

  it("plans an approval level per bot: unchanged, working, unsupported and Full on every thread", () => {
    const bots = [
      bot("ask", { approvalMode: "ask" }),
      bot("already", { approvalMode: "full" }),
      bot("working", { approvalMode: "ask", busy: true }),
      bot("antigravity", { approvalMode: "ask", modelSelection: { instanceId: "ag", model: "x" } }),
    ];
    const plan = planTeamChange(bots, [...instances, engine("ag", "antigravityAgent", ["x"])], { kind: "approval", mode: "full" });
    expect(plan.map((row) => row.status)).toEqual(["apply", "unchanged", "apply", "apply"]);
    expect(plan[0]).toMatchObject({ patch: { approvalMode: "full", applyToAllThreads: true } });
    expect(plan[2]).toMatchObject({ patch: { approvalMode: "full", applyToAllThreads: true } });
    const auto = planTeamChange([bots[3]!], [engine("ag", "antigravityAgent", ["x"])], { kind: "approval", mode: "auto" });
    expect(auto[0]).toMatchObject({ status: "skip", reason: "Ag does not offer this approval level" });
    expect(planTeamChange([bot("codex", { modelSelection: { instanceId: "codex", model: "gpt-5" } })], instances,
      { kind: "approval", mode: "edits" })[0]).toMatchObject({ status: "skip" });
  });

  it("sends every level to each bot and every one of its threads, the same way, as the bot API receives it", async () => {
    const withOpened = (id: string, botMode: "ask" | "full", threadMode: "ask" | "full") => bot(id, { approvalMode: botMode, tasks: [
      { threadId: `${id}-t`, title: "Main", createdAt: 1 }, { threadId: `${id}-new`, title: "New thread", createdAt: 2, approvalMode: threadMode },
    ] });
    const bots = [withOpened("a", "ask", "full"), withOpened("b", "full", "ask")];
    for (const mode of TEAM_APPROVAL_MODES) {
      const sent: unknown[] = [];
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        sent.push([path, JSON.parse(String(init?.body))]);
        return { bot: bots[0]! };
      });
      const plan = planTeamChange(bots, instances, { kind: "approval", mode });
      await applyTeamPlan(plan, (target, patch) => persistBotUpdate(target.id, patch, new AbortController().signal, request, undefined, target));
      expect(sent, mode).toEqual(bots.map((target) => [`/api/bots/${target.id}`, { approvalMode: mode, applyToAllThreads: true }]));
    }
  });

  it("sends a model as a bulk change, so each bot's threads with a model of their own keep it", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({ bot: bot("a") }));
    const plan = planTeamChange([bot("a")], instances, { kind: "model", model: "sonnet" });
    await applyTeamPlan(plan, (target, patch) => persistBotUpdate(target.id, patch, new AbortController().signal, request, undefined, target));
    expect(request.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
      ["/api/bots/a", { modelSelection: { instanceId: "claude", model: "sonnet" }, keepThreadModels: true }],
    ]);
  });

  it("calls a bot already set only when every one of its threads is, and sets one with a thread working too", () => {
    const tasks = (...modes: Array<"ask" | "auto" | undefined>) => modes.map((approvalMode, index) => ({ threadId: `t${index}`, title: "T", createdAt: index, approvalMode }));
    const plan = planTeamChange([
      bot("all", { approvalMode: "auto", tasks: tasks(undefined, "auto") }),
      bot("opened", { approvalMode: "auto", tasks: tasks(undefined, "ask") }),
      bot("working", { approvalMode: "ask", tasks: [...tasks(undefined), { threadId: "w", title: "W", createdAt: 9, busy: true }] }),
    ], instances, { kind: "approval", mode: "auto" });
    expect(plan.map((row) => row.status)).toEqual(["unchanged", "apply", "apply"]);
  });

  it("asks for the local-computer consent only when Auto reaches a bot on this computer", () => {
    expect(planNeedsLocalAutoConsent(planTeamChange([bot("a", { computer: "local" })], instances, { kind: "approval", mode: "auto" }))).toBe(true);
    expect(planNeedsLocalAutoConsent(planTeamChange([bot("a", { computer: "cloud" })], instances, { kind: "approval", mode: "auto" }))).toBe(false);
    expect(planNeedsLocalAutoConsent(planTeamChange([bot("a", { computer: "local" })], instances, { kind: "approval", mode: "ask" }))).toBe(false);
  });

  it("keeps each bot on its own engine and skips models and efforts that engine does not offer", () => {
    const bots = [
      bot("claude", { modelSelection: { instanceId: "claude", model: "sonnet", effort: "low" } }),
      bot("codex", { modelSelection: { instanceId: "codex", model: "gpt-5" } }),
      bot("pi", { modelSelection: { instanceId: "pi", model: "local", variant: "fast" } }),
      bot("gone", { modelSelection: { instanceId: "removed", model: "m" } }),
    ];
    const toOpus = planTeamChange(bots, instances, { kind: "model", model: "opus" });
    expect(toOpus.map((row) => row.status)).toEqual(["apply", "skip", "skip", "skip"]);
    expect(toOpus[0]).toMatchObject({ patch: { modelSelection: { instanceId: "claude", model: "opus", effort: "low" }, keepThreadModels: true } });
    expect(toOpus[1]).toMatchObject({ reason: "Codex does not offer opus" });
    expect(toOpus[3]).toMatchObject({ reason: "its AI isn't available" });

    const high = planTeamChange(bots, instances, { kind: "model", effort: "high" });
    expect(high.map((row) => row.status)).toEqual(["apply", "apply", "skip", "skip"]);
    expect(high[1]).toMatchObject({ patch: { modelSelection: { instanceId: "codex", model: "gpt-5", effort: "high" } } });
    expect(high[2]).toMatchObject({ reason: "Pi uses reasoning variants instead of effort levels" });
    expect(planTeamChange([bots[0]!], instances, { kind: "model", effort: "xhigh" })[0]).toMatchObject({ status: "skip", reason: "Claude does not offer this effort level" });

    expect(planTeamChange([bots[0]!], instances, { kind: "model", effort: null })[0])
      .toMatchObject({ patch: { modelSelection: { instanceId: "claude", model: "sonnet" } } });
    expect(planTeamChange([bots[2]!], instances, { kind: "model", model: "local" })[0]).toMatchObject({ status: "unchanged" });
    expect(planTeamChange([bot("busy", { busy: true })], instances, { kind: "model", model: "sonnet" })[0]).toMatchObject({ status: "skip" });
  });

  it("lists each model once with the engines offering it, and only effort levels some engine offers", () => {
    const bots = [bot("a"), bot("b", { modelSelection: { instanceId: "codex", model: "gpt-5" } })];
    expect(teamModelChoices(bots, instances).map((choice) => `${choice.id}:${choice.engines.join("+")}`))
      .toEqual(["gpt-5:Codex", "gpt-5-mini:Codex", "opus:Claude", "sonnet:Claude"]);
    expect(teamEffortChoices(bots, instances, EFFORT_LEVELS)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("applies one bot at a time and reports the server's refusal as the skip reason", async () => {
    const bots = [bot("a"), bot("b"), bot("c", { busy: true }), bot("d", { approvalMode: "auto", computer: "local" }), bot("e", { computer: "local" })];
    const plan = planTeamChange(bots, instances, { kind: "approval", mode: "auto" });
    const order: string[] = [];
    let inFlight = 0;
    const results = await applyTeamPlan(plan, async (target, patch) => {
      inFlight++;
      expect(inFlight).toBe(1);
      order.push(`${target.id}:${JSON.stringify(patch)}`);
      await Promise.resolve();
      inFlight--;
      if (target.id === "b") throw new Error("This provider does not support the selected approval level");
    }, { acknowledgeLocalAuto: true });
    expect(order).toEqual([
      'a:{"approvalMode":"auto","applyToAllThreads":true}',
      'b:{"approvalMode":"auto","applyToAllThreads":true}',
      'c:{"approvalMode":"auto","applyToAllThreads":true}',
      'e:{"approvalMode":"auto","applyToAllThreads":true,"acknowledgeLocalAuto":true}',
    ]);
    expect(results.map((row) => row.status)).toEqual(["applied", "skipped", "applied", "unchanged", "applied"]);
    expect(results[1]).toMatchObject({ reason: "This provider does not support the selected approval level" });
    expect(teamResultCounts(results)).toEqual({ applied: 3, unchanged: 1, skipped: 1 });
    const markup = renderToStaticMarkup(createElement(TeamSettingsRows, { rows: results }));
    expect(markup).toContain("Skipped: This provider does not support the selected approval level");
    expect(markup).toContain("Already set");
  });

  it("is offered in the team menu only when the caller passes the owner's action", () => {
    const base = { onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn() };
    expect(renderToStaticMarkup(createElement(TeamMenuItems, base))).not.toContain("Set for all bots");
    expect(renderToStaticMarkup(createElement(TeamMenuItems, { ...base, onSetForAll: vi.fn() }))).toContain("Set for all bots in this department…");
  });
});
