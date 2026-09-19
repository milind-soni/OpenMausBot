// Peer-agent comms wiring, extracted from index.ts. Bearer capabilities
// are minted for exactly one provider-turn generation and revoked on the
// exact terminal paths; the two bearer predicates stay in index.ts because
// the active-check also reads the team-computer turn table and the local-VM
// lease pool, which are still index-local there.
import { randomBytes, randomUUID } from "node:crypto";

import { type RuntimeEvent } from "./contracts.ts";
import type { InternalCapability } from "./routes/internal.ts";
import type { Message } from "./store.ts";
import type { Surface } from "./surface.ts";
import { ProviderTurnGenerationRegistry } from "./turn-dispatch-guard.ts";

// ── peer-agent comms wiring ────────────────────────────────────────────
// A capability lives for the exact provider-turn generation, including while
// that turn is parked on a human approval. The long ceiling is only an orphan
// backstop for an impossible-to-settle adapter; normal terminal paths revoke
// synchronously and app restart destroys this in-memory set.
const INTERNAL_CAPABILITY_ORPHAN_MS = 30 * 24 * 60 * 60_000;
export const internalCapabilities = new Map<string, InternalCapability>();
export const activeInternalGenerationByThread = new Map<string, string>();
const internalGenerationByProviderTurn = new ProviderTurnGenerationRegistry();
export const computerSelectionTurns = new Map<string, {
  generation: string;
  botId: string;
  source: Message;
  text: string;
  mounted?: Surface;
  selected?: Surface;
  previousSurface?: Surface;
}>();

export function beginInternalCapabilityGeneration(threadId: string, generation = randomUUID()): string {
  const previous = activeInternalGenerationByThread.get(threadId);
  if (previous) revokeInternalCapabilityGeneration(threadId, previous);
  activeInternalGenerationByThread.set(threadId, generation);
  return generation;
}

export function mintInternalCapability(capability: Omit<InternalCapability, "orphanExpiresAt">): string {
  if (activeInternalGenerationByThread.get(capability.threadId) !== capability.generation) {
    throw new Error("cannot mint an integration capability for an inactive turn");
  }
  const token = randomBytes(24).toString("hex");
  internalCapabilities.set(token, {
    ...capability,
    orphanExpiresAt: Date.now() + INTERNAL_CAPABILITY_ORPHAN_MS,
  });
  return token;
}

export function revokeInternalCapabilityGeneration(threadId: string, generation: string): void {
  for (const [token, capability] of internalCapabilities) {
    if (capability.threadId === threadId && capability.generation === generation) {
      internalCapabilities.delete(token);
    }
  }
  if (activeInternalGenerationByThread.get(threadId) === generation) {
    activeInternalGenerationByThread.delete(threadId);
  }
  internalGenerationByProviderTurn.deleteGeneration(threadId, generation);
}

export function revokeInternalCapabilitiesForThread(threadId: string): void {
  computerSelectionTurns.delete(threadId);
  const generation = activeInternalGenerationByThread.get(threadId);
  if (generation) revokeInternalCapabilityGeneration(threadId, generation);
  // Defensive cleanup for any generation orphaned before exact ownership was
  // introduced. This force variant is used only by explicit stop/delete and
  // before a brand-new generation is published, never by a stale async catch.
  for (const [token, capability] of internalCapabilities) {
    if (capability.threadId === threadId) internalCapabilities.delete(token);
  }
}

export function revokeAllInternalCapabilities(): void {
  computerSelectionTurns.clear();
  internalCapabilities.clear();
  activeInternalGenerationByThread.clear();
  internalGenerationByProviderTurn.clear();
}

export function bindInternalCapabilityToProviderTurn(threadId: string, generation: string, turnId?: string): void {
  if (turnId && !internalGenerationByProviderTurn.bind(threadId, generation, turnId)) {
    revokeInternalCapabilityGeneration(threadId, generation);
  }
}

export function revokeInternalCapabilityForProviderEvent(event: RuntimeEvent): void {
  if (!event.turnId) return;
  const owner = internalGenerationByProviderTurn.complete(event.threadId, event.turnId);
  if (!owner) return;
  revokeInternalCapabilityGeneration(owner.threadId, owner.generation);
}
