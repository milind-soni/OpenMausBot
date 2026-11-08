import { createHash, randomUUID } from "node:crypto";
import {
  CloudProviderError, commandResult, MAX_OUTPUT_BYTES, mutation, protocol, record, shellQuote, sleep, timestamp,
  type CloudCommandResult, type CloudCreateInput, type CloudExecInput, type CloudMachine, type CloudMachineInput, type CloudOperation, type CloudUsage,
} from "./shared";

// Wire schemas: https://docs.boat.dev/api/v1 (including /limits, command status,
// files, stop operations and deletion operations). No dashboard/private APIs.
const BASE = "https://boat.dev/api/v1";
const CREDIT_CODES: Record<string, true> = { billing_required: true, team_member_cap_reached: true, org_suspended: true, trial_compute_limit_reached: true };
const SAFE_CODES: Record<string, true> = { ...CREDIT_CODES, unauthorized: true, forbidden: true, insufficient_scope: true, not_found: true, rate_limited: true, limit_reached: true, member_limit_reached: true, IP_RATE_LIMIT_EXCEEDED: true, idempotency_in_progress: true, idempotency_key_reused: true, no_ready_machine: true, out_of_capacity: true, sandbox_direct_failed: true, boat_direct_failed: true, sandbox_starting: true, machine_not_running: true, sandbox_not_ready: true, snapshots_disabled: true, snapshot_data_expired: true, monitoring_off: true };
export function boatHttpError(status: number, body: unknown, operation: CloudOperation, machineId?: string): CloudProviderError {
  const data = record(body), nested = record(data.error);
  const code = typeof data.code === "string" ? data.code : typeof nested.code === "string" ? nested.code : undefined;
  const category = status === 402 || Object.hasOwn(CREDIT_CODES, code ?? "") ? "credit" : status === 401 || status === 403 ? "auth" : status === 404 ? "not_found" : status === 429 ? "rate_limit" : status === 409 ? "conflict" : status >= 400 && status < 500 ? "invalid_request" : "service";
  const refusedCapacity = code === "no_ready_machine";
  const uncertain = mutation(operation) && ((status >= 500 && !refusedCapacity) || status === 408 || code === "idempotency_in_progress" || code === "idempotency_key_reused");
  // Do not echo provider messages, details, request bodies or arbitrary codes.
  return new CloudProviderError("boat", operation, category, `Boat ${operation} failed (${category})`, uncertain ? "unknown" : "known", { machineId, httpStatus: status, ...(code && Object.hasOwn(SAFE_CODES, code) ? { code } : {}) });
}
async function request(apiKey: string, path: string, operation: CloudOperation, options: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; machineId?: string } = {}) {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET", redirect: "error", cache: "no-store",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
    });
    text = await response.text();
  } catch {
    throw new CloudProviderError("boat", operation, "service", `Boat ${operation} connection failed; no mutation was retried`, mutation(operation) ? "unknown" : "known", { machineId: options.machineId });
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { if (!response.ok) throw boatHttpError(response.status, {}, operation, options.machineId); protocol("boat", operation, options.machineId); }
  const data = record(value);
  if (!response.ok || data.ok === false) throw boatHttpError(response.ok ? typeof data.status === "number" ? data.status : 500 : response.status, data, operation, options.machineId);
  if (data.ok !== true || typeof data.type !== "string") protocol("boat", operation, options.machineId);
  return data;
}
export function parseBoatMachine(value: unknown, operation: CloudOperation = "get"): CloudMachine {
  const machine = record(value);
  if (typeof machine.id !== "string" || !/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(machine.id) || typeof machine.state !== "string") protocol("boat", operation);
  return {
    provider: "boat", id: machine.id as string,
    state: ["ready", "idle", "running"].includes(machine.state as string) ? "running" : machine.state === "archived" ? "stopped" : ["init", "provisioning", "provisioned", "cloning"].includes(machine.state as string) ? "starting" : "unknown",
    ...(typeof machine.name === "string" ? { name: machine.name } : {}),
    ...(timestamp(machine.createdAt) !== undefined ? { createdAt: timestamp(machine.createdAt) } : {}),
    // Never copy desktop/public URLs: these can carry bearer access tokens.
  };
}
export function boatCreateBody(input: Pick<CloudCreateInput, "name" | "idempotencyKey">) {
  return {
    name: input.name, type: "small", noEnv: true, snapshots: true, monitoring: false, visibility: "private", ttlSeconds: 3600,
    labels: { "origin-key": createHash("sha256").update(input.idempotencyKey).digest("hex"), "origin-request": createHash("sha256").update(JSON.stringify([input.idempotencyKey, input.name])).digest("hex") },
  };
}
export async function createBoat(input: CloudCreateInput) {
  // Caller journals the first-send time and must not replay after the documented
  // 24-hour key retention. No automatic retries or provider switching here.
  const data = await request(input.apiKey, "/sandboxes", "create", { method: "POST", body: boatCreateBody(input), headers: { "Idempotency-Key": input.idempotencyKey }, timeoutMs: 90000 });
  const raw = record(data.sandbox), machine = parseBoatMachine(raw, "create");
  if (raw.visibility === "shared" || (raw.access !== undefined && raw.access !== "owner") || raw.monitoring === true || raw.snapshots === false) {
    throw new CloudProviderError("boat", "create", "conflict", "Boat did not apply private persistent runner settings; reconcile before installing credentials", "unknown", { machineId: machine.id });
  }
  return machine;
}
export async function findBoat(input: CloudCreateInput): Promise<CloudMachine | null> {
  const body = boatCreateBody(input);
  const query = new URLSearchParams({ limit: "200", label: `origin-key=${body.labels["origin-key"]}` });
  const cursors = new Set<string>();
  let found: CloudMachine | null = null;
  for (;;) {
    const data = await request(input.apiKey, `/sandboxes?${query}`, "get");
    if (!Array.isArray(data.sandboxes)) protocol("boat", "get");
    for (const value of data.sandboxes as unknown[]) {
      const raw = record(value), labels = record(raw.labels);
      // Re-check: older servers can ignore filters. Never adopt on name alone.
      if (labels["origin-key"] !== body.labels["origin-key"]) continue;
      const machine = parseBoatMachine(raw);
      if (labels["origin-request"] !== body.labels["origin-request"] || raw.name !== input.name || raw.visibility === "shared" || (raw.access !== undefined && raw.access !== "owner") || raw.monitoring === true || raw.snapshots === false || (found && found.id !== machine.id)) {
        throw new CloudProviderError("boat", "create", "conflict", "Boat provisioning identity/privacy is inconsistent or matches multiple machines; manual reconciliation required", "unknown", { machineId: machine.id });
      }
      found = machine;
    }
    const page = record(data.pageInfo);
    if (page.hasMore === false) return found;
    if (page.hasMore !== true || typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor)) protocol("boat", "get");
    cursors.add(page.nextCursor as string);
    query.set("cursor", page.nextCursor as string);
  }
}
export async function getBoat(input: CloudMachineInput) {
  const data = await request(input.apiKey, `/sandboxes/${input.id}`, "get", { machineId: input.id });
  const machine = parseBoatMachine(data.sandbox);
  if (machine.id !== input.id) protocol("boat", "get", input.id);
  return machine;
}
export async function startBoat(input: CloudMachineInput) {
  const machine = await getBoat(input);
  if (machine.state === "running" || machine.state === "starting") return machine;
  if (machine.state !== "stopped") throw new CloudProviderError("boat", "start", "conflict", "Boat machine is not stopped; do not supersede an in-progress stop", "known", { machineId: input.id });
  // noEnv persists from creation. Resending it explicitly requests credential
  // scrubbing; custom-home OAuth persistence still requires live verification.
  const data = await request(input.apiKey, `/sandboxes/${input.id}/resume`, "start", { method: "POST", body: { ttlSeconds: 3600 }, machineId: input.id, timeoutMs: 90000 });
  if (data.sandbox) {
    const resumed = parseBoatMachine(data.sandbox, "start");
    if (resumed.id !== input.id) protocol("boat", "start", input.id);
    return resumed;
  }
  return getBoat(input);
}

