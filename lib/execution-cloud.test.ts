// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { boxdCreateIdentity, boxdError, parseBoxdMachine, parseBoxdUsage, verifyCreation } from "./execution-cloud/boxd";
import { boatCreateBody, boatExecEnvelope, boatHttpError, createBoat, deleteBoat, executeBoat, extendBoat, findBoat, parseBoatCommand, parseBoatDeletion, parseBoatMachine, parseBoatUsage, startBoat, stopBoat } from "./execution-cloud/boat";
import { CloudProviderError, commandResult, EXEC_PYTHON, redactOutput, requireCredentials, requireExec, type CloudCreateInput } from "./execution-cloud/shared";

const id = "bx_23456789";
const input: CloudCreateInput = { provider: "boat", apiKey: "boat_test_fixture", idempotencyKey: "origin-test-creation", name: "Origin test" };
const machineInput = { ...input, id };
const operationId = `bdop_${"a".repeat(32)}`;
const success = (type: string, fields: Record<string, unknown> = {}) => Response.json({ ok: true, type, ...fields });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test.each([
  ["running", "running"], ["pending", "starting"], ["starting", "starting"], ["stopped", "stopped"],
  ["suspended", "unknown"], ["hibernated", "unknown"], ["failed", "unknown"], ["destroyed", "unknown"], ["new-state", "unknown"],
])("Boxd %s never confuses preserved processes with a cold stop", (status, state) => {
  expect(parseBoxdMachine({ id: "vm_123", status, access: { desktopUrl: "https://secret/?token=private" } })).toEqual({ provider: "boxd", id: "vm_123", state });
});
test.each([
  ["ready", "running"], ["idle", "running"], ["running", "running"], ["provisioning", "starting"],
  ["cloning", "starting"], ["archiving", "unknown"], ["archived", "stopped"], ["error", "unknown"], ["cancelled", "unknown"],
])("Boat %s is mapped conservatively", (raw, state) => {
  expect(parseBoatMachine({ id, state: raw, desktopUrl: "https://secret/?token=private", url: "https://secret/?_token=private" })).toEqual({ provider: "boat", id, state });
});
test("machine parsing rejects missing identity/state, and never fabricates a creation timestamp", () => {
  expect(() => parseBoxdMachine({ id: "vm_123" })).toThrow(CloudProviderError);
  expect(() => parseBoatMachine({ id: "../other", state: "ready" }, "create")).toThrow(CloudProviderError);
  expect(parseBoatMachine({ id, state: "ready", createdAt: "invalid" })).not.toHaveProperty("createdAt");
  expect(parseBoxdMachine({ id: "vm_123", status: "running", createdAt: new Date("2026-11-01T00:00:00Z") }).createdAt).toBe(Date.parse("2026-11-01T00:00:00Z"));
});
test("Boxd create identity binds the opaque intent and name, not an API credential", () => {
  const identity = boxdCreateIdentity(input);
  expect(identity).toEqual(boxdCreateIdentity({ ...input, apiKey: "changed" } as CloudCreateInput));
  expect(identity.name).toBe(boxdCreateIdentity({ ...input, name: "Changed" }).name);
  expect(identity.labels["origin-request"]).not.toBe(boxdCreateIdentity({ ...input, name: "Changed" }).labels["origin-request"]);
  expect(identity.name).not.toContain(input.idempotencyKey);
  const raw = { id: "vm_123", status: "running", shared: false, ...identity, networking: { isolated: true, networks: [] } };
  expect(verifyCreation(raw, input).id).toBe("vm_123");
  for (const changed of [{ ...raw, shared: true }, { ...raw, networking: { isolated: false, networks: [] } }, { ...raw, networking: { isolated: true, networks: ["fleet"] } }, { ...raw, labels: {} }, { ...raw, name: "other" }]) {
    try { verifyCreation(changed, input); throw new Error("adopted unsafe machine"); }
    catch (error) { expect(error).toMatchObject({ category: "conflict", outcome: "unknown", machineId: "vm_123" }); }
  }
});
test("Boxd categories distinguish auth, credit, generic quota, conflicts and ambiguous transport failures", () => {
  expect(boxdError({ grpcCode: 16, message: "secret token" }, "create")).toMatchObject({ category: "auth", outcome: "known" });
  expect(boxdError({ grpcCode: 8, message: "machine limit reached" }, "create")).toMatchObject({ category: "rate_limit", outcome: "known" });
  expect(boxdError({ grpcCode: 9, message: "insufficient credits" }, "create")).toMatchObject({ category: "credit", outcome: "known" });
  expect(boxdError({ grpcCode: 6 }, "create").category).toBe("conflict");
  expect(boxdError({ grpcCode: 14, message: "secret token" }, "create")).toMatchObject({ category: "service", outcome: "unknown" });
  expect(JSON.stringify(boxdError({ grpcCode: 14, message: "secret token" }, "exec"))).not.toContain("secret token");
});
test.each([
  [401, "unauthorized", "auth", "known"], [402, "billing_required", "credit", "known"],
  [403, "org_suspended", "credit", "known"], [429, "rate_limited", "rate_limit", "known"],
  [429, "trial_compute_limit_reached", "credit", "known"], [503, "no_ready_machine", "service", "known"],
  [503, "out_of_capacity", "service", "unknown"], [502, "sandbox_direct_failed", "service", "unknown"],
  [409, "idempotency_in_progress", "conflict", "unknown"], [409, "idempotency_key_reused", "conflict", "unknown"],
])("Boat HTTP %s/%s preserves the actual outcome boundary", (status, code, category, outcome) => {
  const error = boatHttpError(status as number, { error: { code, message: "boat_secret_fixture" } }, "create");
  expect(error).toMatchObject({ category, outcome });
  expect(error.message).not.toContain("boat_secret_fixture");
});
test("Boat create body is isolated, private, persistent, deterministic, and contains no account secrets", () => {
  expect(boatCreateBody(input)).toMatchObject({ noEnv: true, snapshots: true, monitoring: false, visibility: "private", type: "small", ttlSeconds: 3600 });
  expect(boatCreateBody(input)).toEqual(boatCreateBody({ ...input }));
  expect(JSON.stringify(boatCreateBody(input))).not.toContain(input.apiKey);
});
test("credit reporting uses real wallet fields; absent, null, NaN and strings never become zero", () => {
  expect(parseBoatUsage({ wallet: { balanceDollars: 0 }, planIncluded: { vmHoursRemaining: 100 } })).toMatchObject({ status: "available", balance: 0, balanceScope: "overage_wallet" });
  expect(parseBoatUsage({ wallet: { balanceDollars: -1.25 } }).balance).toBe(-1.25);
  for (const wallet of [null, {}, { balanceDollars: "3" }, { balanceDollars: NaN }]) expect(parseBoatUsage({ wallet }).status).toBe("unknown");
  expect(parseBoxdUsage({ balanceMicro: 1250000, currency: "eur" })).toMatchObject({ status: "available", balance: 1.25, unit: "EUR", balanceScope: "credit_wallet" });
  for (const balanceMicro of [undefined, "0", Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(parseBoxdUsage({ balanceMicro, currency: "usd" }).status).toBe("unknown");
});
test("null, missing, timed-out and truncated exits cannot masquerade as command success", () => {
  const result = { stdout: "out", stderr: "err" };
  for (const exitCode of [null, undefined, -1, NaN, "0", 256]) expect(() => commandResult("boat", { ...result, exitCode }, id)).toThrow(CloudProviderError);
  expect(parseBoatCommand({ ...result, exitCode: 7 }, id).exitCode).toBe(7);
  expect(() => parseBoatCommand({ ...result, exitCode: 0, timedOut: true }, id)).toThrow(/timed out/);
  expect(() => parseBoatCommand({ ...result, exitCode: 0, stdoutTruncated: true }, id)).toThrow(/truncated/);
});
test("explicit credentials and valid environment are required even if ambient keys exist", () => {
  vi.stubEnv("BOXD_API_KEY", "ambient_fixture");
  expect(() => requireCredentials({ provider: "boxd", apiKey: "" }, "create")).toThrow(/explicit/);
  expect(() => requireExec({ ...machineInput, command: "true", timeoutSeconds: 1, env: { "BAD-NAME": "x" } })).toThrow(/Environment/);
  expect(() => requireExec({ ...machineInput, command: "true", timeoutSeconds: 1, env: { VALUE: "x\0y" } })).toThrow(/Environment/);
  expect(() => requireExec({ ...machineInput, command: "true", timeoutSeconds: 0 })).toThrow(/timeout/);
  vi.unstubAllEnvs();
});
test("Boxd stdin launcher preserves hostile env values literally without shell interpolation", () => {
  const value = "'\"$(not-a-command)\nprivate-λ";
  const command = "python3 -c 'import os,sys;assert \"AMBIENT_FLEET_KEY\" not in os.environ;sys.stdout.write(os.environ[\"ORIGIN_TEST_VALUE\"])'";
  expect(EXEC_PYTHON).not.toContain(value);
  const stdout = execFileSync("python3", ["-c", EXEC_PYTHON], { input: JSON.stringify({ command, env: { ORIGIN_TEST_VALUE: value } }), encoding: "utf8", env: { ...process.env, AMBIENT_FLEET_KEY: "ambient-fixture" } });
  expect(stdout).toBe(value);
});
test("Boat envelope is private, never embeds env in commands, and is unlinked before child execution", () => {
  const value = "secret'\n$(not-a-command)λ";
  const envelope = boatExecEnvelope({ command: "python3 -c 'import os,sys;sys.stdout.write(os.environ[\"ORIGIN_TEST_VALUE\"])'", env: { ORIGIN_TEST_VALUE: value } }, randomUUID());
  try {
    execFileSync("/bin/sh", ["-c", envelope.prepare]);
    expect(statSync(envelope.directory).mode & 0o777).toBe(0o700);
    expect(statSync(envelope.path).mode & 0o777).toBe(0o600);
    writeFileSync(envelope.path, envelope.content);
    expect(JSON.parse(readFileSync(envelope.path, "utf8")).env.ORIGIN_TEST_VALUE).toBe(value);
    expect(envelope.prepare + envelope.command).not.toContain(value);
    expect(execFileSync("/bin/sh", ["-c", envelope.command], { encoding: "utf8" })).toBe(value);
    expect(existsSync(envelope.path)).toBe(false);
  } finally { rmSync(envelope.directory, { recursive: true, force: true }); }
});
test("secret redaction does not expose overlapping values", () => {
  expect(redactOutput({ exitCode: 0, stdout: "secret-long secret", stderr: "secret-long" }, ["secret", "secret-long", ""]).stdout).toBe("[redacted] [redacted]");
});

test("lost create response is ambiguous and is never automatically retried", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("network error with boat_test_fixture"));
  vi.stubGlobal("fetch", fetcher);
  await expect(createBoat(input)).rejects.toMatchObject({ outcome: "unknown", category: "service", operation: "create" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test("malformed accepted create is ambiguous and preserves idempotent wire body/key", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, type: "sandbox.created", sandbox: { state: "provisioning" } }, { status: 202 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(createBoat(input)).rejects.toMatchObject({ category: "protocol", outcome: "unknown" });
  const options = fetcher.mock.calls[0][1];
  expect(options.headers["Idempotency-Key"]).toBe(input.idempotencyKey);
  expect(JSON.parse(options.body)).toEqual(boatCreateBody(input));
  expect(options.redirect).toBe("error");
});
test("read-only creation reconciliation checks every page and never adopts a name-only match", async () => {
  const labels = boatCreateBody(input).labels;
  const fetcher = vi.fn()
    .mockResolvedValueOnce(success("sandbox.list", { sandboxes: [{ id, name: input.name, state: "ready", labels: {} }], pageInfo: { hasMore: true, nextCursor: "next-page" } }))
    .mockResolvedValueOnce(success("sandbox.list", { sandboxes: [{ id, name: input.name, state: "ready", labels }], pageInfo: { hasMore: false } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(findBoat(input)).resolves.toMatchObject({ id, state: "running" });
  expect(fetcher.mock.calls.every(call => call[1].method === "GET")).toBe(true);
  expect(fetcher.mock.calls[1][0]).toContain("cursor=next-page");
});
test("reconciliation rejects changed intent and duplicate machine matches instead of guessing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success("sandbox.list", { sandboxes: [{ id, name: input.name, state: "ready", labels: { ...boatCreateBody(input).labels, "origin-request": "changed" } }], pageInfo: { hasMore: false } })));
  await expect(findBoat(input)).rejects.toMatchObject({ category: "conflict", outcome: "unknown" });
});
test("a refused snapshot stop does not claim process termination or force data loss", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(success("sandbox.info", { sandbox: { id, state: "ready" } }))
    .mockResolvedValueOnce(success("sandbox.stopping", { id, status: "archiving" }))
    .mockResolvedValueOnce(success("sandbox.info", { sandbox: { id, state: "archiving", stop: { status: "failing" } } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(stopBoat(machineInput)).rejects.toMatchObject({ category: "conflict", outcome: "unknown" });
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({});
});
test("already-stopped Boat is idempotent and a running Boat is not needlessly resumed", async () => {
  const fetcher = vi.fn().mockResolvedValue(success("sandbox.info", { sandbox: { id, state: "archived" } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(stopBoat(machineInput)).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(success("sandbox.info", { sandbox: { id, state: "ready" } }));
  await expect(startBoat(machineInput)).resolves.toMatchObject({ id, state: "running" });
  expect(fetcher.mock.calls.every(call => call[1].method === "GET")).toBe(true);
});
test("deletion operation binds the intended machine; pending/blocked never means completed", async () => {
  expect(parseBoatDeletion({ id: operationId, status: "pending", targetId: id, kind: "sandbox" }, undefined, id).status).toBe("pending");
  expect(() => parseBoatDeletion({ id: operationId, status: "completed", targetId: "other", kind: "sandbox" }, undefined, id)).toThrow(CloudProviderError);
  const fetcher = vi.fn().mockResolvedValue(success("sandbox.deleting", { operation: { id: operationId, kind: "sandbox", targetId: id, status: "blocked" } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(deleteBoat(machineInput)).rejects.toMatchObject({ outcome: "unknown", operationId, machineId: id });
  expect(fetcher.mock.calls[0][1].headers["X-Ascii-Confirm-Delete"]).toBe(id);
});
test("sandbox not-found is not silently accepted as evidence of a completed Boat purge", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: false, code: "not_found" }, { status: 404 })));
  await expect(deleteBoat(machineInput)).rejects.toMatchObject({ category: "not_found" });
});
test("Boat secret transfer uses a separate file body and still cleans up after ambiguous exec", async () => {
  const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const value = "unique_secret_fixture";
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    const body = options.body ? JSON.parse(options.body as string) : {};
    requests.push({ url, method: options.method ?? "GET", body });
    if (options.method === "PUT") return success("file.written", { success: true });
    if (options.method === "DELETE") return success("file.deleted", { success: true });
    if (requests.length === 1) return success("command.finished", { exitCode: 0, stdout: "", stderr: "" });
    throw new Error("connection lost");
  }));
  await expect(executeBoat({ ...machineInput, command: "echo hello", env: { VALUE: value }, timeoutSeconds: 20 })).rejects.toMatchObject({ category: "service", outcome: "unknown" });
  expect(requests.filter(request => request.method === "POST").every(request => !JSON.stringify(request.body).includes(value))).toBe(true);
  expect(requests.find(request => request.method === "PUT")?.body.content).toContain(value);
  expect(requests.at(-1)?.method).toBe("DELETE");
});

test("auth failure after stop acceptance does not prove the original process stopped", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(success("sandbox.info", { sandbox: { id, state: "ready" } }))
    .mockResolvedValueOnce(success("sandbox.stopping", { id, status: "archiving" }))
    .mockResolvedValueOnce(Response.json({ ok: false, code: "unauthorized" }, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(stopBoat(machineInput)).rejects.toMatchObject({ category: "auth", outcome: "unknown" });
});
test("long Boat commands consume byte-offset chunks without duplicating multibyte output", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(success("command.finished", { exitCode: 0, stdout: "", stderr: "" }))
    .mockResolvedValueOnce(success("file.written", { success: true }))
    .mockResolvedValueOnce(success("command.started", { processId: 12 }))
    .mockResolvedValueOnce(success("command.status", { processId: 12, status: "running", known: true, running: true, exitCode: null, stdout: "λ", stderr: "", stdoutOffset: 0, stderrOffset: 0, stdoutNextOffset: 2, stderrNextOffset: 0, more: true }))
    .mockResolvedValueOnce(success("command.status", { processId: 12, status: "exited", known: true, running: false, exitCode: 7, stdout: "done", stderr: "err", stdoutOffset: 2, stderrOffset: 0, stdoutNextOffset: 6, stderrNextOffset: 3, more: false }))
    .mockResolvedValueOnce(success("file.deleted", { success: true }));
  vi.stubGlobal("fetch", fetcher);
  await expect(executeBoat({ ...machineInput, command: "long-job", timeoutSeconds: 601 })).resolves.toEqual({ exitCode: 7, stdout: "λdone", stderr: "err" });
  expect(JSON.parse(fetcher.mock.calls[2][1].body).detached).toBe(true);
  expect(fetcher.mock.calls[4][0]).toContain("stdoutOffset=2");
});
test("lost detached process state triggers tree cancellation and never reports exit zero", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(success("command.finished", { exitCode: 0, stdout: "", stderr: "" }))
    .mockResolvedValueOnce(success("file.written", { success: true }))
    .mockResolvedValueOnce(success("command.started", { processId: 12 }))
    .mockResolvedValueOnce(success("command.status", { processId: 12, status: "lost", known: false, running: false, exitCode: 0, stdout: "", stderr: "", stdoutOffset: 0, stderrOffset: 0, stdoutNextOffset: 0, stderrNextOffset: 0 }))
    .mockResolvedValueOnce(success("command.stopped", { processId: 12, running: false }))
    .mockResolvedValueOnce(success("file.deleted", { success: true }));
  vi.stubGlobal("fetch", fetcher);
  await expect(executeBoat({ ...machineInput, command: "long-job", timeoutSeconds: 601 })).rejects.toMatchObject({ category: "protocol", outcome: "unknown" });
  expect(fetcher.mock.calls[4][0].endsWith("/commands/12")).toBe(true);
  expect(fetcher.mock.calls[4][1].method).toBe("DELETE");
});

test("Boat lifetime extension accepts only bounded TTLs and rejects provider-clamped deadlines", async () => {
  const fetcher = vi.fn().mockImplementation(async () => success("sandbox.info", { sandbox: { id, state: "ready", ttlSeconds: 900, archiveAfter: "2026-11-08T12:15:00Z" } }));
  vi.stubGlobal("fetch", fetcher);
  for (const ttlSeconds of [0, -1, Infinity, NaN, 2592001, 1.5]) await expect(extendBoat({ ...machineInput, ttlSeconds })).rejects.toMatchObject({ category: "invalid_request" });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(extendBoat({ ...machineInput, ttlSeconds: 900 })).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0][1].method).toBe("PATCH");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ ttlSeconds: 900 });
  await expect(extendBoat({ ...machineInput, ttlSeconds: 1800 })).rejects.toMatchObject({ category: "conflict", operation: "extend" });
  fetcher.mockResolvedValue(success("sandbox.info", { sandbox: { id, state: "ready", ttlSeconds: null, archiveAfter: null } }));
  await expect(extendBoat({ ...machineInput, ttlSeconds: 900 })).rejects.toMatchObject({ category: "protocol", outcome: "unknown" });
});

test("Boat refuses an explicitly shared or teammate-owned creation before exposing credentials", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  for (const changed of [{ visibility: "shared" }, { access: "use" }, { access: "view" }, { monitoring: true }, { snapshots: false }]) {
    fetcher.mockResolvedValue(success("sandbox.created", { sandbox: { id, state: "ready", ...changed } }));
    await expect(createBoat(input)).rejects.toMatchObject({ category: "conflict", outcome: "unknown", machineId: id });
  }
});
