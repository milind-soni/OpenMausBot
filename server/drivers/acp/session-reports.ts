// Every report arrives from another program: a reader takes exactly the documented shape and treats anything else as nothing said.

import { cacheUntilConfigChanges } from "../../config.ts";
import { redactSecretsInText } from "../../redact.ts";
import { toolDetailPreview } from "../../tool-summary.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A report below this share of the peak marks a compaction: OpenCode compactions measured 30-52% of the peak; ordinary dips stay above 83%. */
const ACP_COMPACTION_COLLAPSE_RATIO = 0.6;

export interface UsageState {
  usagePeak: number | null;
  usageLast: number | null;
  usageCompacted: boolean;
}

export interface SessionReport {
  context?: { contextTokens: number; contextWindow?: number };
  /** One finished tool step to show. */
  step?: { title: string; input?: string };
}

/** Hermes sends `used` and `size` flat; opencode 1.18 sends `used` flat or under `usage`. */
function readUsage(update: any, turn: UsageState): SessionReport {
  const used = update.used ?? update.usage?.used;
  if (typeof used !== "number" || !(used > 0)) return {};
  if (turn.usagePeak !== null && used < turn.usagePeak * ACP_COMPACTION_COLLAPSE_RATIO) turn.usageCompacted = true;
  if (turn.usagePeak === null || used > turn.usagePeak) turn.usagePeak = used;
  turn.usageLast = used;
  if (!Number.isFinite(used)) return {};
  const size = update.size ?? update.usage?.size;
  return {
    context: {
      contextTokens: used,
      ...(typeof size === "number" && Number.isFinite(size) && size > 0 ? { contextWindow: size } : {}),
    },
  };
}

/** Hermes (hermes-agent acp_adapter at 38570c3) rotates its session on compression and sends a `session_info_update` whose
 * `_meta.hermes.sessionProvenance` has `reason: "compression"` and a raised `compressionDepth`; either marks a compaction. */
export function hermesCompaction(meta: unknown, lastDepth: number): { compacted: boolean; depth: number } | null {
  const provenance = record(record(record(meta)?.hermes)?.sessionProvenance);
  if (!provenance) return null;
  const reported = provenance.compressionDepth;
  const depth = typeof reported === "number" && Number.isInteger(reported) && reported >= 0 ? reported : null;
  return {
    compacted: provenance.reason === "compression" || (depth !== null && depth > lastDepth),
    depth: depth ?? lastDepth,
  };
}

const PLAN_TEXT_MAX = 80;

/** `Plan: 2 of 5 done — Write the tests`. Redacted before it is cut, so a cut cannot slip a credential past redaction. */
export function planLine(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  const plan = entries.flatMap((entry) => {
    const fields = record(entry);
    const content = typeof fields?.content === "string" ? fields.content.replace(/\s+/g, " ").trim() : "";
    return content ? [{ content, status: fields?.status }] : [];
  });
  if (!plan.length) return null;
  const done = plan.filter((entry) => entry.status === "completed").length;
  const inHand = plan.find((entry) => entry.status === "in_progress");
  const focus = inHand ?? plan.find((entry) => entry.status !== "completed");
  const progress = `Plan: ${done} of ${plan.length} done`;
  if (!focus) return progress;
  const text = redactSecretsInText(focus.content);
  const shown = text.length > PLAN_TEXT_MAX ? `${text.slice(0, PLAN_TEXT_MAX - 1).trimEnd()}…` : text;
  return `${progress} — ${inHand ? "" : "next: "}${shown}`;
}

const planLinesInConfig = cacheUntilConfigChanges((config) => config.features?.acpPlanLines === true);

/** Off unless `features.acpPlanLines`; OMB_ACP_PLAN_LINES=1 or 0 overrides. Each line counts as a tool call wherever those are counted. */
export function acpPlanLinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OMB_ACP_PLAN_LINES === "1") return true;
  if (env.OMB_ACP_PLAN_LINES === "0") return false;
  return planLinesInConfig();
}

interface Reported {
  sessionId: string | null;
  compressionDepth: number;
  planLine: string | null;
}
/** Keyed by the pooled process's session record, so it lives exactly as long as that process. */
const reportedBy = new WeakMap<object, Reported>();
function reportedSoFar(session: { sessionId: string | null }): Reported {
  let reported = reportedBy.get(session);
  if (!reported || reported.sessionId !== session.sessionId) {
    reported = { sessionId: session.sessionId, compressionDepth: 0, planLine: null };
    reportedBy.set(session, reported);
  }
  return reported;
}

export function readSessionReport(
  update: any,
  meta: unknown,
  turn: UsageState,
  session: { sessionId: string | null },
  env: NodeJS.ProcessEnv = process.env,
): SessionReport {
  switch (update?.sessionUpdate) {
    case "usage_update":
      return readUsage(update, turn);
    case "session_info_update": {
      // Hermes puts its notice in the update's `_meta` or the notification's.
      const reported = reportedSoFar(session);
      const marker = hermesCompaction(update._meta, reported.compressionDepth) ?? hermesCompaction(meta, reported.compressionDepth);
      if (!marker) return {};
      reported.compressionDepth = marker.depth;
      if (marker.compacted) turn.usageCompacted = true;
      return {};
    }
    case "plan": {
      // ACP sends the whole list on every update; a line that reads the same is not shown again.
      if (!acpPlanLinesEnabled(env)) return {};
      const reported = reportedSoFar(session);
      const line = planLine(update.entries);
      if (line === null || line === reported.planLine) return {};
      reported.planLine = line;
      return { step: { title: line, input: toolDetailPreview(update.entries) } };
    }
    default:
      return {};
  }
}
