import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";

const SCHEMA = "aos.openmausbot_status.v1";
const TTL_SECONDS = 300;
const MAX_CACHE_BYTES = 16_384;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const digestSchema = z.string().regex(DIGEST);
const slotSchema = z.object({
  slot: z.string().regex(/^vm-[1-4]$/),
  container: z.enum(["running", "stopped", "missing"]),
  readiness: z.enum(["ready", "not_ready"]),
  network: z.enum(["loopback", "unsafe", "unknown"]),
  security: z.enum(["hardened", "unsafe", "unknown"]),
  persistence: z.enum(["durable", "unsafe", "unknown"]),
}).strict();
const uiSchema = z.object({
  two_up: z.boolean(),
  max_visible: z.union([z.literal(1), z.literal(2)]),
  max_interactive: z.literal(1),
  default_watch_only: z.boolean(),
}).strict();
const capsuleSchema = z.object({
  schema: z.literal(SCHEMA),
  observed_at: z.string().regex(UTC_TIMESTAMP),
  fresh_until: z.string().regex(UTC_TIMESTAMP),
  ttl_seconds: z.literal(TTL_SECONDS),
  source_sha256: digestSchema.nullable(),
  dual_view_sha256: digestSchema.nullable(),
  receipt_sha256: digestSchema,
  refresh_status: z.enum(["success", "failed"]),
  failure_reason: z.enum([
    "config_unavailable",
    "bots_unavailable",
    "vm_status_unavailable",
    "capacity_exceeded",
    "source_hash_unavailable",
    "source_hash_mismatch",
  ]).optional(),
  runtime_state: z.enum(["ready", "degraded", "unknown"]),
  mode: z.enum(["shared", "per-bot", "unknown"]),
  max_instances: z.number().int().min(1).max(4).nullable(),
  ready_count: z.number().int().min(0).max(4),
  slots: z.array(slotSchema).max(4),
  ui: uiSchema,
}).strict();

const jsonObjectSchema = z.record(z.string(), z.custom<JsonValue>());

export const OPENMAUS_STATUS_CACHE_PATH = join(
  homedir(),
  ".local/state/aos-session-bridge/openmausbot/latest.json",
);

type OpenMausSlot = z.output<typeof slotSchema>;
type OpenMausUi = z.output<typeof uiSchema>;
type OpenMausCapsule = z.output<typeof capsuleSchema>;

export interface OpenMausStatusDigest {
  schema: typeof SCHEMA;
  freshness: "fresh" | "stale" | "unknown";
  reason?: "missing_or_insecure" | "invalid" | "clock_skew" | "stale" | "refresh_failed";
  observedAt?: string;
  receiptSha256?: string;
  sourceSha256?: string;
  dualViewSha256?: string;
  runtimeState: "ready" | "degraded" | "unknown";
  mode: "shared" | "per-bot" | "unknown";
  maxInstances: number | null;
  readyCount: number;
  slots: OpenMausSlot[];
  ui: {
    twoUp: boolean;
    maxVisible: 1 | 2;
    maxInteractive: 1;
    defaultWatchOnly: boolean;
    oneActiveController: true;
  };
}

export interface OpenMausStatusReadOptions {
  cachePath?: string;
  now?: Date;
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const parsedObject = jsonObjectSchema.safeParse(value);
  if (!parsedObject.success) return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(parsedObject.data).sort()) {
    const child = parsedObject.data[key];
    if (child !== undefined) sorted[key] = canonicalValue(child);
  }
  return sorted;
}

function canonical(value: JsonValue): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (new Date(parsed).toISOString().replace(".000Z", "Z") !== value) return null;
  return parsed;
}

function expectedUi(twoUp: boolean): OpenMausUi {
  return {
    two_up: twoUp,
    max_visible: twoUp ? 2 : 1,
    max_interactive: 1,
    default_watch_only: twoUp,
  };
}

function sameUi(left: OpenMausUi, right: OpenMausUi): boolean {
  return (
    left.two_up === right.two_up &&
    left.max_visible === right.max_visible &&
    left.max_interactive === right.max_interactive &&
    left.default_watch_only === right.default_watch_only
  );
}

