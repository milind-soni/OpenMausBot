import { parentPort, workerData } from "node:worker_threads";
import { userErrorFields } from "./user-errors.ts";
import { createWorkspaceBackupSnapshot, type CreateWorkspaceBackupOptions } from "./workspace-backup.ts";

const { dataDir, options, jobId } = workerData as { dataDir: string; options: CreateWorkspaceBackupOptions; jobId: string };
try {
  // Never send the password or options back.
  parentPort!.postMessage({ result: await createWorkspaceBackupSnapshot(dataDir, options, jobId) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : "The workspace backup could not finish.", ...userErrorFields(error) });
}
