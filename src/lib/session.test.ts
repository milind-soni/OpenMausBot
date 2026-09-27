import { describe, expect, it, vi } from "vitest";

import { readEnvironment, readSessionState, reasonWorthShowing, takeInvitedEmailFromLocation, verifyMagicLink } from "./session";

/** A server that accepts the request and never answers, until the caller gives up. */
const silentFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
}));

describe("the first question to the server", () => {
  it("stops waiting on a server that never answers", async () => {
    expect(await readSessionState(silentFetch, 20)).toEqual({ kind: "unreachable", error: "no answer within 0.02 s" });
    expect(await readEnvironment(silentFetch, 20)).toBeNull();
  });

  it("tells a gateway error apart from being signed out", async () => {
    const gateway = vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    expect(await readSessionState(gateway)).toEqual({ kind: "unreachable", error: "502 Bad Gateway" });
    const signedOut = vi.fn(async () => new Response(JSON.stringify({ error: "forbidden: this request came through a proxy" }), { status: 403 }));
    expect(await readSessionState(signedOut)).toEqual({ kind: "unauthenticated", error: "forbidden: this request came through a proxy" });
  });
});

it("preserves the server's new-workspace signal without trusting truthy strings", async () => {
  for (const [created, expected] of [[true, { ok: true, created: true }], [false, { ok: true, created: false }], ["true", { ok: true }], [undefined, { ok: true }]] as const) {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, created }), { status: 200 }));
    expect(await verifyMagicLink({ token: "fixture", label: "test" }, fakeFetch)).toEqual(expected);
  }
});

describe("what the pair page says about why it was shown", () => {
  it("stays quiet for the ordinary no-session case and repeats anything else", () => {
    expect(reasonWorthShowing("forbidden: this request came through a proxy (pair this device to use the server remotely)")).toBeNull();
    expect(reasonWorthShowing("forbidden: loopback host required (pair this device to use the server remotely)")).toBeNull();
    expect(reasonWorthShowing("403")).toBeNull();
    expect(reasonWorthShowing(undefined)).toBeNull();
    expect(reasonWorthShowing("unauthorized: this session has expired or was revoked; pair this device again")).toMatch(/expired or was revoked/);
  });
});

describe("the invited address on a pair link", () => {
  it("prefills a valid address, drops it from the address bar, and ignores junk", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("location", { search: "?email=Ada%40Example.test&x=1", pathname: "/pair", hash: "#code=ABCD" });
    vi.stubGlobal("history", { replaceState });
    expect(takeInvitedEmailFromLocation()).toBe("ada@example.test");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair?x=1#code=ABCD");
    vi.stubGlobal("location", { search: "?email=not-an-address", pathname: "/pair", hash: "" });
    expect(takeInvitedEmailFromLocation()).toBeNull();
    vi.stubGlobal("location", { search: "", pathname: "/pair", hash: "" });
    expect(takeInvitedEmailFromLocation()).toBeNull();
    vi.unstubAllGlobals();
  });
});
