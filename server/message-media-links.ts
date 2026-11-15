// A <video> element cannot send the JSON body the message-file route reads, so the route hands out an opaque id
// for the exact request it just authorized. The id is not a bearer secret: each use still needs the same signed-in
// viewer, and the route re-runs every message, folder and MIME check against what the id stands for.
import { randomBytes } from "node:crypto";

import type { RequestAuth } from "./request-auth.ts";

/** Idle limit: every range request a playing video makes renews it. */
export const MESSAGE_MEDIA_IDLE_MS = 15 * 60_000;
/** Hard limit, however busy the link is. */
export const MESSAGE_MEDIA_MAX_AGE_MS = 4 * 60 * 60_000;
const MAX_LINKS = 512;

export interface MessageMediaGrant {
  threadId: string;
  messageId: string;
  /** The `path` (and folder `entry`) the viewer asked for, exactly as the POST body carried them. */
  path: string;
  entry?: string;
}

interface StoredGrant extends MessageMediaGrant {
  viewer: string;
  idleUntil: number;
  expiresAt: number;
}

/** Who may use a link: the session that asked for it, or the loopback owner. */
export function mediaViewerKey(auth: RequestAuth): string {
  return auth.kind === "session" ? `session:${auth.session.id}` : "loopback";
}

export class MessageMediaLinks {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(grant: MessageMediaGrant, auth: RequestAuth): string {
    const now = this.now();
    for (const [id, stored] of this.grants) {
      if (!this.live(stored, now)) this.grants.delete(id);
    }
    // Map order is insertion order: past the cap, the oldest link goes first.
    while (this.grants.size >= MAX_LINKS) this.grants.delete(this.grants.keys().next().value!);
    const id = randomBytes(32).toString("base64url");
    this.grants.set(id, {
      ...grant,
      viewer: mediaViewerKey(auth),
      idleUntil: now + MESSAGE_MEDIA_IDLE_MS,
      expiresAt: now + MESSAGE_MEDIA_MAX_AGE_MS,
    });
    return id;
  }

  /** The grant behind `id`, only for the same viewer on the same message; a use renews the idle limit. */
  use(id: string, threadId: string, messageId: string, auth: RequestAuth): MessageMediaGrant | null {
    const stored = this.grants.get(id);
    if (!stored) return null;
    const now = this.now();
    if (!this.live(stored, now)) {
      this.grants.delete(id);
      return null;
    }
    if (stored.threadId !== threadId || stored.messageId !== messageId || stored.viewer !== mediaViewerKey(auth)) return null;
    stored.idleUntil = now + MESSAGE_MEDIA_IDLE_MS;
    return { threadId: stored.threadId, messageId: stored.messageId, path: stored.path, ...(stored.entry !== undefined ? { entry: stored.entry } : {}) };
  }

  private live(stored: StoredGrant, now: number): boolean {
    return now < stored.idleUntil && now < stored.expiresAt;
  }
}
