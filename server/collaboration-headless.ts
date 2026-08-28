import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { openCollaborationLedger } from "./collaboration/db.ts";
import { CollaborationDegradationController } from "./collaboration/degradation.ts";
import type { OutboxDeliveryPort } from "./collaboration/outbox.ts";
import { LocalOwnerRegistry } from "./collaboration/owner.ts";
import {
  configuredCredentialPath,
  readSecureCredentialFile,
  SecureDingTalkCredentialFileProvider,
} from "./collaboration/operations/credentials.ts";
import {
  CollaborationDiskMonitor,
  type DiskCapacityPort,
  NodeDiskCapacityPort,
} from "./collaboration/operations/disk-monitor.ts";
import {
  FetchPrivateOwnerAlertSink,
  LedgerPrivateOwnerAlertPort,
  type PrivateOwnerAlertSink,
} from "./collaboration/operations/private-alert.ts";
import {
  CollaborationHeadlessRuntime,
  type CollaborationHeadlessRuntimeOptions,
  type CollaborationRuntimeHealth,
  type RuntimeLogger,
  type RuntimeStream,
} from "./collaboration/operations/runtime.ts";
import { DingTalkReplyRouter, DingTalkSessionReplyRegistry } from "./integrations/dingtalk/reply-router.ts";
import { FetchDingTalkSessionSender } from "./integrations/dingtalk/sender.ts";
import { DingTalkStreamAdapter } from "./integrations/dingtalk/stream-adapter.ts";
import { RealDingTalkStreamSdk } from "./integrations/dingtalk/stream-sdk.ts";

interface HeadlessArguments {
  dataDirectory: string;
  healthOnly: boolean;
  help: boolean;
  recoverOwner: boolean;
  expectedGeneration?: number;
  identitySource?: { kind: "stdin" } | { kind: "file"; path: string };
}

interface HeadlessWritable {
  write(value: string): unknown;
}

export interface HeadlessIo {
  stdin: NodeJS.ReadableStream;
  stdout: HeadlessWritable;
  stderr: HeadlessWritable;
  once(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

export interface HeadlessDependencies {
  io?: HeadlessIo;
  createRuntime?: (options: CollaborationHeadlessRuntimeOptions) => CollaborationHeadlessRuntime;
  drainIntervalMs?: number;
  shutdownTimeoutMs?: number;
  diskCapacity?: DiskCapacityPort;
  privateOwnerAlertSink?: PrivateOwnerAlertSink;
}

const PROCESS_IO: HeadlessIo = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  once: (signal, listener) => process.once(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

function usage(): string {
  return [
    "Usage: pnpm collaboration:headless [--data-dir PATH] [--health]",
    "       pnpm collaboration:headless --recover-owner --expected-generation N (--identity-stdin | --identity-file PATH)",
    "",
    "  --data-dir PATH           Store collaboration state below PATH",
    "  --health                  Print health JSON and exit",
    "  --recover-owner           Replace the sole Owner identity and exit",
    "  --expected-generation N   Required compare-and-swap generation for Owner recovery",
    "  --identity-stdin          Read new corp/staff identity as JSON from stdin",
    "  --identity-file PATH      Read new identity from an absolute regular 0600 file",
  ].join("\n");
}

export function parseHeadlessArguments(argv: readonly string[], environment: NodeJS.ProcessEnv): HeadlessArguments {
  let dataDirectory = environment.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
  let healthOnly = false;
  let help = false;
  let recoverOwner = false;
  let expectedGeneration: number | undefined;
  let identitySource: HeadlessArguments["identitySource"];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--health") {
      healthOnly = true;
    } else if (argument === "--recover-owner") {
      recoverOwner = true;
    } else if (argument === "--identity-stdin") {
      if (identitySource) throw new Error("owner_identity_source_must_be_unique");
      identitySource = { kind: "stdin" };
    } else if (argument === "--identity-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--identity-file requires a path");
      if (identitySource) throw new Error("owner_identity_source_must_be_unique");
      identitySource = { kind: "file", path: value };
      index += 1;
    } else if (argument === "--expected-generation") {
      const value = argv[index + 1];
      if (!value || !/^\d+$/u.test(value)) throw new Error("--expected-generation requires a positive integer");
      expectedGeneration = Number(value);
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
        throw new Error("--expected-generation requires a positive integer");
      }
      index += 1;
    } else if (argument === "--data-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--data-dir requires a path");
      dataDirectory = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (recoverOwner) {
    if (healthOnly) throw new Error("--recover-owner cannot be combined with --health");
    if (!expectedGeneration || !identitySource) {
      throw new Error("owner_recovery_requires_generation_and_identity_source");
    }
  } else if (expectedGeneration || identitySource) {
    throw new Error("owner_recovery_options_require_--recover-owner");
  }
  return { dataDirectory: resolve(dataDirectory), healthOnly, help, recoverOwner, expectedGeneration, identitySource };
}

function safeRuntimeLogger(io: HeadlessIo): RuntimeLogger {
  return { write: (event) => io.stderr.write(`${JSON.stringify(event)}\n`) };
}

