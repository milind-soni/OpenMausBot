// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CloudAllocation, PrivateRun } from "./execution-store";
import type { ExecutionAccount, ExecutionHost } from "./execution-types";
import type * as CloudModule from "./execution-cloud";
import { defaultExecutionPolicy, routeExecution } from "./execution-policy";
import { VERSION as RUNNER_VERSION } from "../runner/security.mjs";

const state = vi.hoisted(() => ({
  runs: new Map<string, PrivateRun>(), allocations: new Map<string, CloudAllocation & { bootstrapVerified?: boolean }>(), hosts: [] as ExecutionHost[],
  accounts: [] as ExecutionAccount[],
  settings: new Map<string, unknown>(), locks: new Set<string>(),
}));
const remote = vi.hoisted(() => ({ create: vi.fn(), find: vi.fn(), get: vi.fn(), start: vi.fn(), stop: vi.fn(), exec: vi.fn(), usage: vi.fn(), extend: vi.fn(), authorize: vi.fn(), enroll: vi.fn(), ssh: vi.fn() }));
vi.mock("./execution-store", () => ({
  acquireExecutionLock: (name: string) => { if (state.locks.has(name)) return null; state.locks.add(name); return "lock-owner"; },
  releaseExecutionLock: (name: string) => state.locks.delete(name),
  atomicExecution: (fn: () => unknown) => fn(),
  cloudAllocations: (teamId?: string) => structuredClone([...state.allocations.values()].filter(row => !teamId || row.teamId === teamId)),
  saveCloudAllocation: (value: CloudAllocation) => state.allocations.set(value.id, structuredClone(value)),
  patchCloudAllocation: (id: string, patch: Partial<CloudAllocation>) => {
    const current = { ...state.allocations.get(id)!, ...structuredClone(patch), updatedAt: Date.now() };
    state.allocations.set(id, current); return structuredClone(current);
  },
  executionHosts: (teamId?: string) => structuredClone(state.hosts.filter(host => !teamId || host.teamId === teamId)),
  readExecutionHost: (id: string) => structuredClone(state.hosts.find(host => host.id === id)),
  executionAccounts: () => structuredClone(state.accounts),
  executionRuns: (teamId?: string) => structuredClone([...state.runs.values()].filter(record => !teamId || record.run.teamId === teamId)),
  executionUnstoppedHostRuns: (hostId: string) => structuredClone([...state.runs.values()].filter(record => record.run.hostId === hostId && !record.run.processStopped)),
  executionHostHasAttempt: (hostId: string) => [...state.runs.values()].some(record => record.run.hostId === hostId && record.run.attempt > 0),
  readExecutionRun: (id: string) => structuredClone(state.runs.get(id)),
  saveExecutionRun: (value: PrivateRun) => state.runs.set(value.run.id, structuredClone(value)),
  executionSetting: (_team: string, _kind: string, reference: string) => structuredClone(state.settings.get(reference)),
  setExecutionSetting: (_team: string, _kind: string, reference: string, value: unknown) => state.settings.set(reference, structuredClone(value)),
}));
vi.mock("./execution-common", () => ({
  enrolledHost: remote.enroll,
  revalidateExecutionPrincipal: remote.authorize,
  observedExecutionHost: (host: ExecutionHost) => ({ ...host, online: Date.now() - host.lastSeenAt <= 45_000 ? true : Date.now() - (host.presenceObservedAt || 0) <= 120_000 ? host.online : null }),
}));
vi.mock("./execution-cloud", async importOriginal => {
  const { CloudProviderError } = await importOriginal<typeof CloudModule>();
  return { CloudProviderError, createCloudMachine: remote.create, findCloudMachine: remote.find, getCloudMachine: remote.get, startCloudMachine: remote.start, stopCloudMachine: remote.stop, executeCloudCommand: remote.exec, cloudAccountUsage: remote.usage, extendCloudMachine: remote.extend };
});
vi.mock("./execution-cloud/boxd", () => ({ setBoxdHerdrSsh: remote.ssh }));
vi.mock("./githubConnection", () => ({ openIntegration: (sealed: string) => sealed === "sealed-provider" ? "private-provider-key" : "single-use-token", sealIntegration: () => "sealed-enrollment" }));
vi.mock("./integration-bridge", () => ({ originUrl: () => "https://origin.example" }));
import { CloudProviderError } from "./execution-cloud";
import { cloudExecutionStopProof, cloudHerdrConnectionPlan, cloudRexConnectionPlan, maintainCloudExecution } from "./execution-cloud-runtime";

