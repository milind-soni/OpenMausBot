import { join } from "node:path";

import { FIRST_MILESTONE_DEFAULTS, OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { openCollaborationLedger, type CollaborationLedger, type DatabaseHealth } from "./db.ts";

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
  close(): void;
}

export interface CollaborationServiceOptions {
  dataDirectory: string;
}

export function startCollaborationService(options: CollaborationServiceOptions): CollaborationService {
  const ledger: CollaborationLedger = openCollaborationLedger(join(options.dataDirectory, "collaboration"));
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
    close() {
      if (closed) return;
      closed = true;
      ledger.close();
    },
  };
}
