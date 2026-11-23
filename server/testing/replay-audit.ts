import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function readReplayAudit(dataDir: string) {
  const path = join(dataDir, "replay-safety.db");
  if (!existsSync(path)) return { attempts: [], actions: [], decisions: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      attempts: db.prepare("SELECT id,generation,thread,configuredInstance,configuredModel,servingModel,evidence,outcome,quota,site FROM replay_attempts").all(),
      actions: db.prepare("SELECT id,action,generation,kind,status,receipt,providerReceipt FROM replay_actions").all(),
      decisions: db.prepare("SELECT id,generation,site,decision FROM replay_decisions").all(),
    };
  } finally { db.close(); }
}