const NOW = 1_800_000_000_000;
const BOXD_BILLING_REVISION = "00000000-0000-4000-8000-000000000001";
function observeBoxdCredits(balanceMicro = 50_000_000) {
  const settings = state.settings.get("boxd") as Record<string, unknown>;
  state.settings.set("boxd", {
    ...settings,
    nativeBilling: {
      source: "boxd-native-cli", version: "0.3.3", orgId: "org", revision: BOXD_BILLING_REVISION,
      observedAt: Date.now(), status: "available", billingMode: "credits", currency: "EUR", balanceMicro, accruingMicro: 0,
    },
  });
}
function queued(): PrivateRun {
  return {
    run: { id: "run", teamId: "team", projectId: "project", taskId: "task", requestedBy: "owner", title: "Issue", status: "queued", createdAt: NOW - 1000, updatedAt: NOW - 1000, attempt: 0, repositoryUrl: "https://github.com/example/private", baseBranch: "main", branch: "origin/run", environment: "development", verification: [], deployment: { status: "unknown" }, approvals: [], usage: { inputTokens: 0, outputTokens: 0, estimatedApiUsd: null }, processStopped: true },
    policy: { ...defaultExecutionPolicy, cloudEnabled: true, fallback: [{ accountId: "account", harness: "codex", model: "chosen-model" }] },
    prompt: "Implement issue", attempted: [], leaseHash: null, leaseExpiresAt: 0, sequence: 0, cancelRequested: false, logBytes: 0,
  };
}
function allocation(patch: Partial<CloudAllocation> = {}): CloudAllocation {
  return { id: "allocation", teamId: "team", ownerId: "owner", projectId: "project", provider: "boxd", status: "unknown", name: "origin-existing", idempotencyKey: "create-once", createdAt: NOW - 2000, updatedAt: NOW - 2000, lastActiveAt: NOW - 2000, ...patch };
}
function local(patch: Partial<ExecutionHost> = {}): ExecutionHost {
  return { id: "local", teamId: "team", ownerId: "owner", name: "Nix", kind: "nixos", platform: "linux", status: "offline", online: false, paused: false, revoked: false, lastSeenAt: NOW - 60_000, presenceObservedAt: NOW, version: "1.0.0", capabilities: ["codex"], accountIds: [], projectIds: ["project"], activeRunIds: [], capacity: 1, ...patch };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks();
  state.runs.clear(); state.allocations.clear(); state.settings.clear(); state.locks.clear(); state.hosts = [local()]; state.accounts = [];
  state.runs.set("run", queued());
  for (const provider of ["boxd", "boat"]) {
    state.settings.set(provider, {
      provider, enabled: true, sealedKey: "sealed-provider", keyConfigured: true, updatedAt: NOW, usage: { status: "unknown" },
      ...(provider === "boxd" ? { boxdBinding: { orgId: "org", revision: BOXD_BILLING_REVISION, autoTopUpOffConfirmedAt: NOW, confirmedBy: "owner" } } : {}),
    });
  }
  observeBoxdCredits();
  remote.authorize.mockResolvedValue({ admin: true, write: true, userId: "owner", teamId: "team", projectIds: ["project"] });
  remote.usage.mockResolvedValue({ status: "unknown" }); remote.find.mockResolvedValue(null);
  remote.create.mockResolvedValue({ provider: "boxd", id: "machine", state: "starting" });
  remote.get.mockResolvedValue({ provider: "boxd", id: "machine", state: "starting" });
  remote.start.mockResolvedValue({ provider: "boxd", id: "machine", state: "starting" });
  remote.stop.mockResolvedValue(undefined); remote.extend.mockResolvedValue(undefined); remote.ssh.mockResolvedValue(undefined);
  remote.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  remote.enroll.mockReturnValue({ hostId: "cloud-host", enrollmentToken: "single-use-token", expiresAt: NOW + 900_000 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test.each([
  { online: true, lastSeenAt: NOW, activeRunIds: ["other"] },
  { online: true, lastSeenAt: NOW, paused: true },
  { online: null, presenceObservedAt: undefined },
  { online: false, presenceObservedAt: NOW - 180_000 },
])("busy, paused or uncertain local presence never authorizes provisioning: %j", async patch => {
  state.hosts = [local(patch as Partial<ExecutionHost>)];
  await maintainCloudExecution("team");
  expect(remote.authorize).not.toHaveBeenCalled(); expect(remote.create).not.toHaveBeenCalled();
});
test("Apple and explicitly pinned local jobs never allocate cloud", async () => {
  const run = state.runs.get("run")!; run.policy.platform = "apple"; run.policy.machine = "local";
  await maintainCloudExecution("team"); expect(remote.create).not.toHaveBeenCalled();
});
test("authorization is checked before any provider usage or create", async () => {
  remote.authorize.mockRejectedValue(new Error("authorization revoked"));
  await maintainCloudExecution("team");
  expect(remote.usage).not.toHaveBeenCalled(); expect(remote.create).not.toHaveBeenCalled();
});
test("a create intent exists before the remote side effect and an ambiguous result is never replayed", async () => {
  remote.create.mockImplementationOnce(async () => {
    expect([...state.allocations.values()]).toHaveLength(1);
    expect([...state.allocations.values()][0].status).toBe("creating");
    throw new CloudProviderError("boxd", "create", "service", "unavailable", "unknown");
  });
  await maintainCloudExecution("team"); await maintainCloudExecution("team"); await maintainCloudExecution("team");
  expect(remote.create).toHaveBeenCalledTimes(1); expect(remote.find).toHaveBeenCalled();
  expect(state.allocations.size).toBe(1);
  expect([...state.allocations.values()][0]).toMatchObject({ status: "unknown", error: expect.stringContaining("automatic recreation is forbidden") });
});
test("an interrupted creating journal only reconciles the exact original identity", async () => {
  state.allocations.set("allocation", allocation({ status: "creating" }));
  remote.find.mockResolvedValue({ provider: "boxd", id: "adopted", state: "starting" });
  await maintainCloudExecution("team");
  expect(remote.find).toHaveBeenCalledWith({ provider: "boxd", apiKey: "private-provider-key", name: "origin-existing", idempotencyKey: "create-once" });
  expect(remote.create).not.toHaveBeenCalled(); expect(state.allocations.get("allocation")?.machineId).toBe("adopted");
});
test("provider selection is sticky, and unknown wallet never becomes zero", async () => {
  const run = state.runs.get("run")!; run.policy.cloudProvider = "boat";
  remote.usage.mockRejectedValue(new Error("outage"));
  await maintainCloudExecution("team");
  expect(remote.create).toHaveBeenCalledWith(expect.objectContaining({ provider: "boat" }));
  expect(state.settings.get("boat")).toMatchObject({ usage: { status: "unknown", error: expect.stringContaining("not confirmed exhaustion") } });
  expect([...state.allocations.values()]).toHaveLength(1);
});
test("known zero Boxd wallet blocks create without starting Boat or purchasing anything", async () => {
  observeBoxdCredits(0);
  await maintainCloudExecution("team");
  expect(remote.create).not.toHaveBeenCalled(); expect(state.allocations.size).toBe(0);
});
test("routing is checked again after awaited authorization", async () => {
  remote.authorize.mockImplementationOnce(async () => {
    state.hosts[0].online = true; state.hosts[0].lastSeenAt = NOW;
    return { admin: true, write: true, userId: "owner", teamId: "team", projectIds: ["project"] };
  });
  await maintainCloudExecution("team"); expect(remote.create).not.toHaveBeenCalled();
});
test("revoking the requester after initial authorization prevents a new billable machine", async () => {
  remote.authorize.mockImplementationOnce(async () => {
    remote.authorize.mockRejectedValue(new Error("Grant revoked"));
    return { admin: true, write: true, userId: "owner", teamId: "team", projectIds: ["project"] };
  });
  await maintainCloudExecution("team");
  expect(remote.create).not.toHaveBeenCalled();
  expect(state.allocations.size).toBe(0);
});
test("disabling the provider during state lookup prevents VM restart", async () => {
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host", status: "stopped" }));
  remote.get.mockResolvedValueOnce({ provider: "boxd", id: "existing", state: "stopped" }).mockImplementationOnce(async () => {
    state.settings.set("boxd", { provider: "boxd", enabled: false, sealedKey: "sealed-provider" });
    return { provider: "boxd", id: "existing", state: "stopped" };
  });
  await maintainCloudExecution("team");
  expect(remote.start).not.toHaveBeenCalled();
  expect(remote.exec).not.toHaveBeenCalled();
});
test("a disabled provider no longer retains paid-idle compute for queued demand", async () => {
  state.settings.set("boxd", { provider: "boxd", enabled: false, sealedKey: "sealed-provider" });
  state.allocations.set("allocation", allocation({ machineId: "existing", status: "ready", lastActiveAt: NOW - 120000 }));
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  expect(remote.stop).toHaveBeenCalledTimes(1);
  expect(state.allocations.get("allocation")?.status).toBe("stopping");
});
test("asynchronous failure never overwrites a newly claimed run", async () => {
  remote.create.mockImplementationOnce(async () => {
    const run = state.runs.get("run")!; run.run.status = "running"; run.run.attempt = 1; run.run.processStopped = false; run.run.reason = "worker status";
    throw new Error("provider payload contains private-provider-key");
  });
  await maintainCloudExecution("team");
  expect(state.runs.get("run")?.run).toMatchObject({ status: "running", attempt: 1, reason: "worker status" });
  expect(JSON.stringify([...state.allocations.values()])).not.toContain("private-provider-key");
});
test("resuming a preserved VM starts the same machine without create or enrollment", async () => {
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host", status: "stopped" }));
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "stopped" });
  await maintainCloudExecution("team");
  expect(remote.start).toHaveBeenCalledWith({ provider: "boxd", id: "existing", apiKey: "private-provider-key" });
  expect(remote.enroll).not.toHaveBeenCalled(); expect(remote.create).not.toHaveBeenCalled();
});
test("uncertain execution prevents reuse even when provider reports a cold stop", async () => {
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host" }));
  const old = queued(); old.run.id = "old"; old.run.hostId = "cloud-host"; old.run.status = "blocked"; old.run.processStopped = false;
  state.runs.set("old", old);
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "stopped" });
  await maintainCloudExecution("team");
  expect(remote.start).not.toHaveBeenCalled(); expect(old.run.processStopped).toBe(false);
  expect(state.allocations.get("allocation")).toMatchObject({ stopProof: { kind: "provider-cold-stop", environmentClean: false } });
});
test("a provider observation cannot overwrite a concurrently admitted attempt", async () => {
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host", status: "ready" }));
  remote.get.mockImplementationOnce(async () => {
    state.allocations.set("allocation", { ...state.allocations.get("allocation")!, runDeadline: { runId: "new-run", attempt: 2, deadline: NOW + 900000 } });
    const active = queued(); active.run.id = "new-run"; active.run.hostId = "cloud-host"; active.run.status = "preparing"; active.run.processStopped = false;
    state.runs.set("new-run", active);
    return { provider: "boxd", id: "existing", state: "stopped" };
  });
  await maintainCloudExecution("team");
  expect(cloudExecutionStopProof("team", "cloud-host")).toMatchObject({ runId: "new-run", attempt: 2, environmentClean: false });
  expect(remote.start).not.toHaveBeenCalled();
});
test("Boat extends only the current lease, using one immutable attempt deadline", async () => {
  state.allocations.set("allocation", allocation({ provider: "boat", machineId: "existing", hostId: "cloud-host", status: "ready" }));
  const run = state.runs.get("run")!; run.policy.cloudProvider = "boat"; run.policy.timeoutSeconds = 600; run.run.hostId = "cloud-host"; run.run.processStopped = false; run.run.status = "running"; run.run.attempt = 1; run.leaseHash = "lease"; run.leaseExpiresAt = NOW + 60_000;
  remote.get.mockResolvedValue({ provider: "boat", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  expect(remote.extend).toHaveBeenCalledWith(expect.objectContaining({ provider: "boat", ttlSeconds: 899 }));
  vi.setSystemTime(NOW + 120_000); run.leaseExpiresAt = NOW + 180_000;
  await maintainCloudExecution("team");
  expect(remote.extend).toHaveBeenLastCalledWith(expect.objectContaining({ ttlSeconds: 779 }));
  vi.setSystemTime(NOW + 240_000);
  await maintainCloudExecution("team"); expect(remote.extend).toHaveBeenCalledTimes(2);
});
test("an accepted forced stop is not process-stop proof or environment-clean proof", async () => {
  state.allocations.set("allocation", allocation({ provider: "boat", machineId: "existing", hostId: "cloud-host", status: "ready" }));
  const run = state.runs.get("run")!; run.run.createdAt = NOW - 10_000_000; run.run.hostId = "cloud-host"; run.run.status = "blocked"; run.run.processStopped = false;
  remote.get.mockResolvedValue({ provider: "boat", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  expect(remote.stop).toHaveBeenCalledTimes(1); expect(state.runs.get("run")?.run.processStopped).toBe(false);
  expect(state.allocations.get("allocation")).not.toHaveProperty("stopProof");
});

test.each([false, true])("Boat archival requires independently verified guest shutdown: %s", async guestStopped => {
  const run = state.runs.get("run")!; run.run.hostId = "cloud-host"; run.run.status = "blocked"; run.run.processStopped = false; run.run.attempt = 1;
  state.allocations.set("allocation", allocation({ provider: "boat", machineId: "existing", hostId: "cloud-host", runnerStoppedAt: guestStopped ? NOW - 1000 : undefined, runDeadline: { runId: "run", attempt: 1, deadline: NOW + 30000 } }));
  remote.get.mockResolvedValue({ provider: "boat", id: "existing", state: "stopped" });
  await maintainCloudExecution("team");
  if (guestStopped) expect(cloudExecutionStopProof("team", "cloud-host")).toMatchObject({ kind: "guest-supervisor-stop", observedAt: NOW - 1000, runId: "run", attempt: 1, environmentClean: true });
  else expect(cloudExecutionStopProof("team", "cloud-host")).toBeUndefined();
  expect(remote.start).not.toHaveBeenCalled();
});

test("Boat archival cannot reuse a guest shutdown receipt invalidated by a concurrent claim", async () => {
  const run = state.runs.get("run")!; run.run.hostId = "cloud-host"; run.run.status = "blocked"; run.run.processStopped = false;
  state.allocations.set("allocation", allocation({ provider: "boat", machineId: "existing", hostId: "cloud-host", runnerStoppedAt: NOW - 1000, runDeadline: { runId: "old", attempt: 1, deadline: NOW + 30000 } }));
  remote.get.mockImplementationOnce(async () => {
    state.allocations.set("allocation", { ...state.allocations.get("allocation")!, runnerStoppedAt: undefined, runDeadline: { runId: "run", attempt: 2, deadline: NOW + 900000 } });
    return { provider: "boat", id: "existing", state: "stopped" };
  });
  await maintainCloudExecution("team");
  expect(cloudExecutionStopProof("team", "cloud-host")).toBeUndefined();
  expect(remote.start).not.toHaveBeenCalled();
});

test.each([false, true])("pinned cloud worker never permits a replacement, with mismatched journal=%s", async journal => {
  state.hosts.push(local({ id: "pinned", kind: "boxd", name: "Pinned", online: false }));
  state.runs.get("run")!.policy.machine = "pinned";
  if (journal) state.allocations.set("allocation", allocation({ hostId: "different", machineId: "existing" }));
  await maintainCloudExecution("team");
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
  expect(state.runs.get("run")?.run.reason).toContain("Pinned cloud worker");
});
test("pinned cloud resumes only its bound preserved machine", async () => {
  state.hosts.push(local({ id: "pinned", kind: "boxd", name: "Pinned", online: false }));
  state.runs.get("run")!.policy.machine = "pinned";
  state.allocations.set("allocation", allocation({ hostId: "pinned", machineId: "only-this-vm", status: "stopped" }));
  remote.get.mockResolvedValue({ provider: "boxd", id: "only-this-vm", state: "stopped" });
  await maintainCloudExecution("team");
  expect(remote.start).toHaveBeenCalledWith(expect.objectContaining({ id: "only-this-vm" }));
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.enroll).not.toHaveBeenCalled();
  expect(cloudExecutionStopProof("team", "pinned")).toBeUndefined();
});
test("idle stop waits for fresh worker cleanup acknowledgement and later provider cold-stop proof", async () => {
  state.runs.clear();
  const row = { ...allocation({ hostId: "cloud-host", machineId: "existing", status: "ready", lastActiveAt: NOW - 120_000 }), bootstrapVerified: true };
  state.allocations.set(row.id, row);
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  let stopped = false;
  remote.exec.mockImplementation(async ({ command }: { command: string }) => ({
    exitCode: 0, stderr: "", stdout: command.includes("JSON.stringify({stopped:") ? JSON.stringify({ stopped, activeRunId: null, updatedAt: NOW }) : command.includes("printf active") ? stopped ? "inactive" : "active" : "",
  }));
  await maintainCloudExecution("team");
  expect(state.allocations.get(row.id)?.status).toBe("stopping");
  expect(remote.stop).not.toHaveBeenCalled(); expect(cloudExecutionStopProof("team", "cloud-host")).toBeUndefined();
  stopped = true; await maintainCloudExecution("team");
  expect(remote.stop).toHaveBeenCalledTimes(1); expect(cloudExecutionStopProof("team", "cloud-host")).toBeUndefined();
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "stopped" });
  await maintainCloudExecution("team");
  expect(cloudExecutionStopProof("team", "cloud-host")).toMatchObject({ kind: "provider-cold-stop", machineId: "existing", environmentClean: true });
});
test("orphaned ambiguous creation is reconciled even after its requesting run is cancelled", async () => {
  state.runs.clear();
  state.allocations.set("allocation", allocation({ createdAt: NOW - 180_000, lastActiveAt: NOW - 180_000 }));
  remote.find.mockResolvedValue({ provider: "boxd", id: "orphan", state: "running" });
  remote.get.mockResolvedValue({ provider: "boxd", id: "orphan", state: "running" });
  await maintainCloudExecution("team");
  expect(remote.create).not.toHaveBeenCalled();
  expect(remote.stop).toHaveBeenCalledWith(expect.objectContaining({ id: "orphan" }));
  expect(state.allocations.get("allocation")?.machineId).toBe("orphan");
});

function bootstrapFixture() {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const files = ["cli.mjs", "security.mjs"].map(path => ({ path, content: "// fixture\n", sha256: digest("// fixture\n") }));
  const sha256 = digest(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))));
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ version: RUNNER_VERSION, sha256, files })));
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  remote.exec.mockImplementation(async ({ command }: { command: string }) => ({ exitCode: 0, stderr: "", stdout: command.includes("printf active") ? "inactive" : command.includes("Invalid config") ? "absent" : command.includes("herdr-core --version") ? "hc 0.1.18" : "" }));
}
function selectableCloud() {
  const host = local({ id: "cloud-host", kind: "boxd", name: "Private", online: true, status: "online", lastSeenAt: Date.now(), accountIds: ["account"] });
  state.hosts.push(host);
  state.accounts.push({
    id: "account", identityHash: "native-account", provider: "openai", label: "Native", authKind: "subscription", authenticated: true, harnesses: ["codex"],
    quota: { status: "unknown", observedAt: Date.now(), windows: [] }, ownerId: "owner", hostIds: [host.id], updatedAt: Date.now(),
    bindings: { [host.id]: [{ accountId: "native-account", authKind: "subscription", authenticated: true, harnesses: ["codex"], models: [{ id: "chosen-model" }] }] },
  });
  return host;
}

