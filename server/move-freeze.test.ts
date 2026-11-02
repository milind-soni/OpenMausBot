import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMoveFreeze, ENDED_REFUSAL, HOME_SCREEN, MOVED_REFUSAL, movedRefusal, RAIL_PAGE, switchAutomationsOff, type MoveAutomations } from "./move-freeze.ts";
import type { MoveWait } from "./move-waits.ts";
import { createMoveFreezeRoutes } from "./routes/move-freeze.ts";
import { PASS } from "./routes/table.ts";
import { WaitManager, type WaitNotice } from "./waits.ts";

const dirs: string[] = [];
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-move-freeze-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function schedule() {
  const log: string[] = [];
  return { log, start: () => log.push("start"), stop: () => log.push("stop") };
}

describe("this computer's copy, frozen at the move", () => {
  it("stops every schedule it holds, stays frozen across a restart, and starts them again when lifted", () => {
    const dir = dataDir();
    const freeze = createMoveFreeze({ dataDir: dir });
    const routines = schedule(), calls = schedule();
    freeze.hold(routines.start, routines.stop);
    freeze.hold(calls.start, calls.stop);
    expect([routines.log, calls.log]).toEqual([["start"], ["start"]]);

    freeze.freeze("https://omb-t-1.fly.dev");
    expect(freeze.frozen()).toBe(true);
    expect(existsSync(join(dir, "moved.json"))).toBe(true);
    expect([routines.log, calls.log]).toEqual([["start", "stop"], ["start", "stop"]]);
    freeze.freeze(null);
    expect(routines.log, "freezing twice stops nothing twice").toEqual(["start", "stop"]);

    const relaunched = createMoveFreeze({ dataDir: dir });
    const after = schedule();
    relaunched.hold(after.start, after.stop);
    expect(relaunched.frozen()).toBe(true);
    expect(after.log, "a frozen server never starts a schedule at launch").toEqual([]);
    expect(() => relaunched.assertTurns()).toThrow(MOVED_REFUSAL);

    expect(relaunched.unfreeze()).toBe(true);
    expect(after.log).toEqual(["start"]);
    expect(existsSync(join(dir, "moved.json"))).toBe(false);
    expect(() => relaunched.assertTurns()).not.toThrow();
  });

  it("refuses every change but the move's own, sign-in, Files, lending and the backup that takes things home", () => {
    const freeze = createMoveFreeze({ dataDir: dataDir() });
    expect(freeze.refuses("POST", "/api/bots/b1/messages")).toBeNull();
    freeze.freeze(null);
    for (const [method, path] of [["POST", "/api/bots/b1/messages"], ["PATCH", "/api/routines/r1"], ["POST", "/api/groups/g1/messages"], ["PUT", "/api/config"], ["DELETE", "/api/bots/b1"], ["POST", "/api/pair"]]) {
      expect(freeze.refuses(method!, path!), `${method} ${path}`).toBe(MOVED_REFUSAL);
    }
    for (const [method, path] of [["GET", "/api/bots"], ["DELETE", "/api/move/freeze"], ["DELETE", "/api/cloud-send/kind"], ["POST", "/api/cloud-send/chats/verify"],
      ["POST", "/api/auth/logout"], ["POST", "/api/workspace-backup/export"], ["POST", "/api/cloud/pairing"], ["POST", "/api/sync/upload"]]) {
      expect(freeze.refuses(method!, path!), `${method} ${path}`).toBeNull();
    }
  });

  it("serves only its home screen once frozen, never the frozen workspace, and names the Cloud the move went to", () => {
    const dir = dataDir();
    const freeze = createMoveFreeze({ dataDir: dir });
    for (const path of ["/", "/home", "/settings", "/assets/index-1a2b.js"]) expect(freeze.screen(path), path).toBeNull();
    expect(freeze.cloud()).toBeNull();
    freeze.freeze("https://omb-t-1.fly.dev");
    for (const path of ["/", "/settings", "/desktop-viewer", "/pair", "/chats/b1"]) expect(freeze.screen(path), path).toBe(HOME_SCREEN);
    for (const path of [HOME_SCREEN, RAIL_PAGE, "/assets/index-1a2b.js", "/favicon.svg", "/manifest.webmanifest"]) expect(freeze.screen(path), path).toBeNull();
    expect(freeze.cloud()).toBe("https://omb-t-1.fly.dev");
    expect(createMoveFreeze({ dataDir: dir }).cloud(), "after a restart too").toBe("https://omb-t-1.fly.dev");
    freeze.unfreeze();
    expect([freeze.screen("/"), freeze.cloud()]).toEqual([null, null]);
    expect(createMoveFreeze({ dataDir: dataDir(), exportOnly: true }).screen("/"), "an ended Cloud's own page is never this computer's screen").toBeNull();
  });

  it("a Cloud that ended, open only for its owner's export, is frozen from the start and never lifted", () => {
    const freeze = createMoveFreeze({ dataDir: dataDir(), exportOnly: true });
    const routines = schedule();
    freeze.hold(routines.start, routines.stop);
    expect(routines.log).toEqual([]);
    expect(freeze.unfreeze()).toBe(false);
    expect(freeze.frozen()).toBe(true);
    expect(freeze.refuses("POST", "/api/bots/b1/messages")).toBe(ENDED_REFUSAL);
  });
});