function sourceEventId(dedupeKey: string): string | undefined {
  const prefix = "dingtalk:event:";
  const suffix = ":ack";
  return dedupeKey.startsWith(prefix) && dedupeKey.endsWith(suffix)
    ? dedupeKey.slice(prefix.length, -suffix.length)
    : undefined;
}

function parseConversationAllowlist(raw: string, field: string): Set<string> {
  let values: unknown[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = raw.split(",");
  }
  if (values.length < 1 || values.length > 32) throw new Error(`${field}_invalid`);
  const normalized = values.map((value) => {
    if (typeof value !== "string") throw new Error(`${field}_invalid`);
    const id = value.trim();
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error(`${field}_invalid`);
    return id;
  });
  const result = new Set(normalized);
  if (result.size !== normalized.length) throw new Error(`${field}_contains_duplicates`);
  return result;
}

export function readDingTalkAllowedConversationIds(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  const preferred = environment.OMB_DINGTALK_ALLOWED_CONVERSATION_IDS?.trim();
  const legacy = environment.DINGTALK_ROBOT_ALLOWED_CONVERSATION_IDS?.trim();
  if (!preferred && !legacy) throw new Error("dingtalk_allowed_conversation_ids_required");
  const preferredIds = preferred
    ? parseConversationAllowlist(preferred, "OMB_DINGTALK_ALLOWED_CONVERSATION_IDS")
    : undefined;
  const legacyIds = legacy
    ? parseConversationAllowlist(legacy, "DINGTALK_ROBOT_ALLOWED_CONVERSATION_IDS")
    : undefined;
  if (preferredIds && legacyIds) {
    const same =
      preferredIds.size === legacyIds.size && [...preferredIds].every((value) => legacyIds.has(value));
    if (!same) throw new Error("dingtalk_allowed_conversation_ids_conflict");
  }
  return preferredIds ?? legacyIds!;
}

function createDingTalkDelivery(
  sessions: DingTalkSessionReplyRegistry,
  environment: NodeJS.ProcessEnv,
): OutboxDeliveryPort {
  const router = new DingTalkReplyRouter(sessions, new FetchDingTalkSessionSender());
  const proactiveOpenConversationId = environment.OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID?.trim() || undefined;
  return {
    async deliver(message) {
      const result = await router.send({
        sourceEventId: sourceEventId(message.dedupeKey),
        proactiveOpenConversationId,
        payload: message.payload,
        idempotencyKey: message.dedupeKey,
      });
      if (result.kind === "sent") return { outcome: "sent" as const };
      if (result.kind === "permanent") return { outcome: "permanent_failure" as const, error: result.code };
      return { outcome: "retryable" as const, error: result.code };
    },
  };
}

function diskMinimumBytes(environment: NodeJS.ProcessEnv): bigint {
  const raw = environment.OMB_DISK_MIN_AVAILABLE_BYTES?.trim();
  if (!raw) return 1024n * 1024n * 1024n;
  if (!/^\d+$/u.test(raw)) throw new Error("OMB_DISK_MIN_AVAILABLE_BYTES must be a non-negative integer");
  return BigInt(raw);
}

function diskMinimumRatio(environment: NodeJS.ProcessEnv): number {
  const raw = environment.OMB_DISK_MIN_AVAILABLE_RATIO?.trim();
  if (!raw) return 0.05;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("OMB_DISK_MIN_AVAILABLE_RATIO must be between zero and one");
  }
  return value;
}

