import { join } from "node:path";

import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import {
  OwnerActionController,
  type IssueOwnerActionInput,
  type IssuedOwnerAction,
  type OwnerActionOutcome,
  type PerformOwnerActionInput,
} from "./actions.ts";
import { FIRST_MILESTONE_DEFAULTS, OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { openCollaborationLedger, type CollaborationLedger, type DatabaseHealth } from "./db.ts";
import { InboundMessageProcessor, type InboundMessageOutcome } from "./inbound.ts";
import {
  CandidateExecutor,
  type CandidateExecutionOutcome,
  type CandidateExecutorOptions,
} from "./executor.ts";
import type { CollaborationOutboxEntry } from "./outbox.ts";
import {
  PlanningCoordinator,
  type DefinitionRevisionOutcome,
  type PlanningCoordinatorOptions,
} from "./plan-reviser.ts";
import { LocalOwnerRegistry, type OwnerBinding } from "./owner.ts";
import type { WorkItemSnapshotPatch } from "./snapshot.ts";

export interface CollaborationHealth {
  app: "openmausbot-collaboration";
  status: "healthy" | "degraded";
  ready: boolean;
  sourceBaseline: typeof OPENMAUSBOT_SOURCE_BASELINE;
  authority: "headless";
  database: DatabaseHealth;
  defaults: typeof FIRST_MILESTONE_DEFAULTS;
  degradation?: { reason: string; lowDisk: boolean };
  executionGated?: "low_disk";
}

export interface CollaborationService {
  health(): CollaborationHealth;
  ingestDingTalkMessage(message: DingTalkInboundMessage): InboundMessageOutcome;
  reviseWorkItemDefinition(
    workItemId: string,
    patch: WorkItemSnapshotPatch,
    now?: number,
  ): DefinitionRevisionOutcome;
  executeCurrentPlan(workItemId: string, attempt?: number, now?: number): Promise<CandidateExecutionOutcome>;
  ownerBinding(): OwnerBinding | null;
  bootstrapOwnerLocally(input: { senderCorpId: string; senderStaffId: string; now?: number }): OwnerBinding;
  recoverOwnerLocally(input: {
    expectedGeneration: number;
    senderCorpId: string;
    senderStaffId: string;
    now?: number;
  }): OwnerBinding;
  issueOwnerAction(input: IssueOwnerActionInput): IssuedOwnerAction;
  performOwnerAction(input: PerformOwnerActionInput): OwnerActionOutcome;
  pendingOutbox(): CollaborationOutboxEntry[];
  close(): void;
}

export interface CollaborationServiceOptions {
  dataDirectory: string;
  planning?: PlanningCoordinatorOptions;
  execution?: CandidateExecutorOptions;
}

function isSqliteFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code.startsWith("ERR_SQLITE") || code.startsWith("SQLITE_");
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
  let execution: CandidateExecutor | null = null;
  try {
    execution = options.execution ? new CandidateExecutor(ledger.filePath, options.execution) : null;
  } catch (error) {
    planning?.close();
    inbound.close();
    ledger.close();
    throw error;
  }
  let owner: LocalOwnerRegistry;
  let actions: OwnerActionController;
  try {
    owner = new LocalOwnerRegistry(ledger.filePath);
    actions = new OwnerActionController(ledger.filePath);
  } catch (error) {
    execution?.close();
    planning?.close();
    inbound.close();
    ledger.close();
    throw error;
  }
  let closed = false;
  let serviceDegradedReason: "ledger_unwritable" | "audit_unwritable" | null = null;

  return {
    health() {
      if (closed) throw new Error("Collaboration service is closed");
      const readiness = execution?.readiness();
      const degraded = serviceDegradedReason !== null || readiness?.mode === "degraded";
      return {
        app: "openmausbot-collaboration",
        status: degraded ? "degraded" : "healthy",
        ready: !degraded,
        sourceBaseline: OPENMAUSBOT_SOURCE_BASELINE,
        authority: "headless",
        database: ledger.databaseHealth(),
        defaults: FIRST_MILESTONE_DEFAULTS,
        ...(degraded
          ? {
              degradation: {
                reason: serviceDegradedReason ?? readiness?.reason ?? "unknown",
                lowDisk: readiness?.lowDisk ?? false,
              },
            }
          : {}),
        ...(readiness?.lowDisk ? { executionGated: "low_disk" as const } : {}),
      };
    },
    ingestDingTalkMessage(message) {
      if (closed) throw new Error("Collaboration service is closed");
      try {
        const outcome = inbound.processDingTalkMessage(message);
        if (planning && outcome.workItemId) {
          planning.observeAcceptedEvent(outcome.workItemId, message.text, message.receivedAt);
        }
        return outcome;
      } catch (error) {
        if (isSqliteFailure(error)) serviceDegradedReason = "ledger_unwritable";
        throw error;
      }
    },
    reviseWorkItemDefinition(workItemId, patch, now) {
      if (closed) throw new Error("Collaboration service is closed");
      if (!planning) throw new Error("Collaboration planning is not configured");
      return planning.reviseDefinition(workItemId, patch, now);
    },
    async executeCurrentPlan(workItemId, attempt, now) {
      if (closed) throw new Error("Collaboration service is closed");
      if (!execution) throw new Error("Collaboration execution is not configured");
      return await execution.executeCurrentPlan(workItemId, attempt, now);
    },
    ownerBinding() {
      if (closed) throw new Error("Collaboration service is closed");
      return owner.active();
    },
    bootstrapOwnerLocally(input) {
      if (closed) throw new Error("Collaboration service is closed");
      return owner.bootstrap(input);
    },
    recoverOwnerLocally(input) {
      if (closed) throw new Error("Collaboration service is closed");
      return owner.recover(input);
    },
    issueOwnerAction(input) {
      if (closed) throw new Error("Collaboration service is closed");
      try {
        return actions.issue(input);
      } catch (error) {
        if (isSqliteFailure(error)) serviceDegradedReason = "audit_unwritable";
        throw error;
      }
    },
    performOwnerAction(input) {
      if (closed) throw new Error("Collaboration service is closed");
      try {
        return actions.perform(input);
      } catch (error) {
        if (isSqliteFailure(error)) serviceDegradedReason = "audit_unwritable";
        throw error;
      }
    },
    pendingOutbox() {
      if (closed) throw new Error("Collaboration service is closed");
      return inbound.pendingOutbox();
    },
    close() {
      if (closed) return;
      closed = true;
      actions.close();
      owner.close();
      execution?.close();
      planning?.close();
      inbound.close();
      ledger.close();
    },
  };
}