export async function extendBoat(input: CloudMachineInput & { ttlSeconds: number }): Promise<void> {
  // Relative to server now, not an accumulated extension. The controller must
  // calculate this from the live lease deadline on every call.
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 2592000) {
    throw new CloudProviderError("boat", "extend", "invalid_request", "Boat TTL must be 1–2592000 seconds; disabling auto-stop is not supported");
  }
  const data = await request(input.apiKey, `/sandboxes/${input.id}`, "extend", { method: "PATCH", body: { ttlSeconds: input.ttlSeconds }, machineId: input.id });
  const raw = record(data.sandbox);
  if (raw.id !== input.id || timestamp(raw.archiveAfter) === undefined || !Number.isInteger(raw.ttlSeconds)) protocol("boat", "extend", input.id);
  if (raw.ttlSeconds !== input.ttlSeconds || data.giftLimitNotice) {
    throw new CloudProviderError("boat", "extend", "conflict", "Boat applied a different lifetime; the requested run deadline is not guaranteed", "known", { machineId: input.id });
  }
}

export function boatExecEnvelope(input: Pick<CloudExecInput, "command" | "env">, nonce: string) {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error("Invalid command envelope nonce");
  const directory = `/tmp/origin-exec-${nonce}`, path = `${directory}/input.json`;
  const prepare = `import os; os.mkdir(${JSON.stringify(directory)},0o700); fd=os.open(${JSON.stringify(path)},os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.close(fd)`;
  // Unlink before executing, even if the child fails. /tmp is also explicitly
  // excluded from Boat's private disk snapshots.
  const launch = `import json,os; f=open(${JSON.stringify(path)}); os.chmod(${JSON.stringify(path)},0o600); p=json.load(f); f.close(); os.unlink(${JSON.stringify(path)}); os.dup2(os.open('/dev/null',os.O_RDONLY),0); os.execvpe('bash',['bash','-c',p['command']],dict(os.environ,**p['env']))`;
  return { directory, path, content: JSON.stringify({ command: input.command, env: input.env ?? {} }), prepare: `python3 -c ${shellQuote(prepare)}`, command: `python3 -c ${shellQuote(launch)}` };
}
export function parseBoatCommand(value: unknown, id: string): CloudCommandResult {
  const data = record(value);
  if (data.timedOut === true) throw new CloudProviderError("boat", "exec", "service", "Boat command timed out; confirm process termination before handoff", "unknown", { machineId: id });
  if (data.stdoutTruncated === true || data.stderrTruncated === true) throw new CloudProviderError("boat", "exec", "protocol", "Boat truncated command output; complete output was not received", "unknown", { machineId: id });
  if (typeof data.stdout === "string" && typeof data.stderr === "string" && Buffer.byteLength(data.stdout) + Buffer.byteLength(data.stderr) > MAX_OUTPUT_BYTES) throw new CloudProviderError("boat", "exec", "protocol", "Boat command output exceeded 16 MiB", "unknown", { machineId: id });
  return commandResult("boat", data, id);
}
async function runBoatCommand(input: CloudExecInput, command: string): Promise<CloudCommandResult> {
  const path = `/sandboxes/${input.id}/commands`;
  if (input.timeoutSeconds <= 600) {
    return parseBoatCommand(await request(input.apiKey, path, "exec", { method: "POST", body: { command, timeoutSeconds: input.timeoutSeconds }, timeoutMs: (input.timeoutSeconds + 70) * 1000, machineId: input.id }), input.id);
  }
  const started = await request(input.apiKey, path, "exec", { method: "POST", body: { command, detached: true }, timeoutMs: 90000, machineId: input.id });
  if (!Number.isInteger(started.processId) || (started.processId as number) < 1) protocol("boat", "exec", input.id);
  const processId = started.processId as number, until = Date.now() + input.timeoutSeconds * 1000;
  const stdoutParts: string[] = [], stderrParts: string[] = [];
  let stdoutOffset = 0, stderrOffset = 0, outputBytes = 0;
  try {
    for (;;) {
      const data = await request(input.apiKey, `${path}/${processId}?stdoutOffset=${stdoutOffset}&stderrOffset=${stderrOffset}`, "exec", { machineId: input.id });
      if (data.processId !== processId || !["running", "exited"].includes(data.status as string) || data.known === false || typeof data.running !== "boolean" || (data.running === false && data.status !== "exited") || typeof data.stdout !== "string" || typeof data.stderr !== "string" || data.stdoutOffset !== stdoutOffset || data.stderrOffset !== stderrOffset || !Number.isSafeInteger(data.stdoutNextOffset) || !Number.isSafeInteger(data.stderrNextOffset) || data.stdoutTruncated === true || data.stderrTruncated === true) protocol("boat", "exec", input.id);
      const stdoutBytes = Buffer.byteLength(data.stdout as string), stderrBytes = Buffer.byteLength(data.stderr as string);
      if (data.stdoutNextOffset !== stdoutOffset + stdoutBytes || data.stderrNextOffset !== stderrOffset + stderrBytes) protocol("boat", "exec", input.id);
      stdoutParts.push(data.stdout as string); stderrParts.push(data.stderr as string);
      stdoutOffset = data.stdoutNextOffset as number; stderrOffset = data.stderrNextOffset as number;
      outputBytes += stdoutBytes + stderrBytes;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        throw new CloudProviderError("boat", "exec", "service", "Boat command output exceeded 16 MiB", "unknown", { machineId: input.id });
      }
      if (data.running === false && data.more !== true) return parseBoatCommand({ ...data, stdout: stdoutParts.join(""), stderr: stderrParts.join("") }, input.id);
      if (Date.now() >= until) throw new CloudProviderError("boat", "exec", "service", "Boat detached command exceeded its deadline", "unknown", { machineId: input.id });
      if (data.more !== true) await sleep(1000);
    }
  } catch (error) {
    // Detached commands do not die when HTTP disconnects. Explicitly stop the
    // whole process tree, but never turn an uncertain command into a success.
    try { await request(input.apiKey, `${path}/${processId}`, "exec", { method: "DELETE", machineId: input.id }); } catch { /* Original uncertain result still blocks handoff. */ }
    throw error;
  }
}
export async function executeBoat(input: CloudExecInput): Promise<CloudCommandResult> {
  const envelope = boatExecEnvelope(input, randomUUID());
  let result: CloudCommandResult | undefined, failure: unknown;
  try {
    const prepared = await runBoatCommand({ ...input, timeoutSeconds: 30 }, envelope.prepare);
    if (prepared.exitCode !== 0) throw new CloudProviderError("boat", "exec", "service", "Boat could not create a private command envelope; user command was not launched", "known", { machineId: input.id });
    await request(input.apiKey, `/sandboxes/${input.id}/files`, "exec", { method: "PUT", body: { path: envelope.path, content: envelope.content, encoding: "utf8" }, timeoutMs: 90000, machineId: input.id });
    result = await runBoatCommand(input, envelope.command);
  } catch (error) { failure = error; }
  try {
    await request(input.apiKey, `/sandboxes/${input.id}/files?path=${encodeURIComponent(envelope.directory)}&recursive=true`, "exec", { method: "DELETE", machineId: input.id });
  } catch (error) {
    // A failed preparation or user cleanup can leave no directory. Only
    // not_found is harmless; never hide a failure to remove a credential file.
    if (!(error instanceof CloudProviderError && error.category === "not_found")) {
      if (failure instanceof CloudProviderError) throw new CloudProviderError("boat", "exec", failure.category, `${failure.message}; private command-envelope cleanup is unconfirmed; stop/delete this host before reuse`, failure.outcome, failure.details);
      throw new CloudProviderError("boat", "exec", "service", "Private command-envelope cleanup is unconfirmed; stop/delete this host before reuse", "unknown", { machineId: input.id });
    }
  }
  if (failure) throw failure;
  if (!result) protocol("boat", "exec", input.id);
  return result;
}

