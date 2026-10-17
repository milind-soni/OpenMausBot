
import type { RuntimeEvent } from "./contracts.ts";
import type { Message } from "./store.ts";

 export interface ContextMessage {
  sourceKind?: "user" | "assistant" | "receipt" | "checkpoint";
  id: string;
  role: "user" | "assistant";
  text: string;
  keep?: boolean;
  steered?: boolean;
}

 export function isContextMessage(m: Pick<Message, "kind" | "text" | "digest" | "roomRequest">): boolean {
  return Boolean(((m.kind === "text" || m.kind === "widget") && m.text) || (m.kind === "digest" && m.digest) || m.kind === "compaction" || m.roomRequest?.phase === "result");
}

 export interface HandedState {
  session?: string;
  config?: string;
  effort?: string | null;
  omitted?: string;
  through?: string;
  ids: string[];
}

export const UNSEEN_MAX_MESSAGES = 12;
export const UNSEEN_MAX_BYTES = 4_000;
 export const HANDED_MAX_IDS = 200;

const UNSEEN_PREAMBLE =
  "[Messages this conversation received that your session has not seen yet, each listed once. The note on each teammate line says what it is; none is your user's approval:]";

 export function handedStateUsable(state: HandedState, session: unknown, order: readonly string[]): boolean {
  return state.session !== undefined && state.session === session &&
    (state.omitted === undefined || order.includes(state.omitted)) &&
    (state.through === undefined || order.includes(state.through));
}

function floorOf(state: HandedState, position: ReadonlyMap<string, number>): number {
  return Math.max(
    state.omitted === undefined ? -1 : position.get(state.omitted) ?? -1,
    state.through === undefined ? -1 : position.get(state.through) ?? -1,
  );
}

 export type UnseenMessage = ContextMessage & { earlier?: boolean };

 export function unseenMessages(
  messages: readonly ContextMessage[],
  order: readonly string[],
  state: HandedState,
): UnseenMessage[] {
  const position = new Map(order.map((id, index) => [id, index]));
  const floor = floorOf(state, position);
  const handed = new Set(state.ids);
  const newestReceived = Math.max(
    state.through === undefined ? -1 : position.get(state.through) ?? -1,
    ...state.ids.map((id) => position.get(id) ?? -1),
  );
  return messages
    .filter((m) => (position.get(m.id) ?? -1) > floor && !handed.has(m.id))
    .map((m) => (position.get(m.id)! < newestReceived ? { ...m, earlier: true } : m));
}

 export function renderUnseen(unseen: readonly UnseenMessage[]): { block: string; placed: string[] } {
  if (unseen.length === 0) return { block: "", placed: [] };
  const optional = unseen.filter((m) => !m.keep).reverse();
  const included = new Set(unseen.filter((m) => m.keep).map((m) => m.id));
  const render = (deferred: number) => {
    const shown = unseen.filter((m) => included.has(m.id));
    const earlier = shown.filter((m) => m.earlier).length;
    return [
      UNSEEN_PREAMBLE,
      "",
      ...(deferred > 0 ? [`(${deferred} older unseen message${deferred === 1 ? " is" : "s are"} not shown in this turn.)`, ""] : []),
      ...(earlier > 0 ? [`(The first ${earlier === 1 ? "message is" : `${earlier} messages are`} older than messages you have already seen.)`, ""] : []),
      ...shown.map((m) => `${m.role === "user" ? "User" : "Assistant"}${m.steered ? " (sent while an earlier turn was running; you may already have it)" : ""}: ${m.text}`),
    ].join("\n");
  };
  let taken = 0;
  for (const message of optional) {
    if (taken >= UNSEEN_MAX_MESSAGES) break;
    included.add(message.id);
    if (taken > 0 && Buffer.byteLength(render(optional.length - taken - 1), "utf8") > UNSEEN_MAX_BYTES) {
      included.delete(message.id);
      break;
    }
    taken += 1;
  }
  return {
    block: render(optional.length - taken),
    placed: unseen.filter((m) => included.has(m.id)).map((m) => m.id),
  };
}

