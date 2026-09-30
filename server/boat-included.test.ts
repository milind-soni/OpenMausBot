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

let api: Server;
let base = "";
let state = "ready";
/** Whether an accepted resume wakes the computer at once. */
let wakeOnResume = true;
/** When set, every request is refused as an invalid credential. */
let rejectCredentials = false;
/** Replies to POST /resume in order; the last one repeats. A 2xx wakes the computer. */
let resumeReplies: Array<{ status: number; body: unknown }> = [];
const requests: Array<{ method: string; path: string; auth: string }> = [];
let boat: typeof import("./boat.ts");
let loadConfig: typeof import("./config.ts").loadConfig;

const underBoat = () => requests.filter((request) => request.path.startsWith("/boat/"));
const underRelay = () => requests.filter((request) => request.path.startsWith("/relay/"));

beforeAll(async () => {
  // The legacy deterministic name findBoat still recognises (boat-lifecycle.test.ts).
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
  const machineName = `ogb-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${hash}`;
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
      const path = url.pathname.replace(/^\/(boat|relay)\/api\/box\/v1/, "");
      if (path === "/boxes") return send(200, { boxes: [{ id: boxId, name: machineName, state }] });
      if (path === `/boxes/${boxId}` && req.method === "GET") return send(200, { ok: true, box: { id: boxId, name: machineName, state } });
      if (path === `/boxes/${boxId}/resume`) {
        const reply = resumeReplies.length > 1 ? resumeReplies.shift()! : resumeReplies[0] ?? { status: 202, body: { ok: true } };
        if (reply.status < 300 && wakeOnResume) state = "idle";
        return send(reply.status, reply.body);
      }
      if (path === `/boxes/${boxId}/desktop`) return send(200, { desktopUrl: "https://desktop.example.test/session" });
      if (path.endsWith("/commands")) return send(200, { exitCode: 0, stdout: "", stderr: "" });
      send(200, { ok: true });
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
  wakeOnResume = true;
  vi.stubEnv("BOX_TOKEN", undefined);
  vi.stubEnv("OMB_BOX_API", `${base}/boat/api/box/v1`);
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

  it("a leased descriptor carrying the included token still reaches only the relay", async () => {
    // What chat-boat-tools.ts builds from integrations.computer.
    await boat.runCommand({ box: { token: boat.boatAccount({})!.token } }, boxId, "true");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: `/relay/api/box/v1/boxes/${boxId}/commands`, auth: `Bearer ${INCLUDED}` });
  });

  it("verifies a key being saved against Boat only, never the relay", async () => {
    expect(await boat.verifyToken("box_new")).toEqual({ ok: true });
    expect(requests).toEqual([{ method: "GET", path: "/boat/api/box/v1/boxes", auth: "Bearer box_new" }]);
  });

  it("lists the computers with the included wording when the relay rejects its token", async () => {
    rejectCredentials = true;
    expect((await boat.listManagedBoats({}, [])).problem).toBe("Cloud Pro's included cloud computers aren't available right now. Try again later.");
    expect((await boat.listManagedBoats({ box: { token: "box_own" } }, [])).problem).toMatch(/update it in Settings/);
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
    await expect(boat.readyBoat({ box: { token: "box_own" } }, botId, 1)).rejects.toThrow("waking the cloud computer failed: Boat is busy");
  });

  it("forgets a server error once a later resume is accepted", async () => {
    state = "archived";
    wakeOnResume = false;
    resumeReplies = [
      { status: 503, body: { ok: false, code: "unavailable", message: "Boat is busy" } },
      { status: 202, body: { ok: true } },
    ];
    // Two polls fit the budget: 503, then an accepted resume that is still waking.
    await expect(boat.readyBoat({ box: { token: "box_own" } }, botId, 3_000)).resolves.toBeNull();
    expect(requests.filter((request) => request.path.endsWith("/resume"))).toHaveLength(2);
  }, 15_000);

  it("never asks the person to fix a key they never pasted when the relay rejects the included token", async () => {
    state = "archived";
    resumeReplies = [{ status: 401, body: { ok: false, code: "unauthorized", message: "This cloud computer key is not valid." } }];
    await expect(boat.readyBoat({}, botId)).rejects.toThrow("Cloud Pro's included cloud computers aren't available right now. Try again later.");
    // The same refusal on the person's own key still points them at Settings.
    await expect(boat.readyBoat({ box: { token: "box_own" } }, botId)).rejects.toThrow(/paste a current token/);
  });
});
