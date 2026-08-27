import { join } from "node:path";

import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { FIRST_MILESTONE_DEFAULTS, OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { openCollaborationLedger, type CollaborationLedger, type DatabaseHealth } from "./db.ts";
import { InboundMessageProcessor, type InboundMessageOutcome } from "./inbound.ts";
import type { CollaborationOutboxEntry } from "./outbox.ts";
import {
  PlanningCoordinator,
  type DefinitionRevisionOutcome,
  type PlanningCoordinatorOptions,
} from "./plan-reviser.ts";
import type { WorkItemSnapshotPatch } from "./snapshot.ts";

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
  reviseWorkItemDefinition(
    workItemId: string,
    patch: WorkItemSnapshotPatch,
    now?: number,
  ): DefinitionRevisionOutcome;
  pendingOutbox(): CollaborationOutboxEntry[];
  close(): void;
}

export interface CollaborationServiceOptions {
  dataDirectory: string;
  planning?: PlanningCoordinatorOptions;
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
  let planning: PlanningCoordinator | null = null;
  try {
    planning = options.planning ? new PlanningCoordinator(ledger.filePath, options.planning) : null;
  } catch (error) {
    inbound.close();
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
      const outcome = inbound.processDingTalkMessage(message);
      if (planning && outcome.workItemId) {
        planning.observeAcceptedEvent(outcome.workItemId, message.text, message.receivedAt);
      }
      return outcome;
    },
    reviseWorkItemDefinition(workItemId, patch, now) {
      if (closed) throw new Error("Collaboration service is closed");
      if (!planning) throw new Error("Collaboration planning is not configured");
      return planning.reviseDefinition(workItemId, patch, now);
    },
    pendingOutbox() {
      if (closed) throw new Error("Collaboration service is closed");
      return inbound.pendingOutbox();
    },
    close() {
      if (closed) return;
      closed = true;
      planning?.close();
      inbound.close();
      ledger.close();
    },
  };
}
