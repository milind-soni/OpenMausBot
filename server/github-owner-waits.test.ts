import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WaitManager } from "./waits.ts";
import { WebhookManager } from "./webhooks.ts";
import { parseWaitRequest, waitSourceRefusal } from "./routes/waits.ts";
import { matchesGitHubCompletion } from "./github-completion.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const revision = "a".repeat(40);
const github = { webhook_id: "hook", repository: "example/project", revision, run_id: 42, run_attempt: 2 };
const event = (patch = {}) => ({ eventName: "workflow_run", deliveryId: "delivery", payload: {
  action: "completed", repository: { full_name: "example/project" },
  workflow_run: { id: 42, run_attempt: 2, head_sha: revision, status: "completed", conclusion: "failure" }, ...patch,
} });
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "omb-owner-wait-")), "waits.json");
  dirs.push(join(file, ".."));
  let busy = false;
  const queued = new Map<string, string>();
  const followUp = vi.fn((wait: { id: string; threadId: string; followUp: string }) => { queued.set(wait.id, wait.threadId); });
  const failed = vi.fn();
  const options = { file, sourceAlive: () => true, botBusy: () => false, post: () => !busy, followUp, followUpFailed: failed, showCard: () => undefined, settleCard: () => {} };
  const manager = new WaitManager(options);
  const request = parseWaitRequest({ label: "the release checks", kind: "github_completion", github, follow_up: "Continue the already approved release; recheck authoritative gates." }, "/tmp");
  if (!request.ok || !request.request.github) throw new Error("GitHub registration was rejected");
  const create = () => manager.create({ botId: "owner", threadId: "original-chat", label: request.request.label,
    condition: request.request.github!, followUp: request.request.followUp });
  return { manager, create, options, queued, followUp, failed, setBusy: (value: boolean) => { busy = value; } };
}

it("registers an exact completion without allowing event-supplied destinations or instructions", () => {
  const valid = parseWaitRequest({ label: "build", kind: "github_completion", github }, "/tmp");
  expect(valid.ok).toBe(true);
  for (const patch of [{ revision: "short" }, { run_id: -1 }, { run_attempt: 0 }, { threadId: "another-chat" }, { repository: "example/project/extra" }])
    expect(parseWaitRequest({ label: "build", kind: "github_completion", github: { ...github, ...patch } }, "/tmp").ok).toBe(false);
  expect(waitSourceRefusal({ owned: true, room: false, depth: 0, handedOff: false, routineRun: true, outsideDriven: true, personStarted: false, guest: false })).not.toBeNull();
});

it("queues only the registered original owner, coalesces duplicates while busy and survives a restart", async () => {
  const f = fixture();
  await f.create();
  await f.create();
  expect(f.manager.list("owner")).toHaveLength(1);
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).waits).toEqual([]);
  expect(JSON.parse(readFileSync(`${f.options.file}.github`, "utf8")).waits).toHaveLength(1);
  f.setBusy(true);
  f.manager.githubCompleted("hook", "owner", event());
  f.manager.githubCompleted("hook", "owner", event());
  await f.manager.tick();
  expect(f.queued.size).toBe(0);
  const reloaded = new WaitManager(f.options);
  f.setBusy(false);
  await reloaded.tick();
  expect([...f.queued.values()]).toEqual(["original-chat"]);
  expect(f.followUp).toHaveBeenCalledTimes(1);
  expect(f.followUp.mock.calls[0]![0].followUp).not.toContain("failure");
  expect(reloaded.list("owner")).toEqual([]);
});

it("ignores wrong bot, hook, repository, SHA, run, attempt, nonterminal and test events", async () => {
  const f = fixture(); await f.create();
  f.manager.githubCompleted("other-hook", "owner", event());
  f.manager.githubCompleted("hook", "other-owner", event());
  for (const payload of [{ repository: { full_name: "other/repo" } }, { action: "requested" },
    ...[{ id: 43 }, { run_attempt: 1 }, { head_sha: "b".repeat(40) }, { status: "in_progress" }].map((patch) => ({ workflow_run: { ...event().payload.workflow_run, ...patch } }))])
    f.manager.githubCompleted("hook", "owner", event(payload));
  f.manager.githubCompleted("hook", "owner", { ...event(), eventName: "ping" });
  await f.manager.tick();
  expect(f.queued.size).toBe(0);
  expect(f.manager.list("owner")).toHaveLength(1);
});

