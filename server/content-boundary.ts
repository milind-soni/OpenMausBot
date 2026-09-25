// The content-class boundary (#1670): one composition point over the
// existing redaction funnels. Credentials are always scrubbed by
// redactSecretsInText — unchanged, unconditional, never loosenable. A bot
// configured with contentClasses gets those spans masked at the SAME
// ingest points; a detected-but-loosened class passes and is audited into
// the thread's canonical event log. Unconfigured bots take the
// credential-only path byte-for-byte.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { EVENTS_DIR } from "./config.ts";
import { newId, type RuntimeEvent } from "./contracts.ts";
import { capThreadLog, currentThreadLogCap } from "./thread-log-rotation.ts";
import { redactContentClasses, type ContentClass } from "../shared/content-class.ts";
import { redactSecretsInText } from "../shared/redact.ts";

export type ContentBoundaryFunnel = "tool-result" | "transcript" | "memory";

export interface ContentBoundaryAudit {
  botId: string;
  threadId: string;
  funnel: ContentBoundaryFunnel;
}

type AuditSink = (event: RuntimeEvent) => void;

let auditSink: AuditSink | undefined;

/** Tests bind a collector; production writes the same NDJSON line the bus
 * would, under the same cap. */
export function bindContentBoundaryAuditSink(sink: AuditSink | undefined): void {
  auditSink = sink;
}

/** Returns the classes whose audit write failed, so the caller can enforce them instead: an unaudited loosening never ships. */
function auditContentClassPass(audit: ContentBoundaryAudit, classes: ContentClass[]): ContentClass[] {
  const event: RuntimeEvent = {
    eventId: newId(),
    provider: "openmausbot",
    threadId: audit.threadId,
    createdAt: new Date().toISOString(),
    type: "content.class-passed",
    classes,
    funnel: audit.funnel,
    botId: audit.botId,
  };
  const sink: AuditSink = auditSink ?? ((line) => {
    const file = join(EVENTS_DIR, `${line.threadId}.ndjson`);
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    capThreadLog(file, currentThreadLogCap());
  });
  try {
    sink(event);
    return [];
  } catch (error) {
    // The escape hatch is only as good as its audit: when the record
    // cannot be written the loosened class is enforced instead, so
    // content never flows past this boundary unaudited.
    console.error("content boundary: audit write failed; enforcing loosened classes", error);
    return classes;
  }
}

/** Apply class redaction to text that has already been through the
 * credential scrub (the store's message walk scrubs first). */
export function applyContentClasses(text: string, classes: ContentClass[] | undefined, audit: ContentBoundaryAudit): string {
  if (!classes) return text;
  const result = redactContentClasses(text, classes);
  if (result.passed.length && auditContentClassPass(audit, result.passed).length) {
    // The audit write failed: re-run with the loosened classes enforced,
    // idempotently, so nothing passes this boundary unaudited.
    return redactContentClasses(result.text, [...new Set([...classes, ...result.passed])]).text;
  }
  return result.text;
}

/** The full boundary for raw tool output: credentials always, then the
 * configured classes, auditing whatever a loosened class let through. */
export function redactForContentPolicy(text: string, classes: ContentClass[] | undefined, audit: ContentBoundaryAudit): string {
  return applyContentClasses(redactSecretsInText(text), classes, audit);
}

// workspace.ts is botId-addressed and must not import the store; index.ts
// binds this resolver at boot (the bindThreadLogCapProvider pattern), so a
// bot PATCH applies to the next write without a restart.
export interface WorkspaceContentPolicy {
  classes?: ContentClass[];
  threadId?: string;
}

let workspacePolicy: (botId: string) => WorkspaceContentPolicy | null = () => null;

export function bindWorkspaceContentPolicy(provider: (botId: string) => WorkspaceContentPolicy | null): void {
  workspacePolicy = provider;
}

/** The workspace write funnels' redaction call: today's secret scrub plus
 * the bot's configured classes. Audited to the thread the policy names —
 * memory is bot-scoped, so that is the bot's own conversation log. */
export function redactWorkspaceText(botId: string, text: string): string {
  const policy = workspacePolicy(botId);
  if (!policy?.classes) return redactSecretsInText(text);
  const threadId = policy.threadId ?? botId;
  return applyContentClasses(redactSecretsInText(text), policy.classes, { botId, threadId, funnel: "memory" });
}