function unsignedDocument(capsule: OpenMausCapsule): JsonObject {
  const document: JsonObject = {
    schema: capsule.schema,
    observed_at: capsule.observed_at,
    fresh_until: capsule.fresh_until,
    ttl_seconds: capsule.ttl_seconds,
    source_sha256: capsule.source_sha256,
    dual_view_sha256: capsule.dual_view_sha256,
    refresh_status: capsule.refresh_status,
    runtime_state: capsule.runtime_state,
    mode: capsule.mode,
    max_instances: capsule.max_instances,
    ready_count: capsule.ready_count,
    slots: capsule.slots.map((slot): JsonObject => ({
      slot: slot.slot,
      container: slot.container,
      readiness: slot.readiness,
      network: slot.network,
      security: slot.security,
      persistence: slot.persistence,
    })),
    ui: {
      two_up: capsule.ui.two_up,
      max_visible: capsule.ui.max_visible,
      max_interactive: capsule.ui.max_interactive,
      default_watch_only: capsule.ui.default_watch_only,
    },
  };
  if (capsule.failure_reason !== undefined) document.failure_reason = capsule.failure_reason;
  return document;
}

function validSlotState(slot: OpenMausSlot): boolean {
  return (
    slot.readiness !== "ready" ||
    (slot.container === "running" &&
      slot.network === "loopback" &&
      slot.security === "hardened" &&
      slot.persistence === "durable")
  );
}

function validateCapsule(value: JsonValue): OpenMausCapsule | null {
  const parsed = capsuleSchema.safeParse(value);
  if (!parsed.success) return null;
  const capsule = parsed.data;
  const observed = timestamp(capsule.observed_at);
  const freshUntil = timestamp(capsule.fresh_until);
  if (observed === null || freshUntil === null || freshUntil - observed !== TTL_SECONDS * 1000) return null;
  if (capsule.receipt_sha256 !== sha256(canonical(unsignedDocument(capsule)))) return null;
  if (!capsule.slots.every((slot, index) => slot.slot === `vm-${index + 1}` && validSlotState(slot))) {
    return null;
  }
  const readyCount = capsule.slots.filter((slot) => slot.readiness === "ready").length;
  if (capsule.ready_count !== readyCount) return null;
  const twoUp = Boolean(
    capsule.refresh_status === "success" &&
      capsule.mode === "per-bot" &&
      capsule.max_instances !== null &&
      capsule.max_instances >= 2 &&
      capsule.source_sha256 !== null &&
      capsule.dual_view_sha256 !== null &&
      capsule.source_sha256 === capsule.dual_view_sha256,
  );
  if (!sameUi(capsule.ui, expectedUi(twoUp))) return null;

  if (capsule.refresh_status === "failed") {
    if (
      capsule.failure_reason === undefined ||
      capsule.runtime_state !== "unknown" ||
      capsule.mode !== "unknown" ||
      capsule.max_instances !== null ||
      capsule.ready_count !== 0 ||
      capsule.slots.length !== 0 ||
      !sameUi(capsule.ui, expectedUi(false))
    ) return null;
  } else {
    const expectedRuntime = capsule.slots.length > 0 && readyCount === capsule.slots.length ? "ready" : "degraded";
    if (
      capsule.failure_reason !== undefined ||
      capsule.runtime_state !== expectedRuntime ||
      (capsule.mode !== "shared" && capsule.mode !== "per-bot") ||
      capsule.max_instances === null ||
      readyCount > capsule.max_instances ||
      capsule.source_sha256 === null ||
      capsule.dual_view_sha256 === null ||
      capsule.source_sha256 !== capsule.dual_view_sha256
    ) return null;
  }
  return capsule;
}

function privateCache(path: string): Buffer | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  let descriptor: number | null = null;
  try {
    const parentStatus = lstatSync(dirname(path));
    const fileStatus = lstatSync(path);
    if (
      parentStatus.isSymbolicLink() ||
      !parentStatus.isDirectory() ||
      parentStatus.uid !== uid ||
      (parentStatus.mode & 0o777) !== 0o700
    ) return null;
    if (
      fileStatus.isSymbolicLink() ||
      !fileStatus.isFile() ||
      fileStatus.uid !== uid ||
      (fileStatus.mode & 0o777) !== 0o600 ||
      fileStatus.size > MAX_CACHE_BYTES
    ) return null;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStatus = fstatSync(descriptor);
    if (
      !openedStatus.isFile() ||
      openedStatus.uid !== uid ||
      (openedStatus.mode & 0o777) !== 0o600 ||
      openedStatus.dev !== fileStatus.dev ||
      openedStatus.ino !== fileStatus.ino ||
      openedStatus.size > MAX_CACHE_BYTES
    ) return null;
    const contents = readFileSync(descriptor);
    return contents.length <= MAX_CACHE_BYTES ? contents : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Cleanup failures must not escape the fail-closed cache read.
      }
    }
  }
}