describe("switching this computer's automations off for a move", () => {
  it("cancels every wait, one already over but not yet posted too, so none posts, notifies or follows up once the freeze lifts", async () => {
    const present = new Set<string>();
    let chatBusy = true, clock = Date.UTC(2026, 9, 27, 9, 0);
    const posts: WaitNotice[] = [], followUps: string[] = [], cards: string[][] = [];
    const waits = new WaitManager({
      file: join(dataDir(), "waits.json"), now: () => clock, probes: { stamp: async (path) => (present.has(path) ? { size: 1, mtimeMs: 1 } : null) },
      sourceAlive: () => true, botBusy: () => false,
      post: (_wait, notice) => { if (chatBusy) return false; posts.push(notice); return true; },
      followUp: (wait) => { followUps.push(wait.label); },
      showCard: (wait) => `card-${wait.id}`,
      settleCard: (wait, how) => { cards.push([wait.label, how]); },
    });
    const made = async (botId: string, label: string, path: string) => {
      const result = await waits.create({ botId, threadId: `t-${botId}`, label, condition: { kind: "file_exists", path }, followUp: "Tell them." });
      if (result.state !== "created") throw new Error(result.state);
      return result.wait.id;
    };
    const report = await made("b1", "the report", "/report"), build = await made("b2", "the build", "/build");
    present.add("/build");
    clock += 5_000;
    await waits.tick();
    expect(waits.all().map((wait) => [wait.label, wait.ending?.status])).toEqual([["the report", undefined], ["the build", "fired"]]);

    const automations: MoveAutomations = { routines: () => null, calls: () => null, webhooks: () => null, appEvents: () => null, waits: () => waits };
    expect(await switchAutomationsOff(automations, new Set(["routine:r1"])), "only what is named").toEqual([]);
    expect(waits.all()).toHaveLength(2);
    expect(await switchAutomationsOff(automations)).toEqual([`wait:${report}`, `wait:${build}`]);
    expect(cards).toEqual([["the report", "cancelled"], ["the build", "cancelled"]]);
    expect(waits.all()).toEqual([]);

    chatBusy = false;
    present.add("/report");
    clock += 5_000;
    await waits.tick();
    expect([posts, followUps]).toEqual([[], []]);
  });
});

