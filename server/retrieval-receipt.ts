import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { OpenMausRetrievalReceipt } from "./retrieval.ts";

export type FinalizedOpenMausRetrievalReceipt = Omit<OpenMausRetrievalReceipt, "native_dispatch_proof"> & {
  native_dispatch_proof: NonNullable<OpenMausRetrievalReceipt["native_dispatch_proof"]>;
};

interface RetrievalDispatchBinding {
  instanceId: string;
  driverKind: string;
  model: string;
  context: string;
}

export type RetrievalDispatchOutcome = RetrievalDispatchBinding & (
  | { status: "accepted"; turnId: string }
  | { status: "failed"; failureStage: "before-adapter" | "adapter-rejected" }
);

export interface StoredRetrievalReceipt {
  schema: "openmaus.retrieval-receipt-record.v1";
  recorded_at: string;
  receipt: FinalizedOpenMausRetrievalReceipt;
}

function identityDigest(receipt: OpenMausRetrievalReceipt): string {
  const proof = receipt.native_session_proof;
  return createHash("sha256")
    .update(proof.botId)
    .update("\0")
    .update(proof.threadId)
    .update("\0")
    .update(proof.taskId)
    .digest("hex");
}

export function retrievalReceiptPath(
  dataDir: string,
  receipt: OpenMausRetrievalReceipt,
  dispatchId: string,
): string {
  const dispatchDigest = createHash("sha256")
    .update(JSON.stringify(receipt.native_dispatch_proof))
    .update("\0")
    .update(dispatchId)
    .digest("hex");
  return join(dataDir, "retrieval-receipts", `${identityDigest(receipt)}-${dispatchDigest}.json`);
}

/** Bind a retrieval outcome to the exact native adapter dispatch without
 * retaining the context itself. The session identity comes from the request
 * receipt so callers cannot accidentally bind one bot's evidence to another
 * bot's turn. */
export function finalizeRetrievalReceipt(
  receipt: OpenMausRetrievalReceipt,
  dispatch: RetrievalDispatchOutcome,
): FinalizedOpenMausRetrievalReceipt {
  const session = receipt.native_session_proof;
  const contextBytes = Buffer.byteLength(dispatch.context, "utf8");
  const contextSha256 = `sha256:${createHash("sha256").update(dispatch.context, "utf8").digest("hex")}`;
  return {
    ...receipt,
    native_session_proof: { ...session },
    native_dispatch_proof: {
      status: dispatch.status,
      botId: session.botId,
      threadId: session.threadId,
      taskId: session.taskId,
      instanceId: dispatch.instanceId,
      driverKind: dispatch.driverKind,
      model: dispatch.model,
      turnId: dispatch.status === "accepted" ? dispatch.turnId : null,
      contextBytes,
      contextSha256,
      failureStage: dispatch.status === "failed" ? dispatch.failureStage : null,
    },
  };
}

/** Persist only bounded receipt metadata. Retrieval queries and excerpts are
 * deliberately absent, and an unavailable receipt sink must never block a
 * model turn. */
export function recordRetrievalReceipt(
  dataDir: string,
  receipt: FinalizedOpenMausRetrievalReceipt,
  now: Date = new Date(),
): string | null {
  try {
    const directory = join(dataDir, "retrieval-receipts");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = retrievalReceiptPath(dataDir, receipt, randomUUID());
    const record: StoredRetrievalReceipt = {
      schema: "openmaus.retrieval-receipt-record.v1",
      recorded_at: now.toISOString(),
      receipt: {
        schema: receipt.schema,
        automatic_retrieval_active: receipt.automatic_retrieval_active,
        windows_served: receipt.windows_served,
        generation_identity: receipt.generation_identity,
        fallback_path: receipt.fallback_path,
        skip_reason: receipt.skip_reason,
        accepted_hits: receipt.accepted_hits,
        native_session_proof: { ...receipt.native_session_proof },
        native_dispatch_proof: { ...receipt.native_dispatch_proof },
      },
    };
    writeFileAtomic(path, JSON.stringify(record, null, 2), { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}
