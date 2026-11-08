import { createHash } from "node:crypto";
import { Boxd } from "@boxd-sh/sdk";
import {
  CloudProviderError, commandResult, EXEC_PYTHON, MAX_OUTPUT_BYTES, mutation, protocol, record, shellQuote, sleep, timestamp,
  type CloudCreateInput, type CloudExecInput, type CloudMachine, type CloudMachineInput, type CloudOperation, type CloudUsage,
} from "./shared";

// The published SDK's env option prefixes shell assignments; use stdin instead.
// https://docs.boxd.sh/reference/typescript-sdk
// https://github.com/boxd-sh/sdk/tree/main/typescript/src
export function boxdError(error: unknown, operation: CloudOperation, machineId?: string): CloudProviderError {
  if (error instanceof CloudProviderError) return error;
  const data = record(error), grpc = typeof data.grpcCode === "number" ? data.grpcCode : undefined;
  const status = typeof data.httpStatus === "number" ? data.httpStatus : undefined;
  // RESOURCE_EXHAUSTED alone is a quota/rate limit, NOT proof of exhausted money.
  const credit = status === 402 || (grpc === 8 || grpc === 9) && typeof data.message === "string" && /\b(insufficient (credit|credits|balance)|credit(s)? exhausted|out of credits)\b/i.test(data.message);
  const category = credit ? "credit" : grpc === 16 || grpc === 7 || status === 401 || status === 403 || data.name === "AuthenticationError" || data.name === "PermissionDeniedError" ? "auth" : grpc === 5 || data.name === "NotFoundError" ? "not_found" : grpc === 8 || status === 429 || data.name === "RateLimitError" ? "rate_limit" : grpc === 6 || grpc === 9 || grpc === 10 || data.name === "ConflictError" ? "conflict" : grpc === 3 || grpc === 11 ? "invalid_request" : "service";
  return new CloudProviderError("boxd", operation, category, `Boxd ${operation} failed (${category})`, mutation(operation) && category === "service" ? "unknown" : "known", { machineId, grpcCode: grpc, httpStatus: status });
}

export function parseBoxdMachine(value: unknown, operation: CloudOperation = "get"): CloudMachine {
  const machine = record(value);
  if (typeof machine.id !== "string" || !machine.id || typeof machine.status !== "string") protocol("boxd", operation);
  return {
    provider: "boxd", id: machine.id as string,
    state: machine.status === "running" ? "running" : machine.status === "stopped" ? "stopped" : ["pending", "starting"].includes(machine.status as string) ? "starting" : "unknown",
    ...(typeof machine.name === "string" ? { name: machine.name } : {}),
    ...(timestamp(machine.createdAt) !== undefined ? { createdAt: timestamp(machine.createdAt) } : {}),
  };
}

export function boxdCreateIdentity(input: Pick<CloudCreateInput, "idempotencyKey" | "name">) {
  const keyHash = createHash("sha256").update(input.idempotencyKey).digest("hex");
  return {
    // Boxd names are unique while alive; the durable journal must never replay a
    // finished/deleted provisioning intent. This is not a provider idempotency API.
    name: `origin-${keyHash.slice(0, 40)}`,
    labels: { "origin-key": keyHash, "origin-request": createHash("sha256").update(JSON.stringify([input.idempotencyKey, input.name])).digest("hex") },
  };
}
export function verifyCreation(value: unknown, input: CloudCreateInput): CloudMachine {
  const raw = record(value), machine = parseBoxdMachine(raw, "create"), identity = boxdCreateIdentity(input);
  const labels = record(raw.labels), network = record(raw.networking);
  if (raw.name !== identity.name || raw.shared !== false || labels["origin-key"] !== identity.labels["origin-key"] || labels["origin-request"] !== identity.labels["origin-request"] || network.isolated !== true || !Array.isArray(network.networks) || network.networks.length !== 0) {
    throw new CloudProviderError("boxd", "create", "conflict", "Boxd machine identity or isolation does not match this provisioning intent; reconcile without adopting or deleting it", "unknown", { machineId: machine.id });
  }
  return machine;
}
async function withBoxd<T>(apiKey: string, operation: CloudOperation, id: string | undefined, run: (client: Boxd) => Promise<T>): Promise<T> {
  let client: Boxd | undefined;
  try {
    client = new Boxd({ apiKey, baseURL: "https://boxd.sh:9443", region: "fra", maxRetries: 0, timeout: 30000 });
    return await run(client);
  } catch (error) { throw boxdError(error, operation, id); }
  finally { await client?.close().catch(error => { throw boxdError(error, operation, id); }); }
}

