// Cloud Pro's included Boat computers, over HTTP against one stub that plays
// both Boat (/boat) and the Admin's relay (/relay). The relay knows only the
// Admin's account, so the person's own key must never reach it and the
// included token must never reach Boat; the own key always wins.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";

const INCLUDED = "box_omb_included-relay-token";
const LIMIT = "Your Pro plan's 200 cloud computer hours for September are used up. They reset on 1 October.";
const botId = "included-boat-test";
const boxId = "bx_23456789";
const OPERATION_ID = "bdop_0123456789abcdef0123456789abcdef";

let api: Server;
let base = "";
let state = "ready";
/** Whether an accepted resume wakes the computer at once. */
let wakeOnResume = true;
/** When set, every request is refused as an invalid credential. */
let rejectCredentials = false;
/** When set, every request fails as an outage would. */
let serverError = false;
/** This many listings are cut off before any answer, as a dropped connection is. */
let dropLists = 0;
/** Replies to POST /resume in order; the last one repeats. A 2xx wakes the computer. */
let resumeReplies: Array<{ status: number; body: unknown }> = [];
const requests: Array<{ method: string; path: string; auth: string }> = [];
let boat: typeof import("./boat.ts");
let loadConfig: typeof import("./config.ts").loadConfig;

const underBoat = () => requests.filter((request) => request.path.startsWith("/boat/"));
const underRelay = () => requests.filter((request) => request.path.startsWith("/relay/"));

// The legacy deterministic name findBoat still recognises.
const machineName = `ogb-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(botId).digest("hex").slice(0, 6)}`;