test.each(["starting", "bootstrapping", "unknown"] as const)("a route-selectable host reconciles its %s journal to ready without a second machine", async status => {
  bootstrapFixture();
  const host = selectableCloud(), record = state.runs.get("run")!;
  state.allocations.set("allocation", { ...allocation({ hostId: host.id, machineId: "existing", status }), bootstrapVerified: true });
  remote.exec.mockImplementation(async ({ command }: { command: string }) => ({ exitCode: 0, stderr: "", stdout: command.includes("printf active") ? "active" : command.includes("herdr-core --version") ? "hc 0.1.18" : "" }));
  expect(routeExecution({ policy: record.policy, projectId: "project", ownerId: "owner", hosts: state.hosts, accounts: state.accounts })).toMatchObject({ host: { id: host.id }, needsCloud: false });
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")).toMatchObject({ status: "ready", machineId: "existing", hostId: host.id });
  expect(state.runs.get("run")?.run.status).toBe("queued");
  expect(remote.exec.mock.calls.some(([input]) => input.command.includes(" resume --config") || input.command.includes("systemctl start origin-cloud-runner.service"))).toBe(false);
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled(); expect(remote.enroll).not.toHaveBeenCalled();
});

test("an uncertain VM start recovers the same now-authenticated machine", async () => {
  bootstrapFixture();
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host", status: "stopped" }));
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "stopped" });
  remote.start.mockImplementationOnce(async () => {
    selectableCloud();
    throw new CloudProviderError("boxd", "start", "service", "response lost", "unknown");
  });
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")?.status).toBe("unknown");
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  remote.exec.mockImplementation(async ({ command }: { command: string }) => ({ exitCode: 0, stderr: "", stdout: command.includes("printf active") ? "active" : command.includes("herdr-core --version") ? "hc 0.1.18" : "" }));
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")).toMatchObject({ status: "ready", machineId: "existing" });
  expect(remote.start).toHaveBeenCalledTimes(1); expect(remote.create).not.toHaveBeenCalled(); expect(remote.enroll).not.toHaveBeenCalled();
});

