import { describe, expect, it, vi } from "vitest";

import type { GithubSignInStatus } from "../../shared/github-sign-in";
import { ApiError } from "@/state/api";
import {
  createGithubSignInStore, EXPIRY_GRACE_MS, POLL_FAILURES_MAX, githubConnected, githubManageUrl, groupCode, INSTALLING_POLL_MS, isGithubDeviceUrl, SIGNING_IN_POLL_MS, spellCode,
} from "./github-sign-in";

const SIGNED_OUT: GithubSignInStatus = { state: "signed-out", download: false };
const CODE: GithubSignInStatus = { state: "signing-in", code: "WDJB-MJHT", verificationUrl: "https://github.com/login/device", expiresAt: 1_000 };
const SIGNED_IN: GithubSignInStatus = { state: "signed-in", login: "octo", source: "mausbot", scopes: ["repo"], checkedAt: 1 };

/** A fake server: answers in order for each path, and hand-run timers. */
function harness(answers: Record<string, Array<GithubSignInStatus | ApiError>>, clock = { at: 0 }) {
  const calls: Array<{ path: string; init?: RequestInit & { background?: boolean } }> = [];
  const api = vi.fn(async (path: string, init?: RequestInit & { background?: boolean }) => {
    calls.push({ path, init });
    const key = path.replace(/\?.*$/, "");
    const queue = answers[key] ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error(`unexpected ${path}`);
    if (next instanceof ApiError) throw next;
    return next;
  });
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers = {
    set: (fn: () => void, ms: number) => { const timer = { fn, ms, cleared: false }; pending.push(timer); return timer; },
    clear: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
  };
  const live = () => pending.filter((timer) => !timer.cleared);
  const tick = async () => {
    const due = live();
    for (const timer of due) { timer.cleared = true; timer.fn(); }
    await flush();
  };
  const store = createGithubSignInStore({ api, timers, now: () => clock.at });
  return { store, calls, live, tick };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("the device address", () => {
  it("is drawn as a link only when it is exactly GitHub's device page", () => {
    expect(isGithubDeviceUrl("https://github.com/login/device")).toBe(true);
    for (const other of [
      "http://github.com/login/device", "https://github.com/login/device?x=1", "https://github.com/login/device#a",
      "https://github.com:444/login/device", "https://user@github.com/login/device", "https://github.com.evil.example/login/device",
      "https://evil.example/login/device", "https://github.com/login/device/../oauth", "https://github.com/login/devices",
      "javascript:alert(1)", "", null, 42, "https://github.com/login/device?",
    ]) expect(isGithubDeviceUrl(other), String(other)).toBe(false);
  });

  it("groups the code in fours and spells it out for a screen reader", () => {
    expect(groupCode("wdjbmjht")).toBe("WDJB-MJHT");
    expect(groupCode("WDJB-MJHT")).toBe("WDJB-MJHT");
    expect(groupCode(" abc ")).toBe("ABC");
    expect(spellCode("WDJB-MJHT")).toBe("W D J B, M J H T");
  });

  it("manages a pasted token on the tokens page and a code sign-in among authorized apps", () => {
    expect(githubManageUrl("token")).toBe("https://github.com/settings/personal-access-tokens");
    expect(githubManageUrl("mausbot")).toBe("https://github.com/settings/applications");
    expect(githubManageUrl("cli")).toBe("https://github.com/settings/applications");
  });
});

describe("the shared status", () => {
  it("asks once when shown and never again while nothing is under way", async () => {
    const { store, calls, live, tick } = harness({ "/api/github/sign-in": [SIGNED_OUT] });
    const stop = store.subscribe(() => {});
    const second = store.subscribe(() => {});
    await flush();
    expect(calls.map((call) => call.path)).toEqual(["/api/github/sign-in"]);
    expect(store.snapshot()).toMatchObject({ phase: "ready", status: SIGNED_OUT });
    expect(live()).toEqual([]);
    await tick();
    expect(calls).toHaveLength(1);
    stop(); second();
    expect(githubConnected(store.snapshot())).toBe(false);
  });

  it("polls while GitHub CLI is prepared and the code waits, quietly, and stops once signed in", async () => {
    const { store, calls, live, tick } = harness({
      "/api/github/sign-in": [SIGNED_OUT, CODE, SIGNED_IN],
      "/api/github/sign-in/start": [{ state: "installing" }],
    });
    store.subscribe(() => {});
    await flush();
    await store.start();
    expect(store.snapshot().status?.state).toBe("installing");
    expect(live().map((timer) => timer.ms)).toEqual([INSTALLING_POLL_MS]);
    await tick();
    expect(store.snapshot().status?.state).toBe("signing-in");
    expect(live().map((timer) => timer.ms)).toEqual([SIGNING_IN_POLL_MS]);
    await tick();
    expect(store.snapshot().status).toEqual(SIGNED_IN);
    expect(live()).toEqual([]);
    expect(calls.filter((call) => call.path === "/api/github/sign-in").slice(1).every((call) => call.init?.background === true)).toBe(true);
    await tick();
    expect(calls).toHaveLength(4);
    expect(githubConnected(store.snapshot())).toBe(true);
  });

  it("stops polling when the last card goes, and picks up again when one is shown", async () => {
    const { store, live } = harness({ "/api/github/sign-in": [CODE] });
    const stop = store.subscribe(() => {});
    await flush();
    expect(live()).toHaveLength(1);
    stop();
    expect(live()).toEqual([]);
    store.subscribe(() => {});
    expect(live()).toHaveLength(1);
  });

  it("stops polling after cancel and after an expired code", async () => {
    const expired: GithubSignInStatus = { state: "signed-out", download: false, last: { outcome: "expired", at: 2 } };
    const { store, live, tick } = harness({ "/api/github/sign-in": [CODE, expired], "/api/github/sign-in/cancel": [{ ...SIGNED_OUT, last: { outcome: "cancelled", at: 3 } }] });
    store.subscribe(() => {});
    await flush();
    await tick();
    expect(store.snapshot().status).toEqual(expired);
    expect(live()).toEqual([]);

    const second = harness({ "/api/github/sign-in": [CODE], "/api/github/sign-in/cancel": [{ ...SIGNED_OUT, last: { outcome: "cancelled", at: 3 } }] });
    second.store.subscribe(() => {});
    await flush();
    await second.store.cancel();
    expect(second.store.snapshot().status?.last?.outcome).toBe("cancelled");
    expect(second.live()).toEqual([]);
  });

  it("offers a token when start is refused, after asking again what is true now", async () => {
    const { store, calls } = harness({
      "/api/github/sign-in": [SIGNED_OUT],
      "/api/github/sign-in/start": [new ApiError("Windows Credential Manager already holds a GitHub CLI sign-in", 409)],
    });
    store.subscribe(() => {});
    await flush();
    expect(await store.start()).toBe(false);
    expect(calls.map((call) => call.path)).toEqual(["/api/github/sign-in", "/api/github/sign-in/start", "/api/github/sign-in"]);
    expect(store.snapshot()).toMatchObject({ refused: true, error: null, busy: null });
  });

  it("shows the sign-in instead of a refusal when the person's own GitHub CLI turns out to be signed in", async () => {
    const { store } = harness({
      "/api/github/sign-in": [SIGNED_OUT, { ...SIGNED_IN, source: "cli" }],
      "/api/github/sign-in/start": [new ApiError("GitHub is already signed in on this computer as octo", 409)],
    });
    store.subscribe(() => {});
    await flush();
    await store.start();
    expect(store.snapshot()).toMatchObject({ refused: false, status: { state: "signed-in", source: "cli" } });
  });

  it("hides everything for a person the sign-in isn't for", async () => {
    const { store, live } = harness({ "/api/github/sign-in": [new ApiError("Only the owner or an admin of this server can connect GitHub.", 403)] });
    store.subscribe(() => {});
    await flush();
    expect(store.snapshot()).toMatchObject({ phase: "hidden", status: null });
    expect(live()).toEqual([]);
    expect(githubConnected(store.snapshot())).toBe(false);
  });

  it("offers Retry when the first answer fails, and keeps what it showed when a later one does", async () => {
    const failing = harness({ "/api/github/sign-in": [new ApiError("Couldn't reach", 502)] });
    failing.store.subscribe(() => {});
    await flush();
    expect(failing.store.snapshot().phase).toBe("error");

    const later = harness({ "/api/github/sign-in": [CODE, new ApiError("offline", 503)] });
    later.store.subscribe(() => {});
    await flush();
    await later.tick();
    expect(later.store.snapshot()).toMatchObject({ phase: "ready", status: CODE });
  });

  it("sends a pasted token once and keeps it nowhere, and says why GitHub refused it in its own words", async () => {
    const token = "github_pat_11ABCDEFG0123456789_secretsecretsecret";
    const { store, calls } = harness({
      "/api/github/sign-in": [SIGNED_OUT],
      "/api/github/sign-in/token": [new ApiError(`GitHub did not accept ${token}`, 400), new ApiError("rate", 502), { ...SIGNED_IN, source: "token" }],
    });
    store.subscribe(() => {});
    await flush();
    expect(await store.saveToken(token)).toBe(false);
    expect(store.snapshot().error).toBe("githubSignIn.tokenRejected");
    expect(JSON.stringify(store.snapshot())).not.toContain(token);
    await store.saveToken(token);
    expect(store.snapshot().error).toBe("githubSignIn.tokenUnchecked");
    expect(await store.saveToken(token)).toBe(true);
    expect(store.snapshot()).toMatchObject({ error: null, status: { state: "signed-in", source: "token" } });
    expect(JSON.stringify(store.snapshot())).not.toContain(token);
    const sent = calls.filter((call) => call.path === "/api/github/sign-in/token");
    expect(sent.map((call) => [call.init?.method, call.init?.body])).toEqual(Array(3).fill(["POST", JSON.stringify({ token })]));
  });

  it("stops asking once the code is past its expiry, whatever the server keeps saying", async () => {
    const clock = { at: 0 };
    const { store, live, tick, calls } = harness({ "/api/github/sign-in": [CODE] }, clock);
    store.subscribe(() => {});
    await flush();
    expect(live()).toHaveLength(1);
    clock.at = CODE.state === "signing-in" ? CODE.expiresAt + EXPIRY_GRACE_MS + 1 : 0;
    await tick();
    expect(live()).toEqual([]);
    const asked = calls.length;
    await tick();
    expect(calls).toHaveLength(asked);
  });

  it("backs off while reads fail, then stops and offers Retry", async () => {
    const failing = Array.from({ length: 20 }, () => new ApiError("Internal error", 500));
    const { store, live, tick, calls } = harness({ "/api/github/sign-in": [{ ...CODE, expiresAt: Number.MAX_SAFE_INTEGER } as GithubSignInStatus, ...failing] });
    store.subscribe(() => {});
    await flush();
    const waits: number[] = [];
    for (let i = 0; i < 10 && live().length; i++) { waits.push(live()[0]!.ms); await tick(); }
    expect(waits).toEqual(Array.from({ length: POLL_FAILURES_MAX }, (_, i) => SIGNING_IN_POLL_MS * 2 ** i));
    expect(live()).toEqual([]);
    expect(store.snapshot().phase).toBe("error");
    expect(calls).toHaveLength(1 + POLL_FAILURES_MAX);
  });

  it("a card that comes into view while a read is under way shares it", async () => {
    const { store, calls } = harness({ "/api/github/sign-in": [SIGNED_OUT] });
    store.subscribe(() => {});
    await store.fresh();
    expect(calls).toHaveLength(1);
    await store.fresh();
    expect(calls).toHaveLength(2);
  });
});