function productionRuntimeOptions(
  options: HeadlessArguments,
  environment: NodeJS.ProcessEnv,
  io: HeadlessIo,
  shutdownTimeoutMs: number,
  dependencies: HeadlessDependencies,
): CollaborationHeadlessRuntimeOptions {
  const sessions = new DingTalkSessionReplyRegistry();
  const dingTalkEnabled = environment.OMB_DINGTALK_ENABLED === "1";
  const allowedConversationIds = dingTalkEnabled
    ? readDingTalkAllowedConversationIds(environment)
    : undefined;
  return {
    dataDirectory: options.dataDirectory,
    shutdownTimeoutMs,
    probeOnly: options.healthOnly,
    logger: safeRuntimeLogger(io),
    ...(dingTalkEnabled
      ? { outboxDelivery: createDingTalkDelivery(sessions, environment) }
      : {}),
    maintenanceFactory: ({ database, dataDirectory }) => {
      const sink =
        dependencies.privateOwnerAlertSink ??
        new FetchPrivateOwnerAlertSink(
          configuredCredentialPath(
            "OMB_OWNER_ALERT_WEBHOOK_FILE",
            "owner-alert-webhook.url",
            environment,
          ),
        );
      return new CollaborationDiskMonitor(
        database,
        new CollaborationDegradationController(database),
        new LedgerPrivateOwnerAlertPort(database, sink),
        dependencies.diskCapacity ?? new NodeDiskCapacityPort(),
        {
          dataDirectory,
          minimumAvailableBytes: diskMinimumBytes(environment),
          minimumAvailableRatio: diskMinimumRatio(environment),
        },
      );
    },
    dingTalk: {
      enabled: dingTalkEnabled,
      credentials: new SecureDingTalkCredentialFileProvider(environment),
      createStream(credentials, sinks, logger): RuntimeStream {
        const sdk = new RealDingTalkStreamSdk(credentials, () => {
          logger.write({ event: "collaboration.dingtalk.handler_failed", code: "dingtalk_handler_failed" });
        });
        const adapter = new DingTalkStreamAdapter(
          sdk,
          { ingest: (message) => sinks.ingest(message) },
          { perform: (action) => sinks.perform(action) },
          sessions,
          { write: (event) => logger.write({ event: event.event, ...(event.code ? { code: event.code } : {}) }) },
          { allowedConversationIds },
        );
        return {
          async start() {
            const state = await adapter.start();
            return state === "connected" ? "connected" : "reconnecting";
          },
          stop: () => adapter.stop(),
          state: () => adapter.state(),
        };
      },
    },
  };
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 16 * 1024) throw new Error("owner_identity_input_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseOwnerIdentity(raw: Buffer): { senderCorpId: string; senderStaffId: string } {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    if (Object.keys(parsed).sort().join(",") !== "senderCorpId,senderStaffId") throw new Error();
    const senderCorpId = "senderCorpId" in parsed && typeof parsed.senderCorpId === "string" ? parsed.senderCorpId : "";
    const senderStaffId = "senderStaffId" in parsed && typeof parsed.senderStaffId === "string" ? parsed.senderStaffId : "";
    if (!senderCorpId.trim() || !senderStaffId.trim()) throw new Error();
    return { senderCorpId, senderStaffId };
  } catch {
    throw new Error("owner_identity_json_invalid");
  } finally {
    raw.fill(0);
  }
}

async function recoverOwner(options: HeadlessArguments, io: HeadlessIo): Promise<void> {
  const source = options.identitySource!;
  if (source.kind === "file" && !isAbsolute(source.path)) throw new Error("owner_identity_file_must_be_absolute");
  const raw = source.kind === "file" ? readSecureCredentialFile(source.path) : await readStdin(io.stdin);
  const identity = parseOwnerIdentity(raw);
  const ledger = openCollaborationLedger(join(options.dataDirectory, "collaboration"));
  let registry: LocalOwnerRegistry | null = null;
  try {
    registry = new LocalOwnerRegistry(ledger.filePath);
    const binding = registry.recover({
      expectedGeneration: options.expectedGeneration!,
      senderCorpId: identity.senderCorpId,
      senderStaffId: identity.senderStaffId,
    });
    io.stdout.write(`${JSON.stringify({ status: "owner_recovered", generation: binding.generation })}\n`);
  } finally {
    registry?.close();
    ledger.close();
  }
}

function waitForSignal(io: HeadlessIo): { promise: Promise<NodeJS.Signals>; dispose(): void } {
  let resolveSignal: ((signal: NodeJS.Signals) => void) | undefined;
  const promise = new Promise<NodeJS.Signals>((resolve) => (resolveSignal = resolve));
  const onInterrupt = () => resolveSignal?.("SIGINT");
  const onTerminate = () => resolveSignal?.("SIGTERM");
  io.once("SIGINT", onInterrupt);
  io.once("SIGTERM", onTerminate);
  return {
    promise,
    dispose() {
      io.off("SIGINT", onInterrupt);
      io.off("SIGTERM", onTerminate);
    },
  };
}

async function stopWithin(runtime: CollaborationHeadlessRuntime, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("collaboration_shutdown_timeout")), milliseconds);
  });
  try {
    await Promise.race([runtime.stop(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runCollaborationHeadless(
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies: HeadlessDependencies = {},
): Promise<CollaborationRuntimeHealth | null> {
  const io = dependencies.io ?? PROCESS_IO;
  const options = parseHeadlessArguments(argv, environment);
  if (options.help) {
    io.stdout.write(`${usage()}\n`);
    return null;
  }
  if (options.recoverOwner) {
    await recoverOwner(options, io);
    return null;
  }
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 10_000;
  const createRuntime = dependencies.createRuntime ?? ((runtimeOptions) => new CollaborationHeadlessRuntime(runtimeOptions));
  const runtime = createRuntime(productionRuntimeOptions(options, environment, io, shutdownTimeoutMs, dependencies));
  const health = await runtime.start();
  io.stdout.write(`${JSON.stringify(health)}\n`);
  if (options.healthOnly) {
    await stopWithin(runtime, shutdownTimeoutMs);
    return health;
  }

  const signal = waitForSignal(io);
  const interval = setInterval(() => void runtime.drainOnce().catch(() => undefined), dependencies.drainIntervalMs ?? 1_000);
  try {
    await signal.promise;
  } finally {
    clearInterval(interval);
    signal.dispose();
  }
  await stopWithin(runtime, shutdownTimeoutMs);
  return health;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCollaborationHeadless().catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`collaboration-headless: ${code}\n`);
    process.exitCode = 1;
  });
}