test("lost service-start response recovers authenticated enrollment without re-installing or resuming it", async () => {
  bootstrapFixture();
  state.allocations.set("allocation", allocation({ machineId: "existing", status: "starting" }));
  let running = false;
  remote.exec.mockImplementation(async ({ command }: { command: string }) => {
    if (command.includes("systemctl start origin-cloud-runner.service")) {
      running = true; selectableCloud();
      throw new CloudProviderError("boxd", "exec", "service", "response lost", "unknown");
    }
    return { exitCode: 0, stderr: "", stdout: command.includes("printf active") ? running ? "active" : "inactive" : command.includes("Invalid config") ? "absent" : command.includes("herdr-core --version") ? "hc 0.1.18" : "" };
  });
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")).toMatchObject({ status: "unknown", hostId: "cloud-host", bootstrapVerified: true });
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")).toMatchObject({ status: "ready", enrollment: undefined, stopProof: undefined });
  expect(state.runs.get("run")?.run.status).toBe("queued");
  expect(remote.enroll).toHaveBeenCalledTimes(1); expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
});

test.each(["local-online", "provider-disabled", "host-revoked", "host-paused", "cancelled", "uncertain-run", "requester-revoked"] as const)("recovery rechecks %s after the active-service response before publishing readiness", async change => {
  bootstrapFixture();
  const host = selectableCloud();
  state.allocations.set("allocation", { ...allocation({ machineId: "existing", hostId: host.id, status: "unknown", lastActiveAt: NOW - 120_000 }), bootstrapVerified: true });
  remote.exec.mockImplementation(async ({ command }: { command: string }) => {
    if (command.includes("printf active")) {
      if (change === "local-online") { state.hosts[0].online = true; state.hosts[0].lastSeenAt = NOW; }
      if (change === "provider-disabled") state.settings.set("boxd", { provider: "boxd", enabled: false, sealedKey: "sealed-provider" });
      if (change === "host-revoked") host.revoked = true;
      if (change === "host-paused") host.paused = true;
      if (change === "cancelled") { state.runs.get("run")!.run.status = "cancelled"; state.runs.get("run")!.cancelRequested = true; }
      if (change === "uncertain-run") { const old = queued(); old.run.id = "old"; old.run.hostId = host.id; old.run.status = "blocked"; old.run.processStopped = false; state.runs.set("old", old); }
      if (change === "requester-revoked") remote.authorize.mockRejectedValue(new Error("revoked"));
      return { exitCode: 0, stdout: "active", stderr: "" };
    }
    return { exitCode: 0, stdout: command.includes("herdr-core --version") ? "hc 0.1.18" : "", stderr: "" };
  });
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")?.status).toBe("bootstrapping");
  expect(remote.exec.mock.calls.some(([input]) => input.command.includes(" resume --config") || input.command.includes("systemctl start origin-cloud-runner.service"))).toBe(false);
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled(); expect(remote.enroll).not.toHaveBeenCalled();
  if (change !== "uncertain-run") {
    remote.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await maintainCloudExecution("team");
    expect(state.allocations.get("allocation")?.status).toBe("stopping");
    vi.setSystemTime(NOW + 300_001);
    await maintainCloudExecution("team");
    expect(remote.stop).toHaveBeenCalledWith(expect.objectContaining({ id: "existing" }));
    expect(remote.start).not.toHaveBeenCalled(); expect(remote.enroll).not.toHaveBeenCalled();
  }
});

