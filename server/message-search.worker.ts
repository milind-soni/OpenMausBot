import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { searchMessagesInDatabase } from "./message-search-query.ts";

// Closing after each scan keeps no old database inode open across a workspace restore.
parentPort!.on("message", (request: { id: number; query: string; limit: number; threadId?: string }) => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(workerData.file, { readOnly: true });
    const hits = searchMessagesInDatabase(db, request.query, request.limit, request.threadId);
    parentPort!.postMessage({ id: request.id, hits });
  } catch {
    // Database errors can contain private paths or query text.
    parentPort!.postMessage({ id: request.id, failed: true });
  } finally {
    db?.close();
  }
});