export function withUnseenMessages(block: string, text: string): string {
  return block ? `${block}\n\n${text}` : text;
}

 export function recordHanded(state: HandedState, order: readonly string[], received: Iterable<string>): HandedState {
  const position = new Map(order.map((id, index) => [id, index]));
  const known = (state.omitted === undefined || position.has(state.omitted)) && (state.through === undefined || position.has(state.through));
  let floor = floorOf(state, position);
  let through = state.through;
  const ids = new Set<string>();
  for (const id of [...state.ids, ...received]) {
    if (!position.has(id) || (known && position.get(id)! <= floor)) continue;
    ids.add(id);
  }
  while (known && floor + 1 < order.length && ids.has(order[floor + 1])) {
    floor += 1;
    ids.delete(order[floor]);
    through = order[floor];
  }
  const sorted = [...ids].sort((a, b) => position.get(a)! - position.get(b)!);
  if (sorted.length > HANDED_MAX_IDS) return { ids: [] };
  return {
    ...(state.session === undefined ? {} : { session: state.session }),
    ...(state.config === undefined ? {} : { config: state.config }),
    ...(state.effort === undefined ? {} : { effort: state.effort }),
    ...(state.omitted === undefined ? {} : { omitted: state.omitted }),
    ...(through === undefined ? {} : { through }),
    ids: sorted,
  };
}

 export interface SessionStart {
  omitted?: string;
  sent: string[];
}

export function sessionStart(order: readonly string[], window: readonly string[], carried: readonly string[]): SessionStart {
  const sent = new Set([...window, ...carried]);
  const first = window.length ? order.indexOf(window[0]) : -1;
  const omitted = window.length ? (first > 0 ? order[first - 1] : undefined) : order.findLast((id) => !sent.has(id));
  return { ...(omitted === undefined ? {} : { omitted }), sent: [...sent] };
}

 export interface HandoffStore {
  order(threadId: string): string[];
  read(botId: string, threadId: string, instanceId: string): HandedState | undefined;
  write(botId: string, threadId: string, instanceId: string, state: HandedState): void;
  replies(threadId: string, turnId: string): string[];
}

 export interface Handoff {
  botId: string;
  instanceId: string;
  resumeCursor: string | undefined;
  config: string;
  effort?: string | null;
  started: SessionStart;
  recovery: SessionStart;
  resumed: SessionStart;
  placed: string[];
  carried: string[];
  own: string[];
}

