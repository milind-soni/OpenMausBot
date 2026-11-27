import type { CdpSession } from "./connection.ts";
import { staleRefError } from "./errors.ts";

/** A DOM node the agent can name: the frame it lives in, the session that owns that frame, and Chrome's node id. */
export interface NodeHandle {
  frameId: string;
  session: CdpSession;
  backendNodeId: number;
}

/** Ref numbers come from one counter per browser, so a ref from one tab never names an element in another. */
export class RefCounter {
  #next = 1;

  take(): number {
    return this.#next++;
  }
}

const REF = /^(?:aria-ref\s*=\s*)?@?(e\d+)$/;

/** "@e12", "e12" and "aria-ref=e12" all name e12; anything else is not a ref. */
export function parseRef(text: string): string | null {
  return REF.exec(text.trim())?.[1] ?? null;
}

const nodeKey = (handle: Pick<NodeHandle, "session" | "backendNodeId">) => `${handle.session.id ?? ""}|${handle.backendNodeId}`;

/** One tab's refs. An element keeps its ref across snapshots while its node lives; a number is never given out twice. */
export class RefTable {
  readonly #counter: RefCounter;
  readonly #byRef = new Map<string, NodeHandle>();
  readonly #byNode = new Map<string, string>();

  constructor(counter: RefCounter) {
    this.#counter = counter;
  }

  get size(): number {
    return this.#byRef.size;
  }

  refFor(handle: NodeHandle): string {
    const key = nodeKey(handle);
    const existing = this.#byNode.get(key);
    if (existing) return existing;
    const ref = `e${this.#counter.take()}`;
    this.#byRef.set(ref, handle);
    this.#byNode.set(key, ref);
    return ref;
  }

  /** Throws the stale-ref error for a ref this tab never gave out or has since revoked. */
  resolve(text: string): NodeHandle & { ref: string } {
    const ref = parseRef(text);
    const handle = ref ? this.#byRef.get(ref) : undefined;
    if (!ref || !handle) throw staleRefError(ref ?? text.trim());
    return { ...handle, ref };
  }

  forget(ref: string): void {
    const handle = this.#byRef.get(ref);
    if (!handle) return;
    this.#byRef.delete(ref);
    this.#byNode.delete(nodeKey(handle));
  }

  /** A main-frame navigation, a control change or a resolved dialog. */
  invalidateAll(): void {
    this.#byRef.clear();
    this.#byNode.clear();
  }

  invalidateFrames(frameIds: ReadonlySet<string>): void {
    for (const [ref, handle] of this.#byRef) if (frameIds.has(handle.frameId)) this.forget(ref);
  }

  invalidateSession(session: CdpSession): void {
    for (const [ref, handle] of this.#byRef) if (handle.session === session) this.forget(ref);
  }
}