test.each(["local-online", "provider-disabled", "cancelled"] as const)("uncertain recovery does not start its stopped VM when %s changes during provider lookup", async change => {
  selectableCloud();
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host", status: "unknown" }));
  remote.get.mockResolvedValueOnce({ provider: "boxd", id: "existing", state: "running" }).mockImplementationOnce(async () => {
    if (change === "local-online") { state.hosts[0].online = true; state.hosts[0].lastSeenAt = NOW; }
    if (change === "provider-disabled") state.settings.set("boxd", { provider: "boxd", enabled: false, sealedKey: "sealed-provider" });
    if (change === "cancelled") { state.runs.get("run")!.run.status = "cancelled"; state.runs.get("run")!.cancelRequested = true; }
    return { provider: "boxd", id: "existing", state: "stopped" };
  });
  await maintainCloudExecution("team");
  expect(remote.get).toHaveBeenCalledTimes(2);
  expect(remote.start).not.toHaveBeenCalled(); expect(remote.exec).not.toHaveBeenCalled(); expect(remote.create).not.toHaveBeenCalled();
  expect(state.allocations.get("allocation")?.status).not.toBe("ready");
});

test.each(["native-login", "first-heartbeat"] as const)("zero wallet cannot preserve a paid-idle ready VM awaiting %s", async waitingFor => {
  const host = waitingFor === "native-login" ? local({ id: "cloud-host", kind: "boxd", name: "Private", online: true, status: "online", lastSeenAt: NOW }) : undefined;
  if (host) state.hosts.push(host);
  state.allocations.set("allocation", { ...allocation({ machineId: "existing", hostId: "cloud-host", status: "ready", lastActiveAt: NOW - 300_001 }), bootstrapVerified: true });
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  observeBoxdCredits(0);
  remote.exec.mockImplementation(async ({ command }: { command: string }) => ({
    exitCode: 0, stderr: "", stdout: command.includes("JSON.stringify({stopped:") ? JSON.stringify({ stopped: true, activeRunId: null, updatedAt: Date.now() }) : command.includes("printf active") ? "inactive" : "",
  }));
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")?.status).toBe("stopping");
  expect(remote.stop).toHaveBeenCalledWith(expect.objectContaining({ id: "existing" }));
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "stopped" });
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")?.status).toBe("stopped");
  expect(remote.start).not.toHaveBeenCalled();
});

