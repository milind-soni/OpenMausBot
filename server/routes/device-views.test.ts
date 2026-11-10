import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createDeviceViewRoutes, openDevicePairing, pairingView, snapshotsAfterViewChanges, TEAM_VIEW_REFUSAL, type DeviceViewRouteDeps } from "./device-views.ts";

const VIEW = { sections: ["Ops"], bots: [], groups: [] };

async function patch(body: unknown, options: { deps?: Partial<DeviceViewRouteDeps>; auth?: RequestAuth; id?: string } = {}) {
  const id = options.id ?? "s-1";
  const route = createDeviceViewRoutes({
    sessions: { setView: (session, next) => (session === "s-1" ? { id: session, view: next } : null) as never },
    store: { bot: () => ({}) as never, group: () => ({}) as never, sections: ["Ops"] },
    team: false,
    ...options.deps,
  });
  const answers: Array<{ status: number; body: unknown; limit: number }> = [];
  let limit = 0;
  await route({
    req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://x/api/auth/sessions/${id}`), path: `/api/auth/sessions/${id}`, method: "PATCH",
    auth: options.auth ?? ({ kind: "loopback" } as RequestAuth),
    json: ((_res: ServerResponse, status: number, answer: unknown) => { answers.push({ status, body: answer, limit }); }) as never,
    readBody: (async (_req: IncomingMessage, max: number) => { limit = max; return body; }) as never,
  });
  return answers[0]!;
}

describe("the view a new pairing code grants", () => {
  const store = { bot: () => ({}) as never, group: () => undefined, sections: ["Ops"] };
  it("grants none unless the body names one, and refuses one a Team Cloud or the store cannot honour", () => {
    expect(pairingView(undefined, store, true)).toEqual({ ok: true });
    expect(pairingView(null, store, false)).toEqual({ ok: true });
    expect(pairingView(VIEW, store, false)).toEqual({ ok: true, view: VIEW });
    expect(pairingView(VIEW, store, true)).toEqual({ ok: false, status: 409, error: TEAM_VIEW_REFUSAL });
    expect(pairingView({ sections: [], bots: [], groups: ["g"] }, store, false)).toEqual({ ok: false, status: 400, error: "no such channel" });
  });
});

describe("POST /api/auth/pairing with a view", () => {
  const store = { bot: () => ({}) as never, group: () => undefined, sections: ["Ops"] };
  const opening = () => {
    const asked: unknown[] = [];
    const sessions = { openPairing: (input: unknown) => { asked.push(input); return { id: "p1", code: "ABCDEFGH", credential: "c", expiresAt: 0 }; } };
    return { asked, sessions: sessions as unknown as Parameters<typeof openDevicePairing>[1] };
  };

  it("keeps how long the code and an access token last, beside the view", () => {
    const { asked, sessions } = opening();
    const view = { sections: ["Ops"], bots: [], groups: [] };
    expect(openDevicePairing({ label: "CI", scopes: ["client"], ttlMs: 120_000, tokenTtlMs: 3_600_000, view }, sessions, store, false)).toMatchObject({ ok: true });
    expect(asked).toEqual([{ label: "CI", scopes: ["client"], ttlMs: 120_000, tokenTtlMs: 3_600_000, view }]);
  });

  it("refuses a lifetime out of range before any code is opened", () => {
    const { asked, sessions } = opening();
    expect(openDevicePairing({ ttlMs: 59_999 }, sessions, store, false)).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("24 hours") });
    expect(asked).toEqual([]);
  });
});

describe("PATCH a device's view", () => {
  it("reads a body as large as the biggest view pairing accepts", async () => {
    const ids = (prefix: string) => Array.from({ length: 50 }, (_, i) => `${prefix}${String(i).padStart(2, "0")}-${"0".repeat(32)}`);
    const view = { sections: Array.from({ length: 50 }, (_, i) => `Department ${i}`), bots: ids("b"), groups: ids("g") };
    let reads = 0;
    const store = { bot: () => ({}) as never, group: () => ({}) as never, get sections() { reads += 1; return view.sections; } };
    const answer = await patch({ view }, { deps: { store } });
    expect(answer.limit).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify({ view })));
    expect(answer.status).toBe(200);
    expect(reads, "the departments are read once, not once per department named").toBe(1);
  });

  it("refuses what it cannot apply, each with its own answer", async () => {
    expect(await patch({ view: VIEW }, { deps: { team: true } })).toMatchObject({ status: 409, body: { error: TEAM_VIEW_REFUSAL } });
    const self = { kind: "session", session: { id: "s-1" } } as RequestAuth;
    expect(await patch({ view: VIEW }, { auth: self })).toMatchObject({ status: 409, body: { error: "Change this device's view from another device." } });
    expect(await patch({ view: VIEW }, { id: "gone" })).toMatchObject({ status: 404 });
    expect(await patch({ view: VIEW, scopes: ["admin"] })).toMatchObject({ status: 400 });
    expect(await patch({ view: { sections: ["Finance"], bots: [], groups: [] } })).toMatchObject({ status: 400, body: { error: "no such department" } });
    const personal = { setView: () => { throw Object.assign(new Error("Only admin devices can connect here."), { status: 403, code: "cloud_personal" }); } };
    expect(await patch({ view: VIEW }, { deps: { sessions: personal } })).toMatchObject({ status: 403, body: { code: "cloud_personal" } });
  });

  it("lifts a limit with null", async () => {
    expect(await patch({ view: null })).toMatchObject({ status: 200, body: { session: { id: "s-1", view: null } } });
  });
});

describe("a session whose view changed", () => {
  it("closes its streams and starts over from the seq it changed at, until it is revoked", () => {
    const changed: Array<(id: string) => void> = [];
    const revoked: Array<(id: string) => void> = [];
    const closed: string[] = [];
    let seq = 7;
    const snapshots = snapshotsAfterViewChanges({
      onSessionChanged: (listener) => { changed.push(listener); return () => {}; },
      onSessionRevoked: (listener) => { revoked.push(listener); return () => {}; },
    }, () => seq, (id) => closed.push(id));
    expect(snapshots.from("s-1")).toBe(-1);
    changed.forEach((listener) => listener("s-1"));
    expect(closed).toEqual(["s-1"]);
    seq = 9;
    expect(snapshots.from("s-1")).toBe(7);
    snapshots.mark("s-2");
    expect(snapshots.from("s-2")).toBe(9);
    revoked.forEach((listener) => listener("s-1"));
    expect(snapshots.from("s-1")).toBe(-1);
  });
});
