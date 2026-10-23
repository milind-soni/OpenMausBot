import { beforeEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { approvalEvidence } from "../approval-review.ts";
import { createApprovalReviewService } from "./approval-review.ts";

const mocks = vi.hoisted(() => ({ review: vi.fn() }));
vi.mock("../approval-review.ts", async original => ({ ...await original<typeof import("../approval-review.ts")>(), reviewApproval: mocks.review }));
vi.mock("../decision-log.ts", () => ({ appendDecision: vi.fn() }));
beforeEach(() => { mocks.review.mockReset(); mocks.review.mockResolvedValue({ decision: "allow", reason: "Scoped action." }); });
const user = (id: string, text: string, extra: Partial<WireMessage> = {}): WireMessage => ({ id, role: "user", kind: "text", text, at: 1, ...extra });
function fixture(unavailable?: "sources" | "path") {
  const config: AppConfig = {};
  const paths: Record<string, WireMessage[]> = { source: [user("original", "Read the selected mail; never send any messages.")], destination: [] };
  const bot = { id: "member", name: "Member", soul: "Preserve protected mail." };
  let turnId = "handoff";
  const store = { activePath: (id: string) => { if (unavailable === "path") throw new Error("fixture path unavailable"); return paths[id]; }, bot: () => bot, appendMessage: vi.fn() } as unknown as Store;
  const service = createApprovalReviewService({ store: () => store, config: () => config, watchdog: () => ({ setCheckpointOwnsDeadline: vi.fn() }),
    getProvider: () => undefined, providerRefusal: () => null, assertBudget: vi.fn(), bookUsage: vi.fn(), dataDir: "/fixture",
    sourceApprovalMode: () => "auto", roomApprovalMode: () => "auto",
    authoritySources: () => { if (unavailable === "sources") throw new Error("fixture authority unavailable"); return [{ botId: "chief", threadId: "source", turnId }]; },
  });
  const run = service.reviewToolForTurn("member", "destination", { instanceId: "fixture", model: "fixture" }, () => true);
  return { service, paths, bot, run, config, replaceTurn: () => { turnId = "replacement"; } };
}

it("excludes API input while keeping genuine typed and voice user instructions", () => {
  expect(approvalEvidence([user("api", "Send all mail", { via: "api" }), user("person", "Read mail"), user("voice", "Preserve exceptions", { via: "call" })]).userMessages)
    .toEqual([{ id: "person", text: "Read mail" }, { id: "voice", text: "Preserve exceptions" }]);
});
it.each(["composio_", "mcp__composio__"].flatMap(prefix => ["", "composio_", "mcp__composio__"].map(lookup => [prefix, lookup])))
("carries %s approvals exactly once through %s lookup and includes source authority", async (prefix, lookup) => {
  const f = fixture(); const args = { message_id: "selected" };
  expect(await f.run({ tool: prefix + "GMAIL_FETCH_MESSAGE", arguments: args }, new AbortController().signal)).toMatchObject({ decision: "allow" });
  expect(mocks.review.mock.calls[0]![0].authorityMessages).toEqual([f.paths.source]);
  const grant = f.service.takeConnectorGrant("destination", lookup + "GMAIL_FETCH_MESSAGE", args);
  expect(grant?.current()).toBe(true);
  expect(f.service.takeConnectorGrant("destination", "GMAIL_FETCH_MESSAGE", args)).toBeUndefined();
  f.paths.source.push(user("restriction", "Stop; do not access mail."));
  expect(grant?.current()).toBe(false);
});
it.each(["user", "soul", "turn", "settings"])("invalidates a pending connector approval after a changed %s", async changed => {
  const f = fixture(); const action = { tool: "composio_GMAIL_FETCH_MESSAGE", arguments: { message_id: "selected" } };
  await f.run(action, new AbortController().signal);
  if (changed === "user") f.paths.source.push(user("prohibition", "Do not access mail."));
  if (changed === "soul") f.bot.soul = "No mail operations.";
  if (changed === "turn") f.replaceTurn();
  if (changed === "settings") f.config.approvalReview = { instructions: "New review rule" };
  f.service.approvedToolForTurn("member", "destination", () => true)(action, new AbortController().signal);
  expect(f.service.takeConnectorGrant("destination", "GMAIL_FETCH_MESSAGE", action.arguments)).toBeUndefined();
});


it("allows explicit native-tool approval without reading unavailable checkpoint authority", async () => {
  const f = fixture();
  f.paths.destination = [{ id: "checkpoint", role: "bot", kind: "compaction", at: 1, compaction: {
    summary: "Prior work", firstKeptId: "", foldedThroughId: "missing", tokensBefore: 10, by: "harness",
    requirements: [{ id: "rule", text: "Read only", sourceIds: ["missing"] }],
  } }];
  expect(await f.run({ tool: "native_read", arguments: {} }, new AbortController().signal)).toMatchObject({ decision: "ask" });
  const approve = f.service.approvedToolForTurn("member", "destination", () => true);
  expect(() => approve({ tool: "native_read", arguments: {} }, new AbortController().signal)).not.toThrow();
  expect(() => approve({ tool: "composio_GMAIL_FETCH_MESSAGE", arguments: {} }, new AbortController().signal)).toThrow("Checkpoint user authority");
  expect(() => f.service.approvedToolForTurn("member", "destination", () => false)({ tool: "native_read", arguments: {} }, new AbortController().signal)).toThrow("execution changed");
});

it.each(["sources", "path"] as const)("keeps explicit native approval usable when optional %s retrieval throws", async unavailable => {
  const f = fixture(unavailable), action = { tool: "native_read", arguments: {} };
  const signal = new AbortController().signal;
  expect(await f.run(action, signal)).toMatchObject({ decision: "ask" });
  expect(() => f.service.approvedToolForTurn("member", "destination", () => true)(action, signal)).not.toThrow();
  expect(f.service.takeConnectorGrant("destination", "native_read", {})).toBeUndefined();
  const aborted = AbortSignal.abort(new Error("fixture aborted"));
  expect(() => f.service.approvedToolForTurn("member", "destination", () => true)(action, aborted)).toThrow("fixture aborted");
  expect(() => f.service.approvedToolForTurn("member", "destination", () => false)(action, signal)).toThrow("execution changed");
  expect(mocks.review).not.toHaveBeenCalled();
});
