// Private receipts for the OpenMausBot instruction sections an ACP native
// session has accepted. The receipt contains no prompt text and is keyed by
// the complete provider/session identity so two bots cannot share state.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";
import type { PromptSection } from "../../system-prompt.ts";

const RECEIPT_VERSION = 1 as const;
const RECEIPTS_DIR = join(DATA_DIR, "acp-instructions");

/** A persisted ACP instruction receipt. Only section identities and hashes
 * are retained; prompt content stays in the provider session and workspace. */
export type AcpInstructionReceipt = {
  version: typeof RECEIPT_VERSION;
  sections: Array<{ id: string; hash: string }>;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Hash one section's UTF-8 text for comparison across turns. */
export function acpInstructionSectionHash(text: string): string {
  return digest(text);
}

/** Return the private receipt path for one provider/native-session tuple. */
export function acpInstructionReceiptPath(
  providerInstanceId: string,
  botId: string,
  threadId: string,
  nativeSessionId: string,
): string {
  const key = JSON.stringify([providerInstanceId, botId, threadId, nativeSessionId]);
  return join(RECEIPTS_DIR, `${digest(key)}.json`);
}

/** Read an ACP instruction receipt, treating a missing or malformed receipt
 * as unknown so a resumed session receives a complete replacement block. */
export function readAcpInstructionReceipt(
  providerInstanceId: string,
  botId: string,
  threadId: string,
  nativeSessionId: string,
): AcpInstructionReceipt | undefined {
  const path = acpInstructionReceiptPath(providerInstanceId, botId, threadId, nativeSessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as { version?: unknown; sections?: unknown };
  if (value.version !== RECEIPT_VERSION || !Array.isArray(value.sections)) return undefined;
  const sections: Array<{ id: string; hash: string }> = [];
  const ids = new Set<string>();
  for (const entry of value.sections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const section = entry as { id?: unknown; hash?: unknown };
    if (typeof section.id !== "string" || typeof section.hash !== "string" ||
        !section.id || !/^[0-9a-f]{64}$/u.test(section.hash) || ids.has(section.id)) return undefined;
    ids.add(section.id);
    sections.push({ id: section.id, hash: section.hash });
  }
  return { version: RECEIPT_VERSION, sections };
}

/** Commit the section hashes after the provider has returned a protocol
 * result for `session/prompt`. Callers must not call this before acceptance is
 * known. */
export function writeAcpInstructionReceipt(
  providerInstanceId: string,
  botId: string,
  threadId: string,
  nativeSessionId: string,
  sections: readonly PromptSection[],
): void {
  const receipt: AcpInstructionReceipt = {
    version: RECEIPT_VERSION,
    sections: sections.map((section) => ({ id: section.id, hash: acpInstructionSectionHash(section.text) })),
  };
  mkdirSync(RECEIPTS_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    acpInstructionReceiptPath(providerInstanceId, botId, threadId, nativeSessionId),
    `${JSON.stringify(receipt)}\n`,
    { mode: 0o600 },
  );
}

/** Remove a private receipt when its owning room/thread is deleted. Missing
 * files and cleanup races are both harmless. */
export function deleteAcpInstructionReceipt(
  providerInstanceId: string,
  botId: string,
  threadId: string,
  nativeSessionId: string,
): void {
  try {
    unlinkSync(acpInstructionReceiptPath(providerInstanceId, botId, threadId, nativeSessionId));
  } catch {
    // A receipt is an optimization cache, never a deletion failure.
  }
}