export async function stopBoat(input: CloudMachineInput) {
  if ((await getBoat(input)).state === "stopped") return;
  await request(input.apiKey, `/sandboxes/${input.id}/stop`, "stop", { method: "POST", body: {}, machineId: input.id });
  const until = Date.now() + 120000;
  do {
    let data;
    try { data = await request(input.apiKey, `/sandboxes/${input.id}`, "stop", { machineId: input.id }); }
    catch (error) {
      const category = error instanceof CloudProviderError ? error.category : "service";
      throw new CloudProviderError("boat", "stop", category, "Boat accepted stop but process termination remains unconfirmed", "unknown", { machineId: input.id });
    }
    const raw = record(data.sandbox), operation = record(raw.stop);
    if (raw.id !== input.id) protocol("boat", "stop", input.id);
    if (raw.state === "archived" && (operation.status === undefined || operation.status === "completed")) return;
    if (operation.status === "failing" || operation.status === "superseded") throw new CloudProviderError("boat", "stop", "conflict", "Boat stop failed or was superseded; the previous process may still be running", "unknown", { machineId: input.id });
    await sleep(1500);
  } while (Date.now() < until);
  throw new CloudProviderError("boat", "stop", "service", "Boat stop is not confirmed; archiving or snapshot failure is not stopped", "unknown", { machineId: input.id });
}
export type CloudDeletionStatus = "pending" | "processing" | "blocked" | "completed";
export function parseBoatDeletion(value: unknown, operationId?: string, machineId?: string): { id: string; status: CloudDeletionStatus } {
  const operation = record(value);
  if (typeof operation.id !== "string" || !/^bdop_[a-f0-9]{32}$/.test(operation.id) || (operationId && operation.id !== operationId) || (machineId && (operation.targetId !== machineId || operation.kind !== "sandbox")) || !["pending", "processing", "blocked", "completed"].includes(operation.status as string)) protocol("boat", "delete", machineId);
  return { id: operation.id as string, status: operation.status as CloudDeletionStatus };
}
export async function deletionStatusBoat(apiKey: string, operationId: string): Promise<CloudDeletionStatus> {
  if (!/^bdop_[a-f0-9]{32}$/.test(operationId)) throw new CloudProviderError("boat", "delete", "invalid_request", "A valid Boat deletion operation ID is required");
  const data = await request(apiKey, `/deletion-operations/${operationId}`, "delete");
  return parseBoatDeletion(data.operation, operationId).status;
}
export async function deleteBoat(input: CloudMachineInput) {
  const data = await request(input.apiKey, `/sandboxes/${input.id}`, "delete", { method: "DELETE", headers: { "X-Ascii-Confirm-Delete": input.id }, machineId: input.id });
  const operation = parseBoatDeletion(data.operation, undefined, input.id);
  let status = operation.status;
  const until = Date.now() + 120000;
  try {
    while (status !== "completed" && status !== "blocked" && Date.now() < until) {
      await sleep(1500);
      status = await deletionStatusBoat(input.apiKey, operation.id);
    }
  } catch (error) {
    const category = error instanceof CloudProviderError ? error.category : "service";
    throw new CloudProviderError("boat", "delete", category, "Boat deletion was accepted but completion is unconfirmed; reconcile the operation", "unknown", { machineId: input.id, operationId: operation.id });
  }
  if (status !== "completed") throw new CloudProviderError("boat", "delete", "service", "Boat purge is still pending or blocked; a sandbox 404 is not proof of purge", "unknown", { machineId: input.id, operationId: operation.id });
}
export function parseBoatUsage(value: unknown): CloudUsage {
  const wallet = record(record(value).wallet);
  if (typeof wallet.balanceDollars !== "number" || !Number.isFinite(wallet.balanceDollars)) return { status: "unknown", error: "Boat does not expose a finite overage wallet balance for this account" };
  return { status: "available", balance: wallet.balanceDollars, unit: "USD", balanceScope: "overage_wallet", label: "Boat overage wallet (excludes included plan compute)" };
}
export async function usageBoat(apiKey: string) { return parseBoatUsage(await request(apiKey, "/limits", "usage")); }
