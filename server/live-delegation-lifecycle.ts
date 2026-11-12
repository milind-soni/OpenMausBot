import type { LiveProvider } from "../shared/wire.ts";
import type { LiveSocket } from "./live-socket.ts";
import type { Message } from "./store.ts";

interface DelegationRefs {
  endpoint: { provider: LiveProvider };
  socket: LiveSocket | null;
  activeDelegation: string | null;
  pendingDelegations: Set<string>;
  requestDelegations: Map<string, string>;
  queueDelegations: Map<string, string>;
  requestAliases: Map<string, Set<string>>;
  pendingCall: Set<string>;
  queuedIds: Set<string>;
  typedTexts: Map<string, string>;
  batches: Map<string, string[]>;
  drainBatch: string[] | null;
}

export function releaseDelegations(call: DelegationRefs, ids: Iterable<string | undefined>): void {
  if (call.endpoint.provider !== "qwen") return;
  const retained = new Set([...call.pendingDelegations, ...call.requestDelegations.values(), ...call.queueDelegations.values()]);
  for (const id of new Set(ids)) {
    if (!id || retained.has(id)) continue;
    call.socket?.releaseDelegation?.(id);
    if (call.activeDelegation === id) call.activeDelegation = null;
  }
}

export function finishDelegation(call: DelegationRefs, id: string): void {
  call.pendingDelegations.delete(id);
  releaseDelegations(call, [id]);
}

export function linkSteeredRequests(call: DelegationRefs, messageId: string, requestId: string): void {
  const aliases = new Set([messageId, requestId, ...call.requestAliases.get(messageId) ?? [], ...call.requestAliases.get(requestId) ?? []]);
  for (const id of aliases) call.requestAliases.set(id, aliases);
}

export function answerBatch(call: DelegationRefs, request: string | undefined): string[] {
  const batchFor = (id: string) => call.batches.get(id)
    ?? (call.endpoint.provider === "qwen" ? [...call.batches.values()].find(batch => batch.includes(id)) : undefined) ?? [id];
  const batch = request === undefined ? [] : batchFor(request);
  if (call.endpoint.provider !== "qwen") return batch;
  const ids = new Set(batch);
  for (const id of ids) {
    for (const linked of [...batchFor(id), ...call.requestAliases.get(id) ?? []]) ids.add(linked);
  }
  return [...ids];
}

export function settleRequests(call: DelegationRefs, batch: readonly string[]): Array<string | undefined> {
  const delegations = batch.map(id => call.requestDelegations.get(id));
  for (const id of batch) {
    call.pendingCall.delete(id);
    call.typedTexts.delete(id);
    call.batches.delete(id);
    call.requestDelegations.delete(id);
    call.requestAliases.delete(id);
  }
  return delegations;
}

export function trackDrain(call: DelegationRefs, message: Message): void {
  if (message.role !== "user" || message.kind !== "text" || !message.queueId) {
    call.drainBatch = null;
    return;
  }
  call.drainBatch ??= [];
  call.drainBatch.push(message.id);
  call.batches.set(message.id, call.drainBatch);
  if (call.batches.size > 200) call.batches.delete(call.batches.keys().next().value!);
}

export function forgetUnqueued(call: DelegationRefs, queued: (id: string) => boolean): void {
  for (const queueId of call.queuedIds) {
    if (queued(queueId)) continue;
    call.queuedIds.delete(queueId);
    const id = call.queueDelegations.get(queueId);
    call.queueDelegations.delete(queueId);
    releaseDelegations(call, [id]);
  }
}
