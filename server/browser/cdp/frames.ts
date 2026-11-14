import type { CdpSession, Params } from "./connection.ts";
import { isMissingContext } from "./errors.ts";

/** The isolated world every frame gets: it sees the DOM, never the page's globals, and the page cannot see it. */
export const WORLD_NAME = "omb";

export interface FrameRecord {
  id: string;
  parentId: string | null;
  /** The session whose renderer hosts this frame: the page's, or an out-of-process iframe's. */
  session: CdpSession;
  url: string;
  loaderId: string | null;
}

export interface FrameChange {
  frameId: string;
  /** This frame and every frame inside it. */
  affected: Set<string>;
  kind: "navigated" | "detached";
}

interface FramePayload {
  id: string;
  parentId?: string;
  url: string;
  urlFragment?: string;
  loaderId?: string;
}

export interface FrameTreeNode {
  frame: FramePayload;
  childFrames?: FrameTreeNode[];
}

/** One tab's frames across its sessions, and the isolated world in each. */
export class FrameTree {
  readonly mainFrameId: string;
  readonly mainSession: CdpSession;
  readonly #frames = new Map<string, FrameRecord>();
  readonly #oopifRoots = new Map<CdpSession, string>();
  readonly #worlds = new Map<string, Promise<number>>();
  readonly #listeners = new Set<(change: FrameChange) => void>();

  constructor(mainSession: CdpSession, mainFrameId: string) {
    this.mainSession = mainSession;
    this.mainFrameId = mainFrameId;
    this.#frames.set(mainFrameId, { id: mainFrameId, parentId: null, session: mainSession, url: "about:blank", loaderId: null });
    this.watch(mainSession);
  }

