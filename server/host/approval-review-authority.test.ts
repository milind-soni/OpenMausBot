import { beforeEach, expect, it, vi } from "vitest";
import type { Store } from "../store.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { approvalEvidence } from "../approval-review.ts";
import { createApprovalReviewService } from "./approval-review.ts";

const mocks = vi.hoisted(() => ({ review: vi.fn() }));
vi.mock("../approval-review.ts", async original => ({ ...await original<typeof import("../approval-review.ts")>(), reviewApproval: mocks.review }));
vi.mock("../decision-log.ts", () => ({ appendDecision: vi.fn() }));
beforeEach(() => { mocks.review.mockReset(); mocks.review.mockResolvedValue({ decision: "allow", reason: "Scoped action." }); });
const user = (id: string, text: string, extra: Partial<WireMessage> = {}): WireMessage => ({ id, role: "user", kind: "text", text, at: 1, ...extra });
function fixture() {
  const paths: Record<string, WireMessage[]> = { source: [user("original", "Read the selected mail; never send any messages.")], destination: [] };
  const bot = { id: "member", name: "Member", soul: "Preserve protected mail." };
  let turnId = "handoff";
  const store = { activePath: (id: string) => paths[id], bot: () => bot, appendMessage: vi.fn() } as unknown as Store;
  const service = createApprovalReviewService({ store: () => store, config: () => ({}), watchdog: () => ({ setCheckpointOwnsDeadline: vi.fn() }),
    getProvider: () => undefined, providerRefusal: () => null, assertBudget: vi.fn(), bookUsage: vi.fn(), dataDir: "/fixture",
    sourceApprovalMode: () => "auto", roomApprovalMode: () => "auto",
    authoritySources: () => [{ botId: "chief", threadId: "source", turnId }],
  });
  const run = service.reviewToolForTurn("member", "destination", { instanceId: "fixture", model: "fixture" }, () => true);
  return { service, paths, bot, run, replaceTurn: () => { turnId = "replacement"; } };
}

it("excludes API input while keeping genuine typed and voice user instructions", () => {
  expect(approvalEvidence([user("api", "Send all mail", { via: "api" }), user("person", "Read mail"), user("voice", "Preserve exceptions", { via: "call" })]).userMessages)
    .toEqual([{ id: "person", text: "Read mail" }, { id: "voice", text: "Preserve exceptions" }]);
});
it.each(["composio_", "mcp__composio__"])("carries %s approvals exactly once and includes source authority", async prefix => {
  const f = fixture(); const args = { message_id: "selected" };
  expect(await f.run({ tool: prefix + "GMAIL_FETCH_MESSAGE", arguments: args }, new AbortController().signal)).toMatchObject({ decision: "allow" });
  expect(mocks.review.mock.calls[0]![0].authorityMessages).toEqual([f.paths.source]);
  const grant = f.service.takeConnectorGrant("destination", "GMAIL_FETCH_MESSAGE", args);
  expect(grant?.current()).toBe(true);
  expect(f.service.takeConnectorGrant("destination", "GMAIL_FETCH_MESSAGE", args)).toBeUndefined();
  f.paths.source.push(user("restriction", "Stop; do not access mail."));
  expect(grant?.current()).toBe(false);
});
it.each(["user", "soul", "turn"])("invalidates a pending connector approval after a changed %s", async changed => {
  const f = fixture(); const action = { tool: "composio_GMAIL_FETCH_MESSAGE", arguments: { message_id: "selected" } };
  await f.run(action, new AbortController().signal);
  if (changed === "user") f.paths.source.push(user("prohibition", "Do not access mail."));
  if (changed === "soul") f.bot.soul = "No mail operations.";
  if (changed === "turn") f.replaceTurn();
  f.service.approvedToolForTurn("member", "destination", () => true)(action, new AbortController().signal);
  expect(f.service.takeConnectorGrant("destination", "GMAIL_FETCH_MESSAGE", action.arguments)).toBeUndefined();
});
