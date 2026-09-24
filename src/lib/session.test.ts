import { describe, expect, it, vi } from "vitest";

import { isConnected, isOwnerOrAdmin, readSessionState, reasonWorthShowing, SERVICE_TRUST_REASON, takeInvitedEmailFromLocation } from "./session";

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

describe("who the served UI is on its own machine", () => {
  const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  it("is the owner on loopback unless the server says local requests are only a service", async () => {
    const owner = await readSessionState(answer({ kind: "loopback", scopes: ["admin", "client"] }));
    expect(owner).toEqual({ kind: "loopback" });
    expect(isOwnerOrAdmin(owner)).toBe(true);
    const service = await readSessionState(answer({ kind: "loopback", scopes: ["client"], trust: "service" }));
    expect(service).toEqual({ kind: "loopback", trust: "service" });
    expect(isOwnerOrAdmin(service)).toBe(false);
    expect(isOwnerOrAdmin({ kind: "session", id: "s", label: "l", scopes: ["client"], expiresAt: 1 })).toBe(false);
    expect(isOwnerOrAdmin({ kind: "session", id: "s", label: "l", scopes: ["admin", "client"], expiresAt: 1 })).toBe(true);
    expect(isOwnerOrAdmin(null)).toBe(false);
  });
});

describe("an SSH tunnel to a server that treats local requests as a service", () => {
  it("is not connected, so the app sends it to sign in, and says why", () => {
    expect(isConnected({ kind: "loopback" })).toBe(true);
    expect(isConnected({ kind: "loopback", trust: "service" })).toBe(false);
    expect(isConnected({ kind: "session", id: "s", label: "l", scopes: ["client"], expiresAt: 1 })).toBe(true);
    expect(isConnected({ kind: "unauthenticated", error: "pair" })).toBe(false);
    expect(isConnected(null)).toBe(false);
    expect(reasonWorthShowing(SERVICE_TRUST_REASON)).toBe(SERVICE_TRUST_REASON);
  });
});
