import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotHoldRoutes } from "../routes/bot-holds.ts";
import type { RouteContext } from "../routes/table.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createBotHolds } from "./bot-holds.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-bot-holds-"));
  dirs.push(dataDir);
  const bots = [
    { id: "ada", name: "Ada", section: "Sales" },
    { id: "bo", name: "Bo", section: "Sales" },
    { id: "cy", name: "Cy", section: "Support" },
    { id: "di", name: "Di" },
  ];
  const changed = vi.fn();
  const make = () => createBotHolds({ dataDir, bots: () => bots, changed,
    line: (_language, key, params) => `${key}:${params.bot}${params.department ? `:${params.department}` : ""}` });
  return { dataDir, bots, changed, make };
}

describe("pausing a bot or a department", () => {
  it("pauses one bot, or every bot in a department, and says which way it was paused", () => {
    const { make, changed } = setup();
    const holds = make();
    expect(holds.heldBots()).toEqual([]);
    expect(holds.set("bot", "cy", true).newlyHeld).toEqual(["cy"]);
    expect(holds.set("department", " Sales ", true).newlyHeld).toEqual(["ada", "bo"]);
    expect(holds.heldBots()).toEqual(["ada", "bo", "cy"]);
    expect(holds.held("di")).toBe(false);
    expect(holds.text("cy")).toBe("server.botHeld:Cy");
    expect(holds.text("ada")).toBe("server.botHeldDepartment:Ada:Sales");
    expect(holds.text("di")).toBeNull();
    expect(holds.handoff("ada")).toContain("@Ada is paused by the person (its Sales department is paused)");
    expect(holds.handoff("di")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("keeps the pause across restarts, in a file only this user reads", () => {
    const { make, dataDir } = setup();
    make().set("department", "Support", true);
    expect(make().heldBots()).toEqual(["cy"]);
    // Windows has no POSIX mode bits: Node reports 0o666 for any writable file there.
    if (process.platform !== "win32") expect(statSync(join(dataDir, "paused-bots.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dataDir, "paused-bots.json"), "utf8"))).toMatchObject({ bots: [], departments: ["Support"] });
  });

  it("resumes, follows a department's new name, and forgets what is gone", () => {
    const { make, bots } = setup();
    const holds = make();
    holds.set("bot", "di", true);
    holds.set("department", "Sales", true);
    expect(holds.set("department", "Sales", false).newlyHeld).toEqual([]);
    expect(holds.held("ada")).toBe(false);
    holds.set("department", "Sales", true);
    holds.rename("Sales", "Revenue");
    for (const bot of bots) if (bot.section === "Sales") bot.section = "Revenue";
    expect(holds.state().departments).toEqual(["Revenue"]);
    expect(holds.held("ada")).toBe(true);
    holds.forget("bot", "di");
    holds.forget("department", "Revenue");
    expect(holds.state()).toEqual({ bots: [], departments: [] });
  });
});

describe("pausing every bot", () => {
  it("holds every bot, says so, survives a restart, and ending it leaves the earlier pauses in place", () => {
    const { make, dataDir, bots } = setup();
    const holds = make();
    holds.set("bot", "cy", true);
    expect(holds.set("all", "", true).newlyHeld).toEqual(["ada", "bo", "di"]);
    expect(holds.state()).toEqual({ bots: ["cy"], departments: [], all: true });
    expect(holds.heldBots()).toEqual(["ada", "bo", "cy", "di"]);
    expect(holds.text("cy")).toBe("server.botHeldAll:Cy");
    expect(holds.handoff("di")).toContain("@Di is paused by the person (every bot is paused)");
    bots.push({ id: "ed", name: "Ed" });
    expect(holds.held("ed")).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "paused-bots.json"), "utf8"))).toMatchObject({ bots: ["cy"], all: true });
    expect(make().heldBots()).toEqual(["ada", "bo", "cy", "di", "ed"]);
    expect(holds.set("all", "", true).newlyHeld).toEqual([]);

    expect(holds.set("all", "", false).newlyHeld).toEqual([]);
    expect(holds.state()).toEqual({ bots: ["cy"], departments: [] });
    expect(holds.heldBots()).toEqual(["cy"]);
    expect(holds.text("cy")).toBe("server.botHeld:Cy");
    expect(make().state()).toEqual({ bots: ["cy"], departments: [] });
  });
});

describe("the pause routes", () => {
  function call(routes: ReturnType<typeof createBotHoldRoutes>, method: string, body?: unknown) {
    const out: { status?: number; body?: Record<string, unknown> } = {};
    return routes({ req: {} as never, res: {} as never, url: new URL("http://x/api/paused"), path: "/api/paused", method, auth: { kind: "loopback" } as never,
      json: ((_res: unknown, status: number, value: Record<string, unknown>) => { out.status = status; out.body = value; }) as never,
      readBody: (async () => body) as never,
    } as RouteContext).then(() => out);
  }

  it("pauses, stops only the bots that just became paused, records it, and resumes without stopping anything", async () => {
    const { make } = setup();
    const holds = make();
    const stop = vi.fn(async (ids: readonly string[]) => ids.length);
    const audit = vi.fn();
    const routes = createBotHoldRoutes({ holds, stop, audit,
      named: (kind, id) => (kind === "bot" ? ({ ada: "Ada", bo: "Bo" } as Record<string, string>)[id] ?? null : id === "Sales" ? "Sales" : null) });

    expect(await call(routes, "POST", { kind: "bot", id: "ada", paused: true })).toMatchObject({ status: 200, body: { bots: ["ada"], heldBots: ["ada"], stopped: 1 } });
    expect(await call(routes, "POST", { kind: "department", id: "Sales", paused: true })).toMatchObject({ status: 200, body: { heldBots: ["ada", "bo"], stopped: 1 } });
    expect(stop.mock.calls).toEqual([[["ada"]], [["bo"]]]);
    expect(await call(routes, "POST", { kind: "department", id: "Sales", paused: false })).toMatchObject({ status: 200, body: { heldBots: ["ada"], stopped: 0 } });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls.map(([entry]) => entry)).toEqual([
      { kind: "bot", id: "ada", name: "Ada", paused: true },
      { kind: "department", id: "Sales", name: "Sales", paused: true },
      { kind: "department", id: "Sales", name: "Sales", paused: false },
    ]);
    expect(await call(routes, "GET")).toMatchObject({ status: 200, body: { bots: ["ada"], departments: [], heldBots: ["ada"] } });
    expect(await call(routes, "POST", { kind: "bot", id: "nobody", paused: true })).toMatchObject({ status: 404 });
    expect(await call(routes, "POST", { kind: "room", id: "x", paused: true })).toMatchObject({ status: 400 });
  });

  it("pauses every bot in one call, stops the ones that were still working, and records it", async () => {
    const { make } = setup();
    const holds = make();
    holds.set("bot", "ada", true);
    const stop = vi.fn(async (ids: readonly string[]) => ids.length);
    const audit = vi.fn();
    const named = vi.fn(() => null);
    const routes = createBotHoldRoutes({ holds, stop, audit, named });

    expect(await call(routes, "POST", { kind: "all", paused: true })).toMatchObject({ status: 200, body: { all: true, bots: ["ada"], heldBots: ["ada", "bo", "cy", "di"], stopped: 3 } });
    expect(stop.mock.calls).toEqual([[["bo", "cy", "di"]]]);
    expect(await call(routes, "GET")).toMatchObject({ status: 200, body: { all: true, heldBots: ["ada", "bo", "cy", "di"] } });
    const resumed = await call(routes, "POST", { kind: "all", paused: false });
    expect(resumed).toMatchObject({ status: 200, body: { bots: ["ada"], heldBots: ["ada"], stopped: 0 } });
    expect(resumed.body).not.toHaveProperty("all");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(named).not.toHaveBeenCalled();
    expect(audit.mock.calls.map(([entry]) => entry)).toEqual([
      { kind: "all", id: "all", name: "Every bot", paused: true },
      { kind: "all", id: "all", name: "Every bot", paused: false },
    ]);
    expect(await call(routes, "POST", { kind: "all" })).toMatchObject({ status: 400 });
  });
});