describe("/api/move/freeze", () => {
  const ask = async (route: ReturnType<typeof createMoveFreezeRoutes>, method: string, path = "/api/move/freeze", body: unknown = {}, kind = "loopback") => {
    let answered: { status: number; body: any } | undefined;
    const out = await route({ path, method, url: new URL(`http://127.0.0.1${path}`), req: {} as never, res: {} as never, auth: { kind, scopes: ["admin"] } as never,
      json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
    return out === PASS ? "pass" : answered!;
  };

  it("freezes only at a quiet moment, names who is still working, and lifts", async () => {
    let busy: MoveWait | null = { name: "Scout", what: "bot" };
    const freeze = createMoveFreeze({ dataDir: dataDir() });
    const route = createMoveFreezeRoutes({ freeze, busy: () => busy, restart() {} });
    expect(await ask(route, "GET")).toEqual({ status: 200, body: { frozen: false, busy: "Scout", what: "bot" } });
    expect(await ask(route, "POST", undefined, { cloud: "https://omb-t-1.fly.dev" })).toMatchObject({ status: 409, body: { busy: "Scout", what: "bot" } });
    expect(freeze.frozen()).toBe(false);
    busy = { name: "", what: "sign-in" };
    expect(await ask(route, "POST", undefined, { cloud: "https://omb-t-1.fly.dev" }), "no name: what it is").toMatchObject({ status: 409, body: { busy: "", what: "sign-in" } });
    busy = null;
    expect(await ask(route, "POST", undefined, { cloud: "https://omb-t-1.fly.dev" })).toEqual({ status: 200, body: { frozen: true } });
    expect(await ask(route, "GET"), "the desktop learns which Cloud, even with its journal lost").toEqual({ status: 200, body: { frozen: true, cloud: "https://omb-t-1.fly.dev" } });
    expect(await ask(route, "POST", "/api/bots/b1/messages")).toEqual({ status: 409, body: { error: MOVED_REFUSAL, code: "moved" } });
    expect(await ask(route, "GET", "/api/bots")).toBe("pass");
    busy = { name: "Scout", what: "bot" };
    expect(await ask(route, "POST"), "freezing again is a no-op, however busy").toEqual({ status: 200, body: { frozen: true } });
    expect(await ask(route, "DELETE")).toEqual({ status: 200, body: { frozen: false } });
    expect(await ask(route, "POST", "/api/bots/b1/messages")).toBe("pass");
  });

  it("a move to a server of the person's own names it: every refusal says where the bots live now, across a restart too", async () => {
    const dir = dataDir();
    const route = createMoveFreezeRoutes({ freeze: createMoveFreeze({ dataDir: dir }), busy: () => null, restart() {} });
    expect(await ask(route, "POST", undefined, { cloud: "https://garage.example.test", place: "Garage server" })).toEqual({ status: 200, body: { frozen: true } });
    expect(await ask(route, "GET")).toEqual({ status: 200, body: { frozen: true, cloud: "https://garage.example.test", place: "Garage server" } });
    expect(await ask(route, "POST", "/api/bots/b1/messages")).toEqual({ status: 409, body: { error: "This bot lives on Garage server now.", code: "moved" } });
    const relaunched = createMoveFreeze({ dataDir: dir });
    expect([relaunched.place(), relaunched.refusal()]).toEqual(["Garage server", movedRefusal("Garage server")]);
    expect(relaunched.unfreeze()).toBe(true);
    expect([relaunched.place(), movedRefusal(null)]).toEqual([null, MOVED_REFUSAL]);
    expect(await ask(route, "POST", undefined, { cloud: "https://garage.example.test", place: "x".repeat(121) }), "a name past 120 characters").toMatchObject({ status: 400 });
  });

  it("is only for OpenMausBot on this computer, never a paired device", async () => {
    const freeze = createMoveFreeze({ dataDir: dataDir() });
    const route = createMoveFreezeRoutes({ freeze, busy: () => null, restart() {} });
    expect(await ask(route, "POST", undefined, {}, "session")).toMatchObject({ status: 403 });
    expect(freeze.frozen()).toBe(false);
  });
});

describe("POST /api/move/forget", () => {
  it("deletes the frozen copy's workspace, credentials included, keeps only device state, and starts the server again", async () => {
    const dir = dataDir();
    for (const name of ["config.json", "messages.db", "logins.json", "routines.json", "environment-id"]) writeFileSync(join(dir, name), "{}");
    for (const name of ["workspaces/b1", "memory", "sync/state", "tools/bin", ".backups/safety-1"]) mkdirSync(join(dir, name), { recursive: true });
    let restarted = 0;
    const freeze = createMoveFreeze({ dataDir: dir });
    const route = createMoveFreezeRoutes({ freeze, busy: () => null, restart: () => { restarted++; } });
    const forget = async (kind = "loopback") => {
      let answered: { status: number; body: any } | undefined;
      await route({ path: "/api/move/forget", method: "POST", url: new URL("http://127.0.0.1/api/move/forget"), req: {} as never, res: {} as never,
        auth: { kind, scopes: ["admin"] } as never, json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => ({}) } as never);
      return answered!;
    };
    expect(await forget(), "a computer that never moved keeps everything").toMatchObject({ status: 409 });
    expect(readdirSync(dir)).toContain("config.json");
    freeze.freeze("https://omb-t-1.fly.dev");
    expect(await forget("session")).toMatchObject({ status: 403 });
    expect(await forget()).toEqual({ status: 200, body: { forgot: true } });
    expect(readdirSync(dir).sort()).toEqual(["environment-id", "moved.json", "sync", "tools"]);
    expect(restarted).toBe(1);
    expect(createMoveFreeze({ dataDir: dir }).frozen(), "it starts again frozen").toBe(true);
    expect(createMoveFreeze({ dataDir: dir, exportOnly: true }).forget(), "a Cloud never deletes itself").toBe(false);
  });
});
