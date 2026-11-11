// @vitest-environment node
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { POST } from "../app/api/github/webhook/route";
import { integrationBridge } from "./integration-bridge";
import { syncPREvent } from "./github-prs";
import { syncGitHubEvent } from "./github-sync";
vi.mock("./github-workspace", () => ({ githubAppConfig: () => ({ webhookSecret: "fixture-webhook-secret" }) }));
vi.mock("./integration-bridge", () => ({ integrationBridge: vi.fn() }));
vi.mock("./github-prs", () => ({ syncPREvent: vi.fn() }));
vi.mock("./github-sync", () => ({ syncGitHubEvent: vi.fn() }));
const event = (kind: string, id = "delivery-1", updated = "2026-10-15T10:00:00Z", signed = true) => {
  const body = JSON.stringify({ repository: { full_name: "test/prs" }, issue: { number: 42 }, pull_request: { number: 1, updated_at: updated }, check_run: { head_sha: "a".repeat(40), pull_requests: [] } });
  return new Request("http://localhost/api/github/webhook", { method: "POST", body, headers: { "x-github-event": kind, "x-github-delivery": id, "x-hub-signature-256": signed ? `sha256=${createHmac("sha256", "fixture-webhook-secret").update(body).digest("hex")}` : "invalid" } });
};
beforeEach(() => {
  const done = new Set<string>();
  vi.mocked(integrationBridge).mockImplementation(async (_op, raw) => {
    const a = raw as { deliveryId: string; finishLease?: number };
    if (a.finishLease !== undefined) { done.add(a.deliveryId); return null; }
    return done.has(a.deliveryId) ? null : 100;
  });
});
afterEach(() => vi.resetAllMocks());
test("signed fixture is processed once; duplicate delivery is accepted without a second sync", async () => {
  expect((await POST(event("pull_request"))).status).toBe(200);
  expect(await (await POST(event("pull_request"))).json()).toMatchObject({ duplicate: true });
  expect(syncPREvent).toHaveBeenCalledTimes(1);
  expect(syncPREvent).toHaveBeenCalledWith("https://github.com/test/prs", [1], undefined);
});
test("old lifecycle payload is only a refetch signal; issue sync and head-only check events keep working", async () => {
  await POST(event("pull_request", "new-delivery"));
  await POST(event("pull_request", "old-delivery", "2026-10-14T10:00:00Z"));
  expect(vi.mocked(syncPREvent).mock.calls[0]).toEqual(vi.mocked(syncPREvent).mock.calls[1]);
  expect((await POST(event("issues", "issue-delivery"))).status).toBe(200);
  expect(syncGitHubEvent).toHaveBeenCalledWith("https://github.com/test/prs", 42);
  expect((await POST(event("check_run", "check-delivery"))).status).toBe(200);
  expect(syncPREvent).toHaveBeenLastCalledWith("https://github.com/test/prs", [], "a".repeat(40));
});
test("invalid signatures do no work; a sync failure is retriable and not marked done", async () => {
  expect((await POST(event("pull_request", "unsigned", undefined, false))).status).toBe(401);
  expect(integrationBridge).not.toHaveBeenCalled();
  vi.mocked(syncPREvent).mockRejectedValue(new Error("transient"));
  expect((await POST(event("pull_request", "failed"))).status).toBe(503);
  expect(vi.mocked(integrationBridge).mock.calls.some(([, args]) => (args as { finishLease?: number }).finishLease !== undefined)).toBe(false);
});

test("oversized unauthenticated bodies stop at the byte limit before bridge work", async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(600000)); }, cancel() { cancelled = true; } });
  const request = new Request("http://localhost/api/github/webhook", { method: "POST", body, duplex: "half" } as RequestInit);
  expect((await POST(request)).status).toBe(413);
  expect(cancelled).toBe(true); expect(integrationBridge).not.toHaveBeenCalled();
});
