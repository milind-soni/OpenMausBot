import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewAction } from "../approval-review.ts";
import type { AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import type { floorReading } from "../safety-floor.ts";
import { bindSafetyFloor } from "../safety-floor-gate.ts";
import { createApprovalReviewService } from "./approval-review.ts";

const mocks = vi.hoisted(() => ({ review: vi.fn(), log: vi.fn() }));
vi.mock("../approval-review.ts", async (original) => ({ ...await original<typeof import("../approval-review.ts")>(), reviewApproval: mocks.review }));
vi.mock("../decision-log.ts", () => ({ appendDecision: mocks.log }));

let cfg: AppConfig;
let current: boolean;
let reading: "clear" | "blocked" | "unreadable" | "throws";
let order: string[];
let reader: ReturnType<typeof vi.fn<typeof floorReading>>;
const action = { tool: "Bash", arguments: { command: "printf fixture" } };

function fixture() {
  const appendMessage = vi.fn();
  const store = { bot: () => ({ id: "bot", name: "Fixture", soul: "Unchanged standing instructions" }), activePath: () => [], appendMessage } as unknown as Store;
  const service = createApprovalReviewService({ store: () => store, config: () => cfg,
    watchdog: () => ({ setCheckpointOwnsDeadline: vi.fn() }), getProvider: () => undefined,
    providerRefusal: () => null, assertBudget: vi.fn(), bookUsage: vi.fn(), dataDir: "/fixture",
    sourceApprovalMode: () => "auto", roomApprovalMode: () => "auto" });
  const controller = new AbortController();
  return { run: (call: ReviewAction = action) => service.reviewToolForTurn("bot", "thread", { instanceId: "fixture", model: "fixture" }, () => current)(call, controller.signal), controller };
}

beforeEach(() => {
  vi.clearAllMocks(); cfg = {}; current = true; reading = "clear"; order = [];
  reader = vi.fn<typeof floorReading>(() => {
    order.push("floor");
    if (reading === "throws") throw new Error("Synthetic parser failure");
    if (reading === "unreadable") return { read: false };
    return { read: true, verdict: reading === "blocked" ? { rule: "delete-root", label: "synthetic blocked command" } : null };
  });
  bindSafetyFloor(() => cfg, reader, "darwin");
  mocks.review.mockImplementation(async () => { order.push("review"); return { decision: "allow", reason: "Existing reviewer decision" }; });
});
afterEach(() => bindSafetyFloor(() => ({})));

describe("app-owned automatic review and the optional safety floor", () => {
  it("keeps the default off and preserves existing review", async () => {
    reading = "blocked";
    expect(await fixture().run()).toMatchObject({ decision: "allow", reason: "Existing reviewer decision" });
    expect(reader).not.toHaveBeenCalled();
  });
  it("denies a blocked command before consulting the reviewer, using its complete text", async () => {
    cfg.safetyFloor = { enabled: true }; reading = "blocked";
    const command = "printf " + "x".repeat(500) + "; synthetic blocked suffix";
    expect(await fixture().run({ tool: "Bash", arguments: { command } })).toMatchObject({ decision: "deny" });
    expect(reader.mock.calls[0][0]).toBe(command);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("/fixture", expect.objectContaining({ source: "safety-floor", decision: "auto-denied" }));
  });
  it.each(["unreadable", "throws"] as const)("asks without calling the reviewer when parsing is %s", async (value) => {
    cfg.safetyFloor = { enabled: true }; reading = value;
    expect(await fixture().run()).toMatchObject({ decision: "ask", reason: expect.stringContaining("could not read") });
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it.each(["allow", "deny", "ask"] as const)("preserves a clear command's reviewer %s", async (decision) => {
    cfg.safetyFloor = { enabled: true };
    mocks.review.mockImplementation(async () => { order.push("review"); return { decision, reason: "Existing reviewer decision" }; });
    expect(await fixture().run()).toMatchObject({ decision, reason: expect.stringContaining("Existing reviewer decision") });
    expect(order.indexOf("review")).toBeGreaterThan(order.indexOf("floor"));
    if (decision === "allow") expect(order.at(-1)).toBe("floor");
  });
  it("checks a newly enabled floor again before consuming a pending allow", async () => {
    mocks.review.mockImplementation(async () => { cfg.safetyFloor = { enabled: true }; reading = "blocked"; return { decision: "allow", reason: "Old allow" }; });
    expect(await fixture().run()).toMatchObject({ decision: "deny" });
    expect(mocks.log).not.toHaveBeenCalledWith("/fixture", expect.objectContaining({ source: "auto-review", decision: "auto-approved" }));
  });
  it("asks if the floor cannot read a command after the review completes", async () => {
    cfg.safetyFloor = { enabled: true };
    mocks.review.mockImplementation(async () => { reading = "unreadable"; return { decision: "allow", reason: "Old allow" }; });
    expect(await fixture().run()).toMatchObject({ decision: "ask" });
  });
  it.each(["cancel", "revoke"] as const)("does not consume an allow after %s", async (change) => {
    cfg.safetyFloor = { enabled: true }; const f = fixture();
    mocks.review.mockImplementation(async () => { if (change === "cancel") f.controller.abort(); else current = false; return { decision: "allow", reason: "Stale allow" }; });
    expect(await f.run()).toMatchObject({ decision: "ask" });
    expect(mocks.log).not.toHaveBeenCalledWith("/fixture", expect.objectContaining({ decision: "auto-approved" }));
  });
  it("does not start a review for an already revoked turn", async () => {
    cfg.safetyFloor = { enabled: true }; current = false;
    expect(await fixture().run()).toMatchObject({ decision: "ask" });
    expect(reader).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
  });
  it("never interprets message content or a display summary as a command", async () => {
    cfg.safetyFloor = { enabled: true }; reading = "blocked";
    expect(await fixture().run({ tool: "SendMessage", arguments: { body: "synthetic blocked text" } })).toMatchObject({ decision: "allow" });
    expect(reader).not.toHaveBeenCalled();
  });
  it("preserves upstream's inert Windows behavior", async () => {
    cfg.safetyFloor = { enabled: true }; reading = "blocked"; bindSafetyFloor(() => cfg, reader, "win32");
    expect(await fixture().run()).toMatchObject({ decision: "allow" }); expect(reader).not.toHaveBeenCalled();
  });
});