export function findBoxd(input: CloudCreateInput) {
  return withBoxd(input.apiKey, "get", boxdCreateIdentity(input).name, async client => {
    try { return verifyCreation(await client.machines.get(boxdCreateIdentity(input).name), input); }
    catch (error) { if (boxdError(error, "get").category === "not_found") return null; throw error; }
  });
}
export function startBoxd(input: CloudMachineInput) {
  return withBoxd(input.apiKey, "start", input.id, async client => {
    const machine = await client.machines.get(input.id);
    if (machine.status === "stopped") await client.machines.start(input.id);
    else if (machine.status === "suspended" || machine.status === "hibernated") await client.machines.wake(input.id);
    else if (machine.status !== "running" && machine.status !== "pending" && machine.status !== "starting") {
      throw new CloudProviderError("boxd", "start", "conflict", "Boxd machine is not in a startable state", "known", { machineId: input.id });
    }
    try { return parseBoxdMachine(await client.machines.get(input.id), "start"); }
    catch (error) {
      const failure = boxdError(error, "start", input.id);
      throw new CloudProviderError("boxd", "start", failure.category, "Boxd start state could not be confirmed", "unknown", failure.details);
    }
  });
}

export function createBoxd(input: CloudCreateInput) {
  const identity = boxdCreateIdentity(input);
  return withBoxd(input.apiKey, "create", identity.name, async client => {
    try { return verifyCreation(await client.machines.get(identity.name), input); }
    catch (error) { if (boxdError(error, "get").category !== "not_found") throw error; }
    let raw;
    try {
      raw = await client.machines.create({
        ...identity, isolated: true, shared: false, networks: [],
        config: { vcpu: 1, memory: "4G", ssh: false, autoSuspendTimeout: 0, idleIgnoreOutbound: false },
      });
    } catch (error) {
      const failure = boxdError(error, "create", identity.name);
      // A lost response or concurrent create is reconciled by READ only. Never
      // retry create here or destroy a machine whose ownership is uncertain.
      if (failure.outcome === "unknown" || failure.category === "conflict") {
        try { return verifyCreation(await client.machines.get(identity.name), input); }
        catch (readError) {
          if (readError instanceof CloudProviderError && readError.category === "conflict") throw readError;
          throw new CloudProviderError("boxd", "create", failure.category, "Boxd create outcome is unknown; reconcile the deterministic machine name before any retry", "unknown", { machineId: identity.name, grpcCode: failure.details.grpcCode });
        }
      }
      throw failure;
    }
    // SDK create can return a partial fallback when its own re-read failed.
    // Confirm actual isolation and identity before returning an adoptable host.
    try { return verifyCreation(await client.machines.get(raw.id), input); }
    catch (error) {
      const failure = boxdError(error, "create", raw.id);
      throw new CloudProviderError("boxd", "create", failure.category, "Boxd accepted create but readiness/identity could not be confirmed", "unknown", { machineId: raw.id });
    }
  });
}
export function getBoxd(input: CloudMachineInput) {
  return withBoxd(input.apiKey, "get", input.id, async client => parseBoxdMachine(await client.machines.get(input.id)));
}
// Desktop access is opt-in and bounded by the Origin allocation journal.
// Disabling SSH also closes existing sessions and does not wake a stopped VM.
export function setBoxdHerdrSsh(input: CloudMachineInput, enabled: boolean) {
  return withBoxd(input.apiKey, "exec", input.id, client => client.machines.setSsh(input.id, enabled));
}
export function executeBoxd(input: CloudExecInput) {
  return withBoxd(input.apiKey, "exec", input.id, async client => {
    // Disable automatic idle hibernation before sending credentials. This does
    // not prohibit manual/provider memory capture; only cold stop ends processes.
    await client.machines.setAutoHibernateTimeout(input.id, 0);
    // Isolated Boxd sessions still inject scoped env/secrets. Replace the
    // session shell, not just its child, and discard those before running code.
    const command = `exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" LANG=C.UTF-8 /usr/bin/python3 -c ${shellQuote(EXEC_PYTHON)}`;
    const stream = client.machines.streamExec(input.id, { command, tty: false });
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      stream.close();
      deadline.reject(new CloudProviderError("boxd", "exec", "service", "Boxd command timed out; cancellation requested, confirm cold stop before handoff", "unknown", { machineId: input.id }));
    }, input.timeoutSeconds * 1000);
    const collect = async (source: AsyncIterable<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > MAX_OUTPUT_BYTES) {
          stream.close();
          throw new CloudProviderError("boxd", "exec", "service", "Boxd command output exceeded 16 MiB; cancellation requested", "unknown", { machineId: input.id });
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      stream.write(JSON.stringify({ command: input.command, env: input.env ?? {} }));
      stream.end();
      const [exitCode, stdout, stderr] = await Promise.race([Promise.all([stream.wait(), collect(stream.stdout), collect(stream.stderr)]), deadline.promise]);
      return commandResult("boxd", { exitCode, stdout, stderr }, input.id);
    } finally { clearTimeout(timer); stream.close(); }
  });
}
export function stopBoxd(input: CloudMachineInput) {
  return withBoxd(input.apiKey, "stop", input.id, async client => {
    if ((await client.machines.get(input.id)).status === "stopped") return;
    await client.machines.stop(input.id);
    const until = Date.now() + 120000;
    do {
      try { if ((await client.machines.get(input.id)).status === "stopped") return; }
      catch (error) {
        const failure = boxdError(error, "stop", input.id);
        throw new CloudProviderError("boxd", "stop", failure.category, "Boxd accepted stop but process termination remains unconfirmed", "unknown", failure.details);
      }
      await sleep(1500);
    } while (Date.now() < until);
    throw new CloudProviderError("boxd", "stop", "service", "Boxd cold stop has not been confirmed; do not hand work to another host", "unknown", { machineId: input.id });
  });
}
export function deleteBoxd(input: CloudMachineInput) {
  return withBoxd(input.apiKey, "delete", input.id, async client => {
    try { await client.machines.delete(input.id); }
    catch (error) { if (boxdError(error, "delete").category !== "not_found") throw error; }
    const until = Date.now() + 120000;
    do {
      try { await client.machines.get(input.id); }
      catch (error) {
        const failure = boxdError(error, "delete", input.id);
        if (failure.category === "not_found") return;
        throw new CloudProviderError("boxd", "delete", failure.category, "Boxd accepted deletion but teardown remains unconfirmed", "unknown", failure.details);
      }
      await sleep(1500);
    } while (Date.now() < until);
    throw new CloudProviderError("boxd", "delete", "service", "Boxd deletion has not been confirmed", "unknown", { machineId: input.id });
  });
}
export function parseBoxdUsage(value: unknown): CloudUsage {
  const data = record(value);
  if (typeof data.balanceMicro !== "number" || !Number.isSafeInteger(data.balanceMicro) || typeof data.currency !== "string" || !/^(eur|usd)$/i.test(data.currency)) return { status: "unknown", error: "Boxd did not expose a usable credit-wallet balance" };
  return { status: "available", balance: data.balanceMicro / 1000000, unit: data.currency.toUpperCase(), balanceScope: "credit_wallet", label: "Boxd credit wallet (not a subscription allowance)" };
}
export function usageBoxd(apiKey: string) {
  return withBoxd(apiKey, "usage", undefined, async client => {
    // Legacy subscription accounts have no meaningful credit balance. Do not
    // present their protobuf default zero as exhausted subscription credits.
    const account = await client.account.get();
    if (account.billing.subscriptionStatus) return { status: "unknown" as const, error: "Boxd reports a subscription; no remaining subscription balance is exposed" };
    return parseBoxdUsage(await client.orgs.billingActivityPage({ pageSize: 1 }));
  });
}