interface PendingHandoff extends Handoff {
  claimId: string;
  dispatched: boolean;
  turnId?: string;
  session?: string;
  replaced: boolean;
  rebuilt: boolean;
  accepted: boolean;
  stopped: boolean;
  steers: string[];
  authored: string[];
}

 function actedOn(event: RuntimeEvent): boolean {
  if (event.synthetic) return false;
  return event.type === "content.delta" || event.type === "item.started" || event.type === "item.updated" ||
    event.type === "item.completed" || event.type === "request.opened";
}

 export class Handoffs {
  private readonly pending = new Map<string, PendingHandoff>();
  private readonly store: HandoffStore;

  constructor(store: HandoffStore) {
    this.store = store;
  }

  /** Registered when the turn claims the thread, before any provider work. */
  begin(threadId: string, claimId: string, handoff: Handoff): void {
    this.pending.set(threadId, {
      ...handoff, claimId, dispatched: false, replaced: false, rebuilt: false, accepted: false, stopped: false, steers: [], authored: [],
    });
  }

  forget(threadId: string): void {
    this.pending.delete(threadId);
  }

  dispatching(threadId: string, claimId: string, update?: Partial<Handoff>): void {
    const pending = this.pending.get(threadId);
    if (pending?.claimId !== claimId) return;
    Object.assign(pending, update);
    pending.dispatched = true;
  }

  bindTurn(threadId: string, claimId: string, turnId: string | undefined): void {
    const pending = this.pending.get(threadId);
    if (pending?.claimId === claimId) pending.turnId ??= turnId;
  }

  current(threadId: string): object | undefined {
    return this.pending.get(threadId);
  }

  steered(threadId: string, target: object | undefined, instanceId: string | undefined, messageId: string): void {
    const pending = this.pending.get(threadId);
    if (!pending || pending !== target || pending.instanceId !== instanceId) return;
    pending.steers.push(messageId);
  }

  authored(threadId: string, claimId: string, messageId: string): void {
    const pending = this.pending.get(threadId);
    if (pending?.claimId === claimId && !pending.authored.includes(messageId)) pending.authored.push(messageId);
  }

  /** The person pressed Stop: what they sent into this turn is withdrawn. */
  stoppedByPerson(threadId: string): void {
    const pending = this.pending.get(threadId);
    if (pending) pending.stopped = true;
  }

  abandon(threadId: string, claimId: string): void {
    const pending = this.pending.get(threadId);
    if (pending?.claimId !== claimId) return;
    this.pending.delete(threadId);
    this.settle(threadId, pending);
  }

  onEvent(event: RuntimeEvent): void {
    const pending = this.pending.get(event.threadId);
    if (!pending?.dispatched || event.providerInstanceId !== pending.instanceId) return;
    if (pending.turnId && event.turnId && event.turnId !== pending.turnId) return;
    if (event.type === "session.started") {
      if (!event.sessionId || event.sessionId === pending.session || pending.accepted) return;
      pending.session = event.sessionId;
      pending.replaced = event.sessionId !== pending.resumeCursor;
      pending.rebuilt = event.rebuilt === true;
      // Nothing the old session held is trusted for its replacement.
      if (pending.replaced) this.store.write(pending.botId, event.threadId, pending.instanceId, { ids: [] });
      return;
    }
    if ((actedOn(event) || (event.type === "turn.completed" && event.ok)) && !pending.accepted) {
      pending.accepted = true;
      pending.turnId ??= event.turnId;
      this.accept(event.threadId, pending);
    }
    if (event.type !== "turn.completed") return;
    this.pending.delete(event.threadId);
    const turnId = event.turnId ?? pending.turnId;
    if (pending.accepted) this.add(event.threadId, pending, [...(turnId ? this.store.replies(event.threadId, turnId) : []), ...pending.authored]);
    this.settle(event.threadId, pending);
  }

  private settle(threadId: string, pending: PendingHandoff): void {
    if (!pending.stopped) return;
    const withdrawn = [...pending.own, ...pending.steers];
    // A replacement never accepted holds no record; the next turn replays.
    if (pending.accepted || !pending.replaced) this.add(threadId, pending, withdrawn);
  }

  private accept(threadId: string, pending: PendingHandoff): void {
    const session = pending.session ?? pending.resumeCursor;
    if (session === undefined) return;
    if (pending.replaced && pending.resumeCursor !== undefined && !pending.rebuilt) return;
    const existing = this.store.read(pending.botId, threadId, pending.instanceId);
    const start = pending.replaced || pending.resumeCursor === undefined
      ? pending.resumeCursor === undefined ? pending.started : pending.recovery
      : existing === undefined ? pending.resumed : undefined;
    if (!start) {
      if (typeof pending.effort === "string" && existing?.session === session && existing.effort !== pending.effort) {
        this.store.write(pending.botId, threadId, pending.instanceId, { ...existing, effort: pending.effort });
      }
      this.add(threadId, pending, [...pending.placed, ...pending.carried]);
      return;
    }
    this.store.write(pending.botId, threadId, pending.instanceId, recordHanded(
      { session, config: pending.config, ...(pending.effort === undefined ? {} : { effort: pending.effort }),
        ...(start.omitted === undefined ? {} : { omitted: start.omitted }), ids: [] },
      this.store.order(threadId), start.sent));
  }

  private add(threadId: string, pending: PendingHandoff, received: readonly string[]): void {
    const session = pending.session ?? pending.resumeCursor;
    if (session === undefined || received.length === 0) return;
    const existing = this.store.read(pending.botId, threadId, pending.instanceId);
    if (!existing || existing.session !== session) return;
    this.store.write(pending.botId, threadId, pending.instanceId, recordHanded(existing, this.store.order(threadId), received));
  }
}
