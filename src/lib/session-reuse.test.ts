import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairWithCode, verifyEmailSignIn, type SessionState } from "./session";
import { forgetSharedSession, SESSION_REUSE_MS, sharedSessionRead } from "./session-reuse";
import { noteRefusedRequest, sessionCheck } from "./session-ended";
import { api } from "@/state/api";

const admin: SessionState = { kind: "session", id: "s1", label: "", scopes: ["admin", "client"], expiresAt: 0 };
const member: SessionState = { kind: "session", id: "s1", label: "", scopes: ["client"], expiresAt: 0 };
let answer: SessionState = admin;
let reads = 0;
const read = () => { reads += 1; return Promise.resolve(answer); };
const shared = () => sharedSessionRead(read);

beforeEach(() => {
  vi.useFakeTimers();
  forgetSharedSession();
  answer = admin;
  reads = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the shared session read", () => {
  it("gives readers that ask together one request", async () => {
    expect(await Promise.all([shared(), shared(), shared()])).toEqual([admin, admin, admin]);
    expect(reads).toBe(1);
  });

  it("serves the answer for a few seconds, then asks again", async () => {
    await shared();
    vi.advanceTimersByTime(SESSION_REUSE_MS - 1);
    answer = member;
    expect(await shared()).toBe(admin);
    expect(reads).toBe(1);
    vi.advanceTimersByTime(1);
    expect(await shared()).toBe(member);
    expect(reads).toBe(2);
  });

  it("asks again when the clock went back", async () => {
    await shared();
    vi.setSystemTime(Date.now() - 60_000);
    await shared();
    expect(reads).toBe(2);
  });

  it("keeps no refusal and no failed read", async () => {
    answer = { kind: "unauthenticated", error: "401" };
    await shared();
    answer = { kind: "unreachable", error: "offline" };
    await shared();
    answer = admin;
    expect(await shared()).toBe(admin);
    expect(reads).toBe(3);
  });

  it("neither keeps nor shares a read that was under way when the session changed", async () => {
    let finish!: (state: SessionState) => void;
    const early = sharedSessionRead(() => { reads += 1; return new Promise((resolve) => { finish = resolve; }); });
    forgetSharedSession();
    answer = member;
    expect(await shared(), "a reader after the change starts its own request").toBe(member);
    finish(admin);
    expect(await early).toBe(admin);
    expect(await shared(), "the early answer was not kept over the later one").toBe(member);
    expect(reads).toBe(2);
  });

  it("asks again after a rejected read", async () => {
    await expect(sharedSessionRead(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await shared()).toBe(admin);
    expect(reads).toBe(1);
  });
});

describe("what drops the kept session", () => {
  const respond = (status: number) => vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status })));
  const dropped = async () => { const before = reads; await shared(); return reads === before + 1; };

  it("a sign-in by code or by email, whether or not it succeeds", async () => {
    for (const status of [200, 403]) {
      respond(status);
      await shared();
      await pairWithCode({ code: "c", label: "l" });
      expect(await dropped()).toBe(true);
      await verifyEmailSignIn({ email: "a@example.com", code: "1", label: "l" });
      expect(await dropped()).toBe(true);
    }
  });

  it("any write through api(), such as a sign-out or a removed device, and not a read", async () => {
    respond(200);
    await shared();
    await api("/api/bots");
    expect(await dropped()).toBe(false);
    await api("/api/auth/logout", { method: "POST" });
    expect(await dropped()).toBe(true);
    await api("/api/auth/sessions/s9", { method: "DELETE" });
    expect(await dropped()).toBe(true);
    await api("/api/config", { method: "PUT", body: JSON.stringify({ signIn: { admins: [], members: [] } }) });
    expect(await dropped()).toBe(true);
  });

  it("a write that never got an answer", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await shared();
    await expect(api("/api/auth/logout", { method: "POST" })).rejects.toThrow();
    expect(await dropped()).toBe(true);
  });

  it("a refused request, and the check of whether the session ended", async () => {
    for (const status of [401, 403]) {
      respond(status);
      await shared();
      await expect(api("/api/bots")).rejects.toThrow();
      await sessionCheck();
      expect(await dropped()).toBe(true);
    }
    respond(200);
    await shared();
    noteRefusedRequest();
    await sessionCheck();
    expect(await dropped()).toBe(true);
  });
});