beforeAll(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://boat.test");
    req.resume();
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", path: url.pathname, auth: String(req.headers.authorization ?? "") });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (rejectCredentials) return send(401, { ok: false, code: "unauthorized", message: "This cloud computer key is not valid." });
      if (serverError) return send(500, { ok: false, message: "internal error" });
      // Boat speaks its public API v1; the Admin relay at /api/box/v1 still speaks the old box dialect, and at /api/v1, v1.
      const [, base = "", rest = ""] = /^(\/boat\/api\/v1|\/relay\/api\/box\/v1|\/relay\/api\/v1)(\/.*)$/.exec(url.pathname) ?? [];
      const legacy = base === "/relay/api/box/v1";
      const [root, one, many] = legacy ? ["/boxes", "box", "boxes"] : ["/sandboxes", "sandbox", "sandboxes"];
      if (rest === root && dropLists > 0) { dropLists--; return void req.socket.destroy(); }
      if (rest === root) return send(200, { ok: true, [many]: [{ id: boxId, name: machineName, state }] });
      if (rest === `${root}/${boxId}` && req.method === "GET") return send(200, { ok: true, [one]: { id: boxId, name: machineName, state } });
      if (rest === `${root}/${boxId}` && req.method === "DELETE") {
        // Boat's operation, passed through as each dialect names its kind.
        return send(202, { ok: true, operation: { id: OPERATION_ID, kind: legacy ? "box" : "sandbox", targetId: boxId, status: "completed" } });
      }
      if (rest === `${root}/${boxId}/resume`) {
        const reply = resumeReplies.length > 1 ? resumeReplies.shift()! : resumeReplies[0] ?? { status: 202, body: { ok: true } };
        if (reply.status < 300 && wakeOnResume) state = "idle";
        return send(reply.status, reply.body);
      }
      if (rest === `${root}/${boxId}/desktop`) return send(200, { desktopUrl: "https://desktop.example.test/session" });
      if (rest === `${root}/${boxId}/commands`) return send(200, { exitCode: 0, stdout: "", stderr: "" });
      send(404, { ok: false, code: "not_found", message: `unexpected ${req.method} ${url.pathname}` });
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(async () => {
  requests.length = 0;
  state = "ready";
  resumeReplies = [];
  rejectCredentials = false;
  serverError = false;
  dropLists = 0;
  wakeOnResume = true;
  vi.stubEnv("BOX_TOKEN", undefined);
  vi.stubEnv("OMB_BOAT_API", `${base}/boat/api/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_URL", `${base}/relay/api/box/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", INCLUDED);
  boat ??= await import("./boat.ts");
  loadConfig ??= (await import("./config.ts")).loadConfig;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("included Boat computers", () => {
  it("with no own key, uses the included token and only the relay", async () => {
    await boat.execOnBoat({}, botId, "true");
    expect(underRelay().length).toBeGreaterThan(0);
    expect(underBoat()).toEqual([]);
    expect(requests.every((request) => request.auth === `Bearer ${INCLUDED}`)).toBe(true);
  });

  it("an own key saved in Settings wins and goes only to Boat", async () => {
    await boat.execOnBoat({ box: { token: "box_own" } }, botId, "true");
    expect(underBoat().length).toBeGreaterThan(0);
    expect(underRelay()).toEqual([]);
    expect(requests.every((request) => request.auth === "Bearer box_own")).toBe(true);
  });

  it("an own key from the environment (BOX_TOKEN) wins and goes only to Boat", async () => {
    vi.stubEnv("BOX_TOKEN", "box_from_env");
    const cfg = loadConfig();
    expect(cfg.box?.token).toBe("box_from_env");
    await boat.execOnBoat(cfg, botId, "true");
    expect(underRelay()).toEqual([]);
    expect(requests.every((request) => request.path.startsWith("/boat/") && request.auth === "Bearer box_from_env")).toBe(true);
  });

  it("removing the own key falls back to the included one", async () => {
    const cfg: AppConfig = { box: { token: "box_own" } };
    await boat.execOnBoat(cfg, botId, "true");
    expect(underRelay()).toEqual([]);
    requests.length = 0;
    cfg.box!.token = "";
    await boat.execOnBoat(cfg, botId, "true");
    expect(underBoat()).toEqual([]);
    expect(requests.every((request) => request.auth === `Bearer ${INCLUDED}`)).toBe(true);
  });

  it("a cloud computer tool call with the included token still reaches only the relay", async () => {
    await boat.runCommand({ box: { token: boat.boatAccount({})!.token } }, boxId, "true");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: `/relay/api/box/v1/boxes/${boxId}/commands`, auth: `Bearer ${INCLUDED}` });
  });

  it("speaks v1 to Boat and the relay's own box dialect to a relay wired at /api/box/v1", async () => {
    await boat.execOnBoat({ box: { token: "box_own" } }, botId, "true");
    await boat.execOnBoat({}, botId, "true");
    expect(underBoat().every((request) => request.path.startsWith("/boat/api/v1/sandboxes"))).toBe(true);
    expect(underRelay().every((request) => request.path.startsWith("/relay/api/box/v1/boxes"))).toBe(true);
    for (const side of [underBoat(), underRelay()]) {
      expect(side.filter((request) => request.method === "POST" && request.path.endsWith(`/${boxId}/commands`))).toHaveLength(1);
    }
  });

  it("follows a delete through the box-dialect relay to completion", async () => {
    const owners = [{ botId, name: "Included", inUse: false }];
    await expect(boat.deleteManagedBoat({}, owners, boxId, machineName, undefined, { pollDelaysMs: [] })).resolves.toEqual({ ok: true });
    expect(requests.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual([`/relay/api/box/v1/boxes/${boxId}`]);
    expect(underBoat()).toEqual([]);
  });

  it("speaks only v1 with an own key, whatever its base is called", async () => {
    vi.stubEnv("OMB_BOAT_API", `${base}/boat/api/box/v1`);
    await boat.runCommand({ box: { token: "box_own" } }, boxId, "true");
    expect(requests).toEqual([{ method: "POST", path: `/boat/api/box/v1/sandboxes/${boxId}/commands`, auth: "Bearer box_own" }]);
  });

  it("speaks v1 to a relay once the Admin wires a v1 base", async () => {
    vi.stubEnv("OMB_CLOUD_BOAT_URL", `${base}/relay/api/v1`);
    await boat.runCommand({}, boxId, "true");
    expect(requests).toEqual([{ method: "POST", path: `/relay/api/v1/sandboxes/${boxId}/commands`, auth: `Bearer ${INCLUDED}` }]);
  });

  it("verifies a key being saved against Boat only, never the relay", async () => {
    expect(await boat.verifyToken("box_new")).toEqual({ ok: true });
    expect(requests).toEqual([{ method: "GET", path: "/boat/api/v1/sandboxes", auth: "Bearer box_new" }]);
  });

  it("tells a revoked Boat key (boat_, or box_ from before v1) from something that is no Boat key", async () => {
    rejectCredentials = true;
    const revoked = { ok: false, rejected: true, message: "boat.dev rejected that key — it may have been revoked or expired. Copy a fresh one from your boat.dev account." };
    expect(await boat.verifyToken("boat_revoked")).toEqual(revoked);
    expect(await boat.verifyToken("box_revoked")).toEqual(revoked);
    expect(await boat.verifyToken("sk-ant-not-a-boat-key")).toEqual({ ok: false, rejected: true, message: expect.stringMatching(/^That doesn't look like a Boat API key: they start with boat_/) });
  });

  it("does not call a key rejected when boat.dev could not check it", async () => {
    serverError = true;
    expect(await boat.verifyToken("boat_maybe")).toEqual({ ok: false, message: "boat.dev returned 500 for that token — try again in a moment." });
  });

  it("lists the computers with the included wording when the relay rejects its token", async () => {
    rejectCredentials = true;
    expect((await boat.listManagedBoats({}, [])).problem).toBe("The cloud computers included with your Cloud plan aren't available right now. Try again later.");
    expect((await boat.listManagedBoats({ box: { token: "box_own" } }, [])).problem).toMatch(/update it in Settings/);
  });

  it("lists again once after a dropped connection, and names MausBot Cloud's computer service when it stays unreachable", async () => {
    const lists = () => requests.filter((request) => request.path === "/relay/api/box/v1/boxes");
    dropLists = 1;
    await expect(boat.findBoat({}, "unlisted-bot")).resolves.toBeNull();
    expect(lists()).toHaveLength(2);
    dropLists = 2;
    await expect(boat.findBoat({}, "unlisted-bot")).rejects.toMatchObject({
      message: "Could not reach MausBot Cloud's computer service to list cloud computers — check your connection and refresh", status: 503, transient: true,
    });
    expect(lists()).toHaveLength(4);
    dropLists = 2;
    expect((await boat.listManagedBoats({ box: { token: "box_own" } }, [])).problem).toBe("Could not reach boat.dev to list cloud computers — check your connection and refresh");
    rejectCredentials = true;
    await expect(boat.findBoat({}, "unlisted-bot")).rejects.toMatchObject({ transient: false });
  });

  it("reports configured and included to Settings, never the token", () => {
    expect(boat.describeBoatAccount({})).toEqual({ configured: true, included: true });
    expect(boat.describeBoatAccount({ box: { token: "box_own" } })).toEqual({ configured: true });
    expect(JSON.stringify(boat.describeBoatAccount({}))).not.toContain(INCLUDED);
    vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
    expect(boat.boatConfigured({})).toBe(false);
    expect(boat.describeBoatAccount({})).toEqual({ configured: false });
  });
});

describe("waking a sleeping computer", () => {
  it("reports a refused resume with the relay's own words instead of waiting out the budget", async () => {
    state = "archived";
    resumeReplies = [{ status: 429, body: { ok: false, type: "sandbox.error", status: 429, code: "limit_reached", message: LIMIT, error: { code: "limit_reached", message: LIMIT, status: 429 } } }];
    const started = Date.now();
    await expect(boat.readyBoat({}, botId)).rejects.toThrow(LIMIT);
    await expect(boat.joinBoat({}, botId)).rejects.toThrow(LIMIT);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(requests.filter((request) => request.path.endsWith("/resume"))).toHaveLength(2);
    expect(underBoat()).toEqual([]);
  });

  it("keeps waiting through a conflict, which is a wake already under way", async () => {
    state = "archived";
    resumeReplies = [{ status: 409, body: { ok: false, code: "conflict", message: "already resuming" } }];
    await expect(boat.readyBoat({}, botId, 1)).resolves.toBeNull();
  });

  it("retries a server error on the next poll, as Boat asks, and wakes", async () => {
    state = "archived";
    resumeReplies = [
      { status: 503, body: { ok: false, code: "unavailable", message: "Boat is busy" } },
      { status: 202, body: { ok: true } },
    ];
    // Own key here: this is everyone's wake path, not only Cloud Pro's.
    await expect(boat.readyBoat({ box: { token: "box_own" } }, botId)).resolves.toMatchObject({ id: boxId, state: "idle" });
    expect(requests.filter((request) => request.path.endsWith("/resume"))).toHaveLength(2);
  }, 15_000);

  it("reports the last server error, not a bare timeout, when the wait runs out on it", async () => {
    state = "archived";
    resumeReplies = [{ status: 503, body: { ok: false, code: "unavailable", message: "Boat is busy" } }];
    // One poll fits the budget (each request ends with it, so it must leave
    // room for one read and one resume); the next would come after it.
    await expect(boat.readyBoat({ box: { token: "box_own" } }, botId, 2_000)).rejects.toThrow("waking the cloud computer failed: Boat is busy");
  });

  it("forgets a server error once a later resume is accepted", async () => {
    state = "archived";
    wakeOnResume = false;
    resumeReplies = [
      { status: 503, body: { ok: false, code: "unavailable", message: "Boat is busy" } },
      { status: 202, body: { ok: true } },
    ];
    // Two polls fit the budget: 503, then an accepted resume that is still
    // waking, with room left for the second poll's requests, which end with
    // the budget too.
    await expect(boat.readyBoat({ box: { token: "box_own" } }, botId, 4_000)).resolves.toBeNull();
    // A third poll can start when a timer fires a hair before the deadline;
    // what matters is that the 503 came first and was then forgotten.
    expect(requests.filter((request) => request.path.endsWith("/resume")).length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("never asks the person to fix a key they never pasted when the relay rejects the included token", async () => {
    state = "archived";
    resumeReplies = [{ status: 401, body: { ok: false, code: "unauthorized", message: "This cloud computer key is not valid." } }];
    await expect(boat.readyBoat({}, botId)).rejects.toThrow("The cloud computers included with your Cloud plan aren't available right now. Try again later.");
    await expect(boat.readyBoat({ box: { token: "box_own" } }, botId)).rejects.toThrow("boat.dev rejected your Boat API key — paste a current one in Settings → API keys");
  });
});
