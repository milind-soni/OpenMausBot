import { join } from "node:path";

import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { FIRST_MILESTONE_DEFAULTS, OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { openCollaborationLedger, type CollaborationLedger, type DatabaseHealth } from "./db.ts";
import { InboundMessageProcessor, type InboundMessageOutcome } from "./inbound.ts";
import type { CollaborationOutboxEntry } from "./outbox.ts";

export interface CollaborationHealth {
  app: "openmausbot-collaboration";
  status: "healthy";
  ready: true;
  sourceBaseline: typeof OPENMAUSBOT_SOURCE_BASELINE;
  authority: "headless";
  database: DatabaseHealth;
  defaults: typeof FIRST_MILESTONE_DEFAULTS;
}

export interface CollaborationService {
  health(): CollaborationHealth;
  ingestDingTalkMessage(message: DingTalkInboundMessage): InboundMessageOutcome;
  pendingOutbox(): CollaborationOutboxEntry[];
  close(): void;
}

export interface CollaborationServiceOptions {
  dataDirectory: string;
}

export function startCollaborationService(options: CollaborationServiceOptions): CollaborationService {
  const ledger: CollaborationLedger = openCollaborationLedger(join(options.dataDirectory, "collaboration"));
  let inbound: InboundMessageProcessor;
  try {
    inbound = new InboundMessageProcessor(ledger.filePath);
  } catch (error) {
    ledger.close();
    throw error;
  }
  let closed = false;

  return {
    health() {
      if (closed) throw new Error("Collaboration service is closed");
      return {
        app: "openmausbot-collaboration",
        status: "healthy",
        ready: true,
        sourceBaseline: OPENMAUSBOT_SOURCE_BASELINE,
        authority: "headless",
        database: ledger.databaseHealth(),
        defaults: FIRST_MILESTONE_DEFAULTS,
      };
    },
    ingestDingTalkMessage(message) {
      if (closed) throw new Error("Collaboration service is closed");
      return inbound.processDingTalkMessage(message);
    },
    pendingOutbox() {
      if (closed) throw new Error("Collaboration service is closed");
      return inbound.pendingOutbox();
    },
    close() {
      if (closed) return;
      closed = true;
      inbound.close();
      ledger.close();
    },
  };
}
