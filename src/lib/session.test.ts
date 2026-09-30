import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_SIGN_IN_FAILED, cloudOwnerOf, isConnected, isOwnerOrAdmin, previewBrowserSignIn, readSessionState, reasonWorthShowing, SERVICE_TRUST_REASON, signInWithBrowserGrant,
  takeBrowserSignInFromLocation, takeInvitedEmailFromLocation, takePairingCodeFromLocation,
} from "./session";

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

describe("the OMB Cloud page's \"Use in your browser\" link", () => {
  const credential = `omb_pair_${"b".repeat(43)}`;
  it("is taken off the address bar and out of history before anything renders, whatever it carries", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    vi.stubGlobal("location", { pathname: "/pair", search: "", hash: `#signin=${credential}` });
    expect(takeBrowserSignInFromLocation()).toBe(credential);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair");
    // A malformed one is still removed, and is not a code for the pair form either.
    replaceState.mockClear();
    vi.stubGlobal("location", { pathname: "/pair", search: "", hash: "#signin=ABCD-EFGH-JKLM" });
    expect(takeBrowserSignInFromLocation()).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair");
    // An ordinary pairing link is left to the pair form.
    replaceState.mockClear();
    vi.stubGlobal("location", { pathname: "/pair", search: "", hash: "#code=ABCD-EFGH-JKLM" });
    expect(takeBrowserSignInFromLocation()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    expect(takePairingCodeFromLocation()).toBe("ABCD-EFGH-JKLM");
    vi.unstubAllGlobals();
  });

  it("shows whose Cloud it is first, asking only to look, and treats anything else as spent", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = (status: number, body: unknown) => (async (path: string, init?: RequestInit) => {
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    expect(await previewBrowserSignIn(credential, server(200, { owner: "ada@example.test", expiresAt: 1 }))).toEqual({ owner: "ada@example.test" });
    expect(requests).toEqual([{ path: "/api/auth/pair", body: { code: credential, browser: true, preview: true } }]);
    expect(await previewBrowserSignIn(credential, server(401, { error: "expired" }))).toBeNull();
    expect(await previewBrowserSignIn(credential, server(200, { owner: "" }))).toBeNull();
    expect(await previewBrowserSignIn(credential, server(200, { owner: 7 }))).toBeNull();
    expect(await previewBrowserSignIn(credential, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });

  it("on Continue is always redeemed into this browser's cookie, connected or not, with the page's one attempt id", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = (async (path: string, init?: RequestInit) => {
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      // Whatever this browser already has here, the grant is redeemed (and its old session replaced).
      if (path === "/api/auth/session") return new Response(JSON.stringify({ kind: "session", id: "s", label: "Chrome on Mac", scopes: ["client"], expiresAt: 1 }), { status: 200 });
      return new Response(JSON.stringify({ session: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await signInWithBrowserGrant(credential, "attempt-page-0001", server)).toEqual({ ok: true });
    expect(await signInWithBrowserGrant(credential, "attempt-page-0001", server)).toEqual({ ok: true });
    expect(requests.map((r) => r.path)).toEqual(["/api/auth/pair", "/api/auth/pair"]);
    for (const request of requests) expect(request.body).toMatchObject({ code: credential, cookie: true, browser: true, attemptId: "attempt-page-0001" });
    // A spent or expired one says so.
    const spent = (async () => new Response(JSON.stringify({ error: "pairing code is wrong or has expired" }), { status: 401 })) as unknown as typeof fetch;
    expect(await signInWithBrowserGrant(credential, "attempt-page-0002", spent)).toEqual({ ok: false, error: "pairing code is wrong or has expired" });
    expect(reasonWorthShowing(BROWSER_SIGN_IN_FAILED)).toBe(BROWSER_SIGN_IN_FAILED);
  });

  it("names the Cloud's owner afterwards only for a browser sign-in's session on a Cloud home", () => {
    expect(cloudOwnerOf({ kind: "session", cloudHome: true, owner: "ada@example.test" })).toBe("ada@example.test");
    for (const session of [{ kind: "session", owner: "ada@example.test" }, { kind: "session", cloudHome: true }, { kind: "loopback" },
      { cloudHome: true, owner: 7 }, { cloudHome: "yes", owner: "ada@example.test" }, null, undefined]) expect(cloudOwnerOf(session)).toBeNull();
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