test("loss of administrator authorization cannot retain paid-idle recovery demand", async () => {
  selectableCloud();
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host", status: "unknown", lastActiveAt: NOW - 120_000 }));
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  remote.authorize.mockResolvedValue({ admin: false, write: true, userId: "owner", teamId: "team", projectIds: ["project"] });
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")?.status).toBe("stopping");
  expect(remote.stop).toHaveBeenCalledTimes(1);
  expect(remote.start).not.toHaveBeenCalled(); expect(remote.exec).not.toHaveBeenCalled(); expect(remote.create).not.toHaveBeenCalled();
});

test.each([
  { online: true, lastSeenAt: NOW, activeRunIds: ["other"] },
  { online: true, lastSeenAt: NOW, paused: true },
  { online: null, presenceObservedAt: undefined },
  { online: false, presenceObservedAt: NOW - 180_000 },
])("a selectable cloud host cannot recover or retain idle compute when local availability is %j", async patch => {
  selectableCloud();
  Object.assign(state.hosts[0], patch);
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host", status: "unknown", lastActiveAt: NOW - 120_000 }));
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")?.status).toBe("stopping");
  expect(remote.stop).toHaveBeenCalledWith(expect.objectContaining({ id: "existing" }));
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled(); expect(remote.exec).not.toHaveBeenCalled();
});

test("zero-wallet admissions do not extend the idle stop deadline", async () => {
  state.allocations.set("allocation", { ...allocation({ machineId: "existing", hostId: "cloud-host", status: "ready", lastActiveAt: NOW }), bootstrapVerified: true });
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  observeBoxdCredits(0);
  remote.exec.mockImplementation(async ({ command }: { command: string }) => ({
    exitCode: 0, stderr: "", stdout: command.includes("JSON.stringify({stopped:") ? JSON.stringify({ stopped: true, activeRunId: null, updatedAt: Date.now() }) : command.includes("printf active") ? "inactive" : "",
  }));
  await maintainCloudExecution("team");
  vi.setSystemTime(NOW + 59_999);
  state.hosts[0].presenceObservedAt = Date.now();
  observeBoxdCredits(0);
  await maintainCloudExecution("team");
  expect(remote.stop).not.toHaveBeenCalled();
  expect(state.allocations.get("allocation")?.lastActiveAt).toBe(NOW);
  vi.setSystemTime(NOW + 60_000);
  await maintainCloudExecution("team");
  expect(state.allocations.get("allocation")?.status).toBe("stopping");
  expect(remote.stop).toHaveBeenCalledTimes(1);
  expect(remote.start).not.toHaveBeenCalled();
});
test("new enrollment is journaled once and only its scoped token crosses in environment/stdin", async () => {
  bootstrapFixture();
  state.allocations.set("allocation", allocation({ machineId: "existing", status: "starting" }));
  await maintainCloudExecution("team");
  expect(remote.enroll).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", teamId: "team" }), expect.objectContaining({ kind: "boxd", projectIds: ["project"] }), "allocation");
  const enrollment = remote.exec.mock.calls.map(([input]) => input).find(input => input.env?.ORIGIN_ENROLLMENT_TOKEN);
  expect(enrollment.env).toEqual({ ORIGIN_ENROLLMENT_TOKEN: "single-use-token" });
  expect(enrollment.command).toContain('printf');
  expect(enrollment.command).not.toContain("single-use-token"); expect(enrollment.command).not.toContain("private-provider-key");
  expect(state.allocations.get("allocation")).toMatchObject({ status: "ready", hostId: "cloud-host" });
  expect(JSON.stringify(state.allocations.get("allocation"))).not.toContain("single-use-token");
});
test.each(["expired", "lost"])("a %s enrollment requires deliberate recovery, never another host", async stateName => {
  bootstrapFixture();
  const row = { ...allocation({ machineId: "existing", hostId: "cloud-host", status: "bootstrapping" }), ...(stateName === "expired" ? { enrollment: { sealedToken: "sealed-enrollment", expiresAt: NOW - 1 } } : {}) };
  state.allocations.set("allocation", row);
  await maintainCloudExecution("team"); await maintainCloudExecution("team");
  expect(remote.enroll).not.toHaveBeenCalled();
  expect(state.allocations.get("allocation")).toMatchObject({ recoveryRequired: true });
  expect(state.runs.get("run")?.run).toMatchObject({ status: "blocked", processStopped: true });
});
test("invalid runner bundle is rejected before any VM bootstrap command", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ version: RUNNER_VERSION, sha256: "forged", files: [{ path: "../config.json", content: "bad", sha256: "forged" }] })));
  state.allocations.set("allocation", allocation({ machineId: "existing", status: "starting" }));
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  expect(remote.exec).not.toHaveBeenCalled(); expect(remote.enroll).not.toHaveBeenCalled();
  expect(state.allocations.get("allocation")).toMatchObject({ status: "failed", recoveryRequired: true });
});

test("simultaneous controller ticks share the durable allocation admission lock", async () => {
  await Promise.all([maintainCloudExecution("team"), maintainCloudExecution("team"), maintainCloudExecution("team")]);
  expect(remote.create).toHaveBeenCalledTimes(1);
  expect(state.allocations.size).toBe(1);
  expect(state.locks.size).toBe(0);
});
test("attemptStartedAt, not mutable run activity, bounds Boat lifetime", async () => {
  state.allocations.set("allocation", allocation({ provider: "boat", machineId: "existing", hostId: "cloud-host", status: "ready" }));
  const run = state.runs.get("run")!;
  run.policy.timeoutSeconds = 600; run.run.hostId = "cloud-host"; run.run.processStopped = false; run.run.status = "running"; run.run.updatedAt = NOW;
  run.attemptStartedAt = NOW - 120_000; run.leaseHash = "lease"; run.leaseExpiresAt = NOW + 60_000;
  remote.get.mockResolvedValue({ provider: "boat", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  expect(remote.extend).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 780 }));
});

test("an enrolled but unjournaled cloud host is not silently duplicated", async () => {
  state.hosts.push(local({ id: "unjournaled", kind: "boxd", name: "Existing cloud" }));
  await maintainCloudExecution("team");
  expect(remote.create).not.toHaveBeenCalled();
  expect(state.runs.get("run")?.run).toMatchObject({ status: "blocked", reason: expect.stringContaining("no allocation journal") });
});