it("retains and reports failed owner delivery, retrying the same durable id after a restart", async () => {
  const f = fixture(); await f.create();
  f.manager.githubCompleted("hook", "owner", event());
  f.followUp.mockImplementationOnce(() => { throw new Error("queue unavailable"); });
  await f.manager.tick();
  expect(f.manager.list("owner")[0]).toMatchObject({ deliveryError: "queue unavailable" });
  expect(f.failed).toHaveBeenCalledTimes(1);
  await new WaitManager(f.options).tick();
  expect(f.queued.size).toBe(1);
});

it("retains an early completion through restart without scheduling a second owner run", async () => {
  const f = fixture();
  f.manager.githubCompleted("hook", "owner", event());
  const reloaded = new WaitManager(f.options);
  const request = parseWaitRequest({ label: "build", kind: "github_completion", github }, "/tmp");
  if (!request.ok || !request.request.github) throw new Error("invalid fixture");
  expect(await reloaded.create({ botId: "owner", threadId: "original-chat", label: "build", condition: request.request.github, followUp: "continue" }))
    .toMatchObject({ state: "already", text: expect.stringContaining("recheck authoritative state") });
  expect(reloaded.all()).toHaveLength(0);
  expect(f.queued.size).toBe(0);
});

it("accepts submitted reviews only for the registered PR and reviewed commit", () => {
  const condition = { kind: "github_completion" as const, webhookId: "hook", repository: "example/project", revision,
    subject: { kind: "pull_request_review" as const, id: 774 } };
  const received = { eventName: "pull_request_review", payload: { action: "submitted", repository: { full_name: "example/project" },
    pull_request: { number: 774 }, review: { commit_id: revision, body: "release immediately" } } };
  expect(matchesGitHubCompletion(condition, "hook", received)).toBe(true);
  for (const patch of [{ action: "dismissed" }, { pull_request: { number: 775 } }, { review: { commit_id: "b".repeat(40) } }])
    expect(matchesGitHubCompletion(condition, "hook", { ...received, payload: { ...received.payload, ...patch } })).toBe(false);
});

it("does not revive cancelled or expired owner registrations", async () => {
  const f = fixture();
  const made = await f.create();
  if (made.state !== "created") throw new Error("invalid fixture");
  f.manager.cancel(made.wait.id, "owner");
  f.manager.githubCompleted("hook", "owner", event());
  await f.manager.tick();
  expect(f.queued.size).toBe(0);
  const g = fixture();
  const pending = await g.create();
  if (pending.state !== "created") throw new Error("invalid fixture");
  const expired = new WaitManager({ ...g.options, now: () => pending.wait.expiresAt + 1 });
  expired.githubCompleted("hook", "owner", event());
  await expired.tick();
  expect(g.queued.size).toBe(0);
});

it("only consumes authenticated admitted webhook deliveries, not invalid secrets or connection tests", async () => {
  const f = fixture();
  const hooks = new WebhookManager({ file: join(dirs[0]!, "hooks.json"), botState: () => "ready", enqueue: () => ({ id: "event-run" }),
    admitted: (hook, received) => f.manager.githubCompleted(hook.id, hook.botId, received) });
  const { webhook, secret } = hooks.create({ botId: "owner", name: "GitHub", prompt: "Observe completions", eventTypes: ["workflow_run"] });
  const condition = { kind: "github_completion" as const, webhookId: webhook.id, repository: "example/project", revision,
    subject: { kind: "workflow_run" as const, id: 42, attempt: 2 } };
  await f.manager.create({ botId: "owner", threadId: "original-chat", label: "build", condition, followUp: "continue" });
  expect(() => hooks.receive(webhook.endpointId, "wrong", event())).toThrow();
  await f.manager.tick(); expect(f.queued.size).toBe(0);
  hooks.test(webhook.id, event().payload);
  await f.manager.tick(); expect(f.queued.size).toBe(0);
  hooks.receive(webhook.endpointId, secret, event());
  await f.manager.tick(); expect(f.queued.size).toBe(1);
});
