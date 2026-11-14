import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createUploadOwners, uploadsFor } from "./member-uploads.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function uploads() {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-member-uploads-"));
  made.push(dataDir);
  return uploadsFor(createUploadOwners(dataDir), false);
}

const desktop: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const phone = (device: string): RequestAuth => ({ kind: "loopback", scopes: ["admin", "client"], companionDevice: device });
const session = (id: string): RequestAuth => ({
  kind: "session", via: "bearer", scopes: ["admin", "client"],
  session: { id, label: id, scopes: ["admin", "client"], createdAt: 0, lastSeenAt: 0, expiresAt: Number.MAX_SAFE_INTEGER } as unknown as SessionRecord,
});

describe("who may discard an uploaded file", () => {
  it("is the paired phone that uploaded it, and no other phone or the desktop", () => {
    const owners = uploads();
    owners.note(phone("phone-a"), "a.jpg");
    expect(owners.owns(phone("phone-a"), "a.jpg")).toBe(true);
    expect(owners.owns(phone("phone-b"), "a.jpg")).toBe(false);
    expect(owners.owns(desktop, "a.jpg")).toBe(false);
    expect(owners.owns(session("phone-a"), "a.jpg")).toBe(false);
  });

  it("keeps the desktop's own files the desktop's, out of every phone's reach", () => {
    const owners = uploads();
    owners.note(desktop, "d.png");
    expect(owners.owns(desktop, "d.png")).toBe(true);
    expect(owners.owns(phone("phone-a"), "d.png")).toBe(false);
  });

  it("keeps a signed-in session's files its own", () => {
    const owners = uploads();
    owners.note(session("s1"), "s.png");
    expect(owners.owns(session("s1"), "s.png")).toBe(true);
    expect(owners.owns(session("s2"), "s.png")).toBe(false);
    expect(owners.owns(desktop, "s.png")).toBe(false);
    expect(owners.owns(phone("s1"), "s.png")).toBe(false);
  });
});