function unknownDigest(
  reason: NonNullable<OpenMausStatusDigest["reason"]>,
  freshness: OpenMausStatusDigest["freshness"] = "unknown",
  receipt?: Pick<OpenMausStatusDigest, "observedAt" | "receiptSha256">,
): OpenMausStatusDigest {
  return {
    schema: SCHEMA,
    freshness,
    reason,
    ...receipt,
    runtimeState: "unknown",
    mode: "unknown",
    maxInstances: null,
    readyCount: 0,
    slots: [],
    ui: {
      twoUp: false,
      maxVisible: 1,
      maxInteractive: 1,
      defaultWatchOnly: false,
      oneActiveController: true,
    },
  };
}

export function readOpenMausStatus(
  options: OpenMausStatusReadOptions = {},
): OpenMausStatusDigest {
  const raw = privateCache(options.cachePath ?? OPENMAUS_STATUS_CACHE_PATH);
  if (raw === null) return unknownDigest("missing_or_insecure");
  let capsule: OpenMausCapsule | null;
  try {
    capsule = validateCapsule(parseJson(raw.toString("utf8")));
  } catch {
    capsule = null;
  }
  if (capsule === null) return unknownDigest("invalid");
  const observed = timestamp(capsule.observed_at)!;
  const freshUntil = timestamp(capsule.fresh_until)!;
  const now = (options.now ?? new Date()).getTime();
  const receipt = { observedAt: capsule.observed_at, receiptSha256: capsule.receipt_sha256 };
  if (!Number.isFinite(now) || now < observed) return unknownDigest("clock_skew");
  if (now >= freshUntil) return unknownDigest("stale", "stale", receipt);
  if (capsule.refresh_status === "failed") return unknownDigest("refresh_failed", "fresh", receipt);
  const result: OpenMausStatusDigest = {
    schema: SCHEMA,
    freshness: "fresh",
    ...receipt,
    runtimeState: capsule.runtime_state,
    mode: capsule.mode,
    maxInstances: capsule.max_instances,
    readyCount: capsule.ready_count,
    slots: capsule.slots,
    ui: {
      twoUp: capsule.ui.two_up,
      maxVisible: capsule.ui.max_visible,
      maxInteractive: 1,
      defaultWatchOnly: capsule.ui.default_watch_only,
      oneActiveController: true,
    },
  };
  if (capsule.source_sha256 !== null) result.sourceSha256 = capsule.source_sha256;
  if (capsule.dual_view_sha256 !== null) result.dualViewSha256 = capsule.dual_view_sha256;
  return result;
}

export function openMausStatusSystemPrompt(options: OpenMausStatusReadOptions = {}): string {
  const status = readOpenMausStatus(options);
  const receipt = [
    status.observedAt ? `observed_at=${status.observedAt}` : null,
    status.receiptSha256 ? `receipt_sha256=${status.receiptSha256}` : null,
    status.sourceSha256 ? `source_sha256=${status.sourceSha256}` : null,
    status.dualViewSha256 ? `accepted_dual_view_sha256=${status.dualViewSha256}` : null,
    status.sourceSha256 && status.dualViewSha256
      ? `source_match=${status.sourceSha256 === status.dualViewSha256}`
      : null,
  ].filter(Boolean).join("; ");
  const runtime = status.freshness === "fresh" && status.reason === undefined
    ? [
        `runtime_state=${status.runtimeState}`,
        `mode=${status.mode}`,
        `maximum_instances=${status.maxInstances}`,
        `ready_count=${status.readyCount}`,
      ].join("; ")
    : "runtime_state=unknown; mode=unknown; maximum_instances=unknown; ready_count=0";
  const slots = status.slots.length
    ? status.slots
        .map((slot) =>
          `${slot.slot}(container=${slot.container},readiness=${slot.readiness},network=${slot.network},security=${slot.security},persistence=${slot.persistence})`
        )
        .join(",")
    : "none";
  return [
    "TRUSTED OPENMAUSBOT STATUS (read-only, validated, no transcript or credential data):",
    `schema=${status.schema}; freshness=${status.freshness}${status.reason ? `; reason=${status.reason}` : ""}`,
    receipt || "receipt=unavailable",
    runtime,
    `anonymous_slots=${slots}`,
    `ui.two_up=${status.ui.twoUp}; ui.max_visible=${status.ui.maxVisible}; ui.max_interactive=1; ui.default_watch_only=${status.ui.defaultWatchOnly}; one_active_controller=true`,
    "Opening a viewer or two-up workspace never starts or provisions a VM. Only one pane may be interactive at a time; switching control must release the previous pane before activating the next.",
    "Treat missing, stale, failed, clock-skewed, malformed, or receipt-hash-mismatched runtime data as unknown. Do not infer bot identities, viewer URLs, paths, messages, models, accounts, or credentials from this block.",
  ].join("\n");
}