test("an unresponsive idle service cannot consume credits indefinitely or claim cleanup", async () => {
  state.runs.clear();
  state.allocations.set("allocation", { ...allocation({ machineId: "existing", hostId: "cloud-host", status: "ready", lastActiveAt: NOW - 120_000 }), bootstrapVerified: true });
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  remote.exec.mockRejectedValue(new Error("service unavailable"));
  await maintainCloudExecution("team"); expect(remote.stop).not.toHaveBeenCalled();
  vi.setSystemTime(NOW + 300_001);
  await maintainCloudExecution("team"); expect(remote.stop).toHaveBeenCalledTimes(1);
  expect(cloudExecutionStopProof("team", "cloud-host")).toBeUndefined();
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "stopped" });
  await maintainCloudExecution("team");
  expect(cloudExecutionStopProof("team", "cloud-host")).toMatchObject({ environmentClean: false });
});

test("workspace controller neither provisions nor maintains another workspace", async () => {
  const other = queued(); other.run.id = "foreign-run"; other.run.teamId = "foreign-team";
  state.runs.clear(); state.runs.set(other.run.id, other);
  state.allocations.set("foreign-allocation", allocation({ id: "foreign-allocation", teamId: "foreign-team", machineId: "foreign-vm", status: "ready", lastActiveAt: NOW - 180_000 }));
  await maintainCloudExecution("team");
  expect(remote.authorize).not.toHaveBeenCalled(); expect(remote.create).not.toHaveBeenCalled();
  expect(remote.get).not.toHaveBeenCalled(); expect(remote.stop).not.toHaveBeenCalled();
  expect(state.runs.get("foreign-run")).toEqual(other);
});
test("missing workspace fails closed instead of using the store's unscoped overload", async () => {
  await expect(maintainCloudExecution("")).rejects.toThrow("workspace");
  expect(remote.get).not.toHaveBeenCalled(); expect(remote.create).not.toHaveBeenCalled();
});

test("stop proof reader cannot expose another workspace's private machine receipt", () => {
  const row = { ...allocation({ teamId: "foreign-team", machineId: "foreign-vm", hostId: "foreign-host", status: "stopped" }), stopProof: { kind: "provider-cold-stop" as const, machineId: "foreign-vm", observedAt: NOW, environmentClean: true } };
  state.allocations.set(row.id, row);
  expect(cloudExecutionStopProof("team", "foreign-host")).toBeUndefined();
  expect(cloudExecutionStopProof("foreign-team", "foreign-host")).toMatchObject({ machineId: "foreign-vm" });
});

