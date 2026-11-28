import type { RoutineRunTrigger } from "../shared/routines.ts";
import type { MessageOrigin } from "../shared/wire.ts";

/** What the server itself knows about how it accepted a user line. None of it is read from a client body. */
export interface OriginEvidence {
  via?: "api" | "call";
  relayed?: boolean;
  peerAsk?: unknown;
  aside?: boolean;
  from?: unknown;
  fromApp?: unknown;
  automated?: boolean;
  automationSource?: RoutineRunTrigger;
  commsDepth?: number;
  coordination?: boolean;
}

/** The line as stored: a user line without an origin gets the one the server's evidence gives it, while a line that
 * already carries one keeps it and bot lines get none. */
export function withOrigin<T extends OriginEvidence & { role?: string; origin?: MessageOrigin }>(message: T): T {
  return message.role === "user" && message.origin === undefined ? { ...message, origin: inputOrigin(message) } : message;
}

export function inputOrigin(evidence: OriginEvidence): MessageOrigin {
  if (evidence.via === "api" || evidence.automationSource === "api") return "api";
  if (evidence.relayed || evidence.automationSource === "webhook" || evidence.fromApp) return "integration";
  if (evidence.peerAsk || evidence.aside || evidence.from || (evidence.commsDepth ?? 0) > 0 || evidence.coordination) return "bot";
  if (evidence.automationSource) return "routine";
  if (evidence.via === "call") return "client";
  if (evidence.automated) return "unknown";
  return "client";
}
