import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { RoutineManager } from "../routines.ts";
import { Store } from "../store.ts";
import { createProactive, WATCH_NAME } from "./proactive.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { team?: boolean; driver?: string; configured?: () => boolean; cloud?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-proactive-"));
  dirs.push(dir);
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const chief = store.createBot({ name: "Chief" });
  store.setChiefOfStaff(chief.id);
  const reads: string[] = [];
  const relay = async (_cfg: AppConfig, payload: never) => {
    const frame = payload as { method: string; params?: { arguments?: { tools?: Array<{ tool_slug: string }> } } };
    if (frame.method === "tools/call") reads.push(frame.params!.arguments!.tools![0]!.tool_slug);
    return { status: 200, bytes: new TextEncoder().encode("{}"), transportSessionId: "s" };
  };
  let routines: RoutineManager | null = null;
  const make = () => createProactive({
    store, cfg: {} as AppConfig, dataDir: dir, team: options.team ?? false, routines: () => routines,
    composio: { configured: options.configured ?? (() => true), connectedServices: async () => ({ gmail: { connected: true }, googlecalendar: { connected: true } }), relayMcp: relay },
    registry: { get: () => ({ driverKind: options.driver ?? "claudeAgent", adapter: {} as never }) },
    mainThread: (botId) => store.bot(botId)?.threadId, threadBusy: () => false, notify: () => {}, engineName: () => "Claude", needsYou: () => [],
    hostTimeZone: () => "UTC", decide: () => {}, stale: () => false, release: () => {}, owned: () => {},
    ...(options.cloud !== undefined ? { cloud: options.cloud } : {}),
  });
  const proactive = make();
  routines = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "t" }), startTurn: async () => {}, checks: proactive.checks });
  return { store, chief, proactive, make, reads, routines: () => routines! };
}

describe("the Chief's default watch", () => {
  it("is made once on a personal install, and never made again once it is deleted", () => {
    const s = setup();
    const watch = s.proactive.ensureWatch()!;
    expect(watch).toMatchObject({ name: WATCH_NAME, botId: s.chief.id, checks: ["calendar", "mail", "runs"], access: "read-and-draft", deliver: "brief", enabled: true });
    expect(s.proactive.ensureWatch()).toBeNull();
    s.routines().remove(watch.id);
    expect(s.make().ensureWatch()).toBeNull();
    expect(s.routines().listRoutines()).toEqual([]);
  });

  it("waits for connected apps: none on an install that cannot reach them, and made within a minute once it can", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let configured = false;
    const s = setup({ configured: () => configured });
    expect(s.proactive.ensureWatch()).toBeNull();
    s.proactive.start();
    vi.advanceTimersByTime(60_000);
    expect(s.routines().listRoutines()).toEqual([]);
    configured = true;
    vi.advanceTimersByTime(60_000);
    s.proactive.stop();
    expect(s.routines().listRoutines().map((routine) => routine.name)).toEqual([WATCH_NAME]);
  });

  it("is never made on a hosted team workspace or a Team Cloud", () => {
    const s = setup({ team: true });
    expect(s.proactive.ensureWatch()).toBeNull();
    expect(s.routines().listRoutines()).toEqual([]);
  });

  it("is not made twice when one arrived with the Chief", () => {
    const s = setup();
    s.routines().create({ name: "Moved watch", prompt: "Watch.", botId: s.chief.id, schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 },
      checks: ["mail"], access: "read-and-draft", deliver: "brief" });
    expect(s.proactive.ensureWatch()!.name).toBe("Moved watch");
    expect(s.routines().listRoutines()).toHaveLength(1);
  });
});

describe("the watch's checks", () => {
  it("read nothing from an app the Chief may not use", async () => {
    const s = setup();
    const watch = s.proactive.ensureWatch()!;
    s.store.patchBot(s.chief.id, { connectorScopes: { apps: { googlecalendar: "read" } } });
    await s.proactive.checks.check(watch, { manual: true });
    expect(s.reads.some((slug) => slug.startsWith("GMAIL_"))).toBe(false);
    s.store.patchBot(s.chief.id, { composio: false, connectorScopes: undefined });
    s.reads.length = 0;
    await s.proactive.checks.check(watch, { manual: true });
    expect(s.reads).toEqual([]);
  });

  it("belong to the main agent only: a briefing routine of another bot reads nothing", async () => {
    const s = setup();
    const other = s.store.createBot({ name: "Scout" });
    const routine = s.routines().create({ name: "Scout brief", prompt: "Watch.", botId: other.id, schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 },
      checks: ["mail"], deliver: "brief" });
    expect(await s.proactive.checks.check(routine, { manual: true })).toEqual({});
    expect(s.reads).toEqual([]);
  });
});

describe("the suggestion to add a helper-model key", () => {
  const suggested = async (options: { cloud?: boolean; team?: boolean }) => {
    const s = setup(options);
    const watch = s.proactive.ensureWatch() ?? { id: "none", botId: s.chief.id, deliver: "brief", checks: ["mail"] } as never;
    await s.proactive.checks.check(watch, { manual: true });
    return s.store.messagesFor(s.store.bot(s.chief.id)!.threadId).filter((message) => message.setupSuggestion);
  };

  it("is posted once on a desktop with Gmail connected and no helper model", async () => {
    expect(await suggested({ cloud: false })).toHaveLength(1);
  });

  it("is never posted on Cloud, nor on a hosted team workspace or a Team Cloud", async () => {
    expect(await suggested({ cloud: true })).toEqual([]);
    expect(await suggested({ cloud: false, team: true })).toEqual([]);
    expect(await suggested({})).toEqual([]);
  });
});
