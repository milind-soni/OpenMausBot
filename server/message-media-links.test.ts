import { describe, expect, it } from "vitest";

import { MESSAGE_MEDIA_IDLE_MS, MESSAGE_MEDIA_MAX_AGE_MS, MessageMediaLinks } from "./message-media-links.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRecord } from "./sessions.ts";

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const session = (id: string): RequestAuth => ({ kind: "session", session: { id } as SessionRecord, via: "cookie", scopes: ["client"] });
const grant = { threadId: "t1", messageId: "m1", path: "/work/clip.mp4" };

describe("MessageMediaLinks", () => {
  it("gives the grant back only to the viewer who asked, on the same message", () => {
    const links = new MessageMediaLinks();
    const id = links.issue(grant, session("a"));
    expect(id).toMatch(/^[\w-]{43}$/);
    expect(links.use(id, "t1", "m1", session("a"))).toEqual(grant);
    expect(links.use(id, "t1", "m1", session("b"))).toBeNull();
    expect(links.use(id, "t1", "m1", owner)).toBeNull();
    expect(links.use(id, "t1", "m2", session("a"))).toBeNull();
    expect(links.use(id, "t2", "m1", session("a"))).toBeNull();
    expect(links.use("forged", "t1", "m1", session("a"))).toBeNull();
    expect(links.issue(grant, session("a"))).not.toBe(id);
  });

  it("keeps a folder entry with its grant", () => {
    const links = new MessageMediaLinks();
    const id = links.issue({ ...grant, entry: "clip.mp4" }, owner);
    expect(links.use(id, "t1", "m1", owner)).toEqual({ ...grant, entry: "clip.mp4" });
  });

  it("expires when idle, renews on use, and ends at the hard limit", () => {
    let now = 1_000;
    const links = new MessageMediaLinks(() => now);
    const idle = links.issue(grant, owner);
    now += MESSAGE_MEDIA_IDLE_MS;
    expect(links.use(idle, "t1", "m1", owner)).toBeNull();

    const busy = links.issue(grant, owner);
    const issuedAt = now;
    while (now + MESSAGE_MEDIA_IDLE_MS / 2 < issuedAt + MESSAGE_MEDIA_MAX_AGE_MS) {
      now += MESSAGE_MEDIA_IDLE_MS / 2;
      expect(links.use(busy, "t1", "m1", owner)).toEqual(grant);
    }
    now = issuedAt + MESSAGE_MEDIA_MAX_AGE_MS;
    expect(links.use(busy, "t1", "m1", owner)).toBeNull();
  });

  it("keeps at most a bounded number of links, dropping the oldest", () => {
    const links = new MessageMediaLinks();
    const first = links.issue(grant, owner);
    for (let i = 0; i < 600; i++) links.issue(grant, owner);
    expect(links.use(first, "t1", "m1", owner)).toBeNull();
  });
});