test("requested maintenance protects an idle cloud worker for at most thirty minutes", async () => {
  state.runs.clear();
  state.allocations.set("allocation", { ...allocation({ machineId: "existing", hostId: "cloud-host", status: "ready", lastActiveAt: NOW - 180_000 }), bootstrapVerified: true });
  state.settings.set("cloud-host", { id: "update", op: "applyUpdates", requestedAt: NOW });
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  vi.setSystemTime(NOW + 30 * 60_000 - 1);
  await maintainCloudExecution("team");
  expect(remote.exec).not.toHaveBeenCalled(); expect(remote.stop).not.toHaveBeenCalled();
  expect(state.allocations.get("allocation")?.status).toBe("ready");
  vi.setSystemTime(NOW + 30 * 60_000);
  remote.exec.mockImplementation(async ({ command }: { command: string }) => ({
    exitCode: 0, stderr: "", stdout: command.includes("JSON.stringify({stopped:") ? JSON.stringify({ stopped: true, activeRunId: null, updatedAt: Date.now() }) : command.includes("printf active") ? "inactive" : "",
  }));
  await maintainCloudExecution("team");
  expect(remote.exec).toHaveBeenCalled(); expect(remote.stop).toHaveBeenCalledTimes(1);
  expect(state.allocations.get("allocation")?.status).toBe("stopping");
});
test("pending maintenance fences provisioning but never extends Boat without a leased run", async () => {
  state.runs.get("run")!.policy.cloudProvider = "boat";
  state.allocations.set("allocation", allocation({ provider: "boat", machineId: "existing", hostId: "cloud-host", status: "ready", lastActiveAt: NOW - 180_000 }));
  state.settings.set("cloud-host", { id: "update", op: "applyUpdates", requestedAt: NOW });
  remote.get.mockResolvedValue({ provider: "boat", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
  expect(remote.exec).not.toHaveBeenCalled(); expect(remote.extend).not.toHaveBeenCalled();
  expect(state.runs.get("run")?.run.reason).toContain("performing requested maintenance");
  vi.setSystemTime(NOW + 30 * 60_000);
  state.hosts[0].presenceObservedAt = Date.now();
  await maintainCloudExecution("team");
  expect(remote.stop).toHaveBeenCalled();
  expect(state.runs.get("run")?.run).toMatchObject({ status: "blocked", reason: expect.stringContaining("thirty-minute") });
});
test.each([undefined, NOW + 1, NaN])("invalid maintenance timestamp %s never creates an unbounded idle allowance", async requestedAt => {
  state.runs.clear();
  state.allocations.set("allocation", allocation({ machineId: "existing", hostId: "cloud-host", status: "ready" }));
  state.settings.set("cloud-host", { id: "update", op: "applyUpdates", requestedAt });
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", state: "running" });
  await maintainCloudExecution("team");
  expect(remote.stop).toHaveBeenCalledTimes(1);
});

function herdrAllocation(provider: "boxd" | "boat" = "boxd") {
  const host = selectableCloud(); host.kind = provider;
  const row = { ...allocation({ provider, machineId: "existing", hostId: host.id, status: "ready", lastActiveAt: NOW }), herdr: { version: "0.1.18", session: "origin-cloud", user: "origin-runner" as const, verifiedAt: NOW } };
  state.allocations.set(row.id, row);
  remote.get.mockResolvedValue({ provider, id: "existing", name: "origin-private", state: "running" });
  return row;
}
test.each(["boxd", "boat"] as const)("%s connection grants bind both desktops to one nonroot core without extending billing", async provider => {
  const row = herdrAllocation(provider);
  const nix = await cloudHerdrConnectionPlan(row.id, provider, "nixos", remote.authorize);
  const mac = await cloudHerdrConnectionPlan(row.id, provider, "macos", remote.authorize);
  expect(nix.machineId).toBe(mac.machineId); expect(nix.core).toEqual(mac.core);
  expect(nix.name).not.toBe(mac.name);
  expect(nix.expiresAt).toBe(NOW + 60_000);
  expect(nix.remotePrefix).toContain("sudo -n -u origin-runner env -i");
  expect(JSON.stringify(nix)).not.toContain("private-provider-key");
  expect(state.allocations.get(row.id)?.lastActiveAt).toBe(NOW);
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled(); expect(remote.extend).not.toHaveBeenCalled(); expect(remote.exec).not.toHaveBeenCalled();
  expect(remote.ssh).toHaveBeenCalledTimes(provider === "boxd" ? 2 : 0);
});
test.each(["stopped", "unknown", "stopping", "failed"] as const)("discovery of %s allocations cannot grant or touch a transport", async status => {
  const row = herdrAllocation(); row.status = status; state.allocations.set(row.id, row);
  await expect(cloudHerdrConnectionPlan(row.id, "boxd", "nixos", remote.authorize)).rejects.toThrow("verified, running");
  expect(remote.get).not.toHaveBeenCalled(); expect(remote.ssh).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
});
test("provider uncertainty, changed selection and revoked authorization never enable desktop SSH", async () => {
  const row = herdrAllocation();
  await expect(cloudHerdrConnectionPlan(row.id, "boat", "nixos", remote.authorize)).rejects.toThrow("not authorized");
  remote.get.mockResolvedValue({ provider: "boxd", id: "existing", name: "origin-private", state: "unknown" });
  await expect(cloudHerdrConnectionPlan(row.id, "boxd", "nixos", remote.authorize)).rejects.toThrow("not confirmed");
  remote.get.mockImplementation(async () => { state.hosts.find(host => host.id === row.hostId)!.revoked = true; return { provider: "boxd", id: "existing", name: "origin-private", state: "running" }; });
  await expect(cloudHerdrConnectionPlan(row.id, "boxd", "nixos", remote.authorize)).rejects.toThrow("verified, running");
  expect(remote.ssh).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
});
test("idle stop fences grants, expires owned SSH and never leaves a reconnect keeping Boxd alive", async () => {
  const row = herdrAllocation();
  await cloudHerdrConnectionPlan(row.id, "boxd", "nixos", remote.authorize);
  state.runs.clear(); state.allocations.get(row.id)!.lastActiveAt = NOW - 120_000;
  await maintainCloudExecution("team");
  expect(state.allocations.get(row.id)?.status).toBe("stopping");
  expect(remote.stop).not.toHaveBeenCalled();
  await expect(cloudHerdrConnectionPlan(row.id, "boxd", "nixos", remote.authorize)).rejects.toThrow("verified, running");
  vi.setSystemTime(NOW + 66_000);
  await maintainCloudExecution("team");
  expect(remote.ssh).toHaveBeenLastCalledWith(expect.objectContaining({ id: "existing" }), false);
  expect(remote.stop).toHaveBeenCalledTimes(1);
});

test.each(["herdr", "rex"] as const)("a mismatched optional %s core cannot block the worker or the other backend", async failed => {
  bootstrapFixture();
  state.allocations.set("allocation", allocation({ machineId: "existing", status: "starting" }));
  const ordinary = remote.exec.getMockImplementation()!;
  remote.exec.mockImplementation(async (input: { command: string }) => {
    if (input.command.includes("herdr-core --version")) return { exitCode: 0, stdout: failed === "herdr" ? "hc 0.0.0" : "hc 0.1.18", stderr: "" };
    if (input.command.includes("/rex version")) return { exitCode: 0, stdout: failed === "rex" ? "rex unreviewed" : "rex 0.1.0-preview.13\ncommit: pinned", stderr: "" };
    if (input.command.includes("server status --json")) return { exitCode: 0, stdout: JSON.stringify({ rex_version: "0.1.0-preview.13", you: { transport: "unix" } }), stderr: "" };
    return ordinary(input);
  });
  await maintainCloudExecution("team");
  const row = state.allocations.get("allocation")!;
  expect(row.status).toBe("ready"); expect(row[failed]).toBeUndefined();
  expect(row[failed === "herdr" ? "rex" : "herdr"]).toBeDefined();
  expect(row[failed === "herdr" ? "herdrPrerequisite" : "rexPrerequisite"]).toContain("Private");
  expect(remote.enroll).toHaveBeenCalledTimes(1); expect(remote.create).not.toHaveBeenCalled();
});

test("desktop revocation failure cannot postpone the immutable hard deadline", async () => {
  const row = herdrAllocation();
  state.allocations.set(row.id, { ...row, herdrSshEnabled: true, herdrConnectionUntil: NOW + 60_000, runDeadline: { runId: "run", attempt: 0, deadline: NOW - 1 } });
  const record = state.runs.get("run")!; record.run.hostId = row.hostId!; record.run.status = "running"; record.run.processStopped = false;
  remote.ssh.mockRejectedValue(new Error("provider SSH toggle unavailable"));
  await maintainCloudExecution("team");
  expect(remote.stop).toHaveBeenCalledTimes(1);
  expect(state.allocations.get(row.id)?.status).toBe("stopping");
});

test.each(["boxd", "boat"] as const)("%s Rex grants bind the same worker without wake, shell authority or extended billing", async provider => {
  const row = herdrAllocation(provider);
  state.allocations.set(row.id, { ...row, rex: { version: "0.1.0-preview.13", socket: "/var/lib/origin-runner/.local/state/origin-rex/server.sock", user: "origin-runner", verifiedAt: NOW } });
  const herdr = await cloudHerdrConnectionPlan(row.id, provider, "nixos", remote.authorize);
  const rex = await cloudRexConnectionPlan(row.id, provider, "nixos", remote.authorize);
  expect(rex.machineId).toBe(herdr.machineId); expect(rex.hostId).toBe(herdr.hostId);
  expect(rex.name).not.toBe(herdr.name); expect(rex.expiresAt).toBe(NOW + 60000);
  expect(rex).not.toHaveProperty("remotePrefix"); expect(rex.core.user).toBe("origin-runner");
  expect(state.allocations.get(row.id)?.lastActiveAt).toBe(NOW);
  state.allocations.get(row.id)!.status = "stopping";
  await expect(cloudRexConnectionPlan(row.id, provider, "nixos", remote.authorize)).rejects.toThrow("verified, running");
  expect(remote.create).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled(); expect(remote.extend).not.toHaveBeenCalled(); expect(remote.exec).not.toHaveBeenCalled();
});