  onChange(listener: (change: FrameChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get(frameId: string): FrameRecord | undefined {
    return this.#frames.get(frameId);
  }

  all(): FrameRecord[] {
    return [...this.#frames.values()];
  }

  /** Gone once the page's session detaches, when the tab closes or its browser stops. */
  get main(): FrameRecord | undefined {
    return this.#frames.get(this.mainFrameId);
  }

  /** The frame an out-of-process iframe's session renders, or null for the page's own session. */
  rootOf(session: CdpSession): string | null {
    return session === this.mainSession ? this.mainFrameId : this.#oopifRoots.get(session) ?? null;
  }

  descendants(frameId: string): Set<string> {
    const found = new Set([frameId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const frame of this.#frames.values()) {
        if (frame.parentId !== null && found.has(frame.parentId) && !found.has(frame.id)) {
          found.add(frame.id);
          grew = true;
        }
      }
    }
    return found;
  }

  /** Follows a session's frame events; an out-of-process iframe's session also names the frame it renders. */
  watch(session: CdpSession, oopifFrameId?: string): () => void {
    if (oopifFrameId) {
      this.#oopifRoots.set(session, oopifFrameId);
      const existing = this.#frames.get(oopifFrameId);
      this.#frames.set(oopifFrameId, { id: oopifFrameId, parentId: existing?.parentId ?? null, session, url: existing?.url ?? "", loaderId: null });
      this.#dropWorlds(new Set([oopifFrameId]));
    }
    const offs = [
      session.on("Page.frameAttached", (params) => this.#attached(session, params)),
      session.on("Page.frameNavigated", (params) => this.#navigated(session, params.frame as FramePayload)),
      session.on("Page.navigatedWithinDocument", (params) => {
        const frame = this.#frames.get(String(params.frameId));
        if (frame) frame.url = String(params.url);
      }),
      session.on("Page.frameDetached", (params) => this.#detached(session, String(params.frameId), String(params.reason ?? "remove"))),
    ];
    const offDetach = session.onDetach(() => this.#sessionGone(session));
    return () => {
      for (const off of offs) off();
      offDetach();
    };
  }

  /**
   * Takes the frames Chrome reports for a page that was already showing a
   * document when it was set up: a tab session restore reopens commits its
   * page before any frame event reaches the driver (measured on 153).
   */
  adopt(tree: FrameTreeNode): void {
    const visit = (node: FrameTreeNode, parentId: string | null) => {
      const existing = this.#frames.get(node.frame.id);
      if (!existing || existing.session === this.mainSession) {
        const url = node.frame.url + (node.frame.urlFragment ?? "");
        if (!existing || existing.url !== url || existing.loaderId === null) {
          this.#frames.set(node.frame.id, { id: node.frame.id, parentId, session: this.mainSession, url, loaderId: node.frame.loaderId ?? existing?.loaderId ?? null });
        }
      }
      for (const child of node.childFrames ?? []) visit(child, node.frame.id);
    };
    visit(tree, null);
  }

  #attached(session: CdpSession, params: Params): void {
    const frameId = String(params.frameId);
    const parentId = typeof params.parentFrameId === "string" ? params.parentFrameId : null;
    const existing = this.#frames.get(frameId);
    if (existing && existing.session !== session) return;
    this.#frames.set(frameId, { id: frameId, parentId, session, url: existing?.url ?? "", loaderId: existing?.loaderId ?? null });
  }

  #navigated(session: CdpSession, frame: FramePayload): void {
    const existing = this.#frames.get(frame.id);
    if (existing && existing.session !== session && this.#oopifRoots.get(existing.session) === frame.id) return;
    const parentId = frame.parentId ?? existing?.parentId ?? null;
    this.#frames.set(frame.id, { id: frame.id, parentId, session, url: frame.url + (frame.urlFragment ?? ""), loaderId: frame.loaderId ?? null });
    const affected = this.descendants(frame.id);
    for (const id of affected) if (id !== frame.id && this.#frames.get(id)?.session === session) this.#frames.delete(id);
    this.#dropWorlds(affected);
    this.#emit({ frameId: frame.id, affected, kind: "navigated" });
  }

  #detached(session: CdpSession, frameId: string, reason: string): void {
    const frame = this.#frames.get(frameId);
    if (!frame || frame.session !== session) return;
    const affected = this.descendants(frameId);
    this.#dropWorlds(affected);
    // "swap": the frame moves to another renderer and comes back on that one's session.
    if (reason !== "swap") for (const id of affected) this.#frames.delete(id);
    this.#emit({ frameId, affected, kind: "detached" });
  }

  #sessionGone(session: CdpSession): void {
    const root = this.#oopifRoots.get(session);
    this.#oopifRoots.delete(session);
    const affected = new Set<string>();
    for (const frame of this.#frames.values()) if (frame.session === session) for (const id of this.descendants(frame.id)) affected.add(id);
    if (!affected.size) return;
    this.#dropWorlds(affected);
    for (const id of affected) if (id !== root || this.#frames.get(id)?.session === session) this.#frames.delete(id);
    this.#emit({ frameId: root ?? [...affected][0]!, affected, kind: "detached" });
  }

  #emit(change: FrameChange): void {
    for (const listener of this.#listeners) {
      try { listener(change); } catch {}
    }
  }

  #dropWorlds(frameIds: Iterable<string>): void {
    for (const id of frameIds) this.#worlds.delete(id);
  }

  /** The isolated world's execution context in this frame, created once per document. */
  world(frameId: string): Promise<number> {
    const frame = this.#frames.get(frameId);
    if (!frame) return Promise.reject(new Error(`Frame with the given id was not found: ${frameId}`));
    let world = this.#worlds.get(frameId);
    if (!world) {
      world = frame.session
        .send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId, worldName: WORLD_NAME, grantUniveralAccess: true })
        .then((result) => result.executionContextId);
      this.#worlds.set(frameId, world);
      world.catch(() => {
        if (this.#worlds.get(frameId) === world) this.#worlds.delete(frameId);
      });
    }
    return world;
  }

  /** Runs `work` in the frame's isolated world, once more on a fresh world if a navigation replaced the document. */
  async inWorld<T>(frameId: string, work: (session: CdpSession, contextId: number) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const frame = this.#frames.get(frameId);
      if (!frame) throw new Error(`Frame with the given id was not found: ${frameId}`);
      const contextId = await this.world(frameId);
      try {
        return await work(frame.session, contextId);
      } catch (error) {
        if (attempt > 0 || !isMissingContext(error)) throw error;
        this.#worlds.delete(frameId);
      }
    }
  }

  /** Where a session's top frame sits in the page's viewport: (0, 0) for the page itself. */
  async localRootOffset(session: CdpSession): Promise<{ x: number; y: number }> {
    const root = this.#oopifRoots.get(session);
    if (!root || !session.parent || session === this.mainSession) return { x: 0, y: 0 };
    const owner = await session.parent.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: root });
    const { model } = await session.parent.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
    const above = await this.localRootOffset(session.parent);
    return { x: above.x + (model.content[0] ?? 0), y: above.y + (model.content[1] ?? 0) };
  }
}
