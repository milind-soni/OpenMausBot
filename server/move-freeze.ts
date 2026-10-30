// This computer's copy once the person's bots moved to their own Cloud: one marker, moved.json in the data folder. A
// frozen server admits no turns, runs no schedules, app events or memory upkeep, and answers every change but the
// move's own with one sentence. Nothing in the workspace is edited, so lifting the marker leaves this computer exactly
// as it was. A Cloud that ended, started only so its owner can take their things home (OMB_CLOUD_EXPORT_ONLY=1), runs
// frozen the same way and is never lifted.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { AppTriggerManager } from "./app-triggers.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { CalendarCallManager } from "./calendar-calls.ts";
import type { RoutineManager } from "./routines.ts";
import type { WaitManager } from "./waits.ts";
import type { WebhookManager } from "./webhooks.ts";

export const MOVED_REFUSAL = "This bot lives on My Cloud now.";
/** Why a frozen copy refuses, naming the server of the person's own its bots moved to (`place`), else My Cloud. */
export const movedRefusal = (place: string | null): string => (place ? `This bot lives on ${place} now.` : MOVED_REFUSAL);
/** The one page a frozen copy serves: the desktop app's screen while My Cloud can't be opened (electron/home-window.mjs). */
export const HOME_SCREEN = "/home";
/** The desktop window's own rail of places (electron/chrome-rail.mjs): this app's page, beside whichever place is open. */
export const RAIL_PAGE = "/rail";
/** A path whose last part has an extension is a file of the page (a script, a picture), never a page. */
const FILE = /\.[A-Za-z0-9]+$/u;
export const ENDED_REFUSAL = "My Cloud has ended. It is open only so you can take your things home.";

/** What a frozen server still changes: the freeze itself, the move's reads and lets-go, signing in and out, the backup
 * that takes things home, the Admin's signed routes, Files and the computers lent to it. */
const STILL_CHANGES = /^\/api\/(?:move\/|cloud-send\/|auth\/|workspace-backup\/|cloud\/|sync\/|shared-computers\/)/u;
const READS = new Set(["GET", "HEAD", "OPTIONS"]);
/** What a frozen copy keeps once its workspace is deleted: the marker, this server's identity, Files, downloaded tools
 * and caches, and its own runtime files. Everything else, credentials included, is the person's workspace. */
const DEVICE_STATE = new Set(["moved.json", "environment-id", "sync", "tools", "cache", ".cache", "tmp", ".tmp", "dist-native", "tunnel-runtime",
  ".openmausbot-server-child", "openmausbot-server.lease"]);
const kept = (name: string) => DEVICE_STATE.has(name) || name.startsWith("openmausbot-server.lease.");

export type MoveFreeze = ReturnType<typeof createMoveFreeze>;

/** This computer's automations, for a copy that lifts its freeze while another computer is the person's home. */
export interface MoveAutomations {
  routines(): Pick<RoutineManager, "listRoutines" | "update"> | null;
  calls(): Pick<CalendarCallManager, "list" | "switchOff"> | null;
  webhooks(): Pick<WebhookManager, "list" | "update"> | null;
  appEvents(): Pick<AppTriggerManager, "list" | "update"> | null;
  waits(): Pick<WaitManager, "all" | "cancel"> | null;
}

/** Switches off every automation that is on, or only those named by key ("routine:<id>", "call:<id>", "webhook:<id>",
 * "app-event:<id>", "wait:<id>"); the person can switch each on again by hand, and a wait is cancelled. Done while frozen,
 * so none of them runs once the freeze lifts. One that can't be switched off is logged, never a reason to stay frozen.
 * The keys of those switched off. */
export async function switchAutomationsOff(automations: MoveAutomations, only?: ReadonlySet<string>): Promise<string[]> {
  const done: string[] = [];
  const off = async (kind: string, id: string, work: () => unknown) => {
    const key = `${kind}:${id}`;
    if (only && !only.has(key)) return;
    try { await work(); done.push(key); } catch (error) { console.warn(`move freeze: could not switch ${kind} ${id} off (${(error as Error).message})`); }
  };
  const routines = automations.routines(), calls = automations.calls(), webhooks = automations.webhooks(), appEvents = automations.appEvents(), waits = automations.waits();
  for (const routine of routines?.listRoutines() ?? []) if (routine.enabled) await off("routine", routine.id, () => routines!.update(routine.id, { enabled: false }));
  for (const call of calls?.list() ?? []) if (call.nextRunAt !== null) await off("call", call.id, () => calls!.switchOff(call.id));
  for (const webhook of webhooks?.list() ?? []) if (webhook.enabled) await off("webhook", webhook.id, () => webhooks!.update(webhook.id, { enabled: false }));
  for (const trigger of appEvents?.list() ?? []) if (trigger.enabled) await off("app-event", trigger.id, () => appEvents!.update(trigger.id, { enabled: false }));
  for (const wait of waits?.all() ?? []) await off("wait", wait.id, () => { if (!waits!.cancel(wait.id, wait.botId)) throw new Error("it already ended"); });
  return done;
}

export function createMoveFreeze({ dataDir, exportOnly = false }: { dataDir: string; exportOnly?: boolean }) {
  const file = join(dataDir, "moved.json");
  let frozen = exportOnly || existsSync(file);
  const named = (field: "cloud" | "place"): string | null => {
    try { const value: unknown = JSON.parse(readFileSync(file, "utf8")); const named = Reflect.get(Object(value), field); return typeof named === "string" ? named : null; } catch { return null; }
  };
  let movedTo = frozen && !exportOnly ? named("cloud") : null;
  let place = frozen && !exportOnly ? named("place") : null;
  const held: Array<{ start(): void; stop(): void }> = [];
  const refusal = () => (frozen ? (exportOnly ? ENDED_REFUSAL : movedRefusal(place)) : null);
  const each = (step: "start" | "stop") => {
    for (const work of held) {
      try { work[step](); } catch (error) { console.warn(`move freeze: could not ${step} a schedule (${(error as Error).message})`); }
    }
  };

  return {
    frozen: () => frozen,
    /** The Cloud this computer's bots moved to, as the freeze named it. */
    cloud: () => movedTo,
    /** The server of the person's own this computer's bots moved to, by the name they know it by; null for My Cloud. */
    place: () => place,
    refusal,
    /** Where a page of this computer's frozen copy goes instead: its home screen, never the frozen workspace. The
     * window's rail stays the rail: it shows no workspace, only the places main lists. */
    screen(path: string): string | null {
      if (!frozen || exportOnly || path === HOME_SCREEN || path === RAIL_PAGE || FILE.test(path)) return null;
      return HOME_SCREEN;
    },
    /** Starts it now unless this server is frozen; a freeze stops it, and lifting the freeze starts it again. */
    hold(start: () => void, stop: () => void): void {
      held.push({ start, stop });
      if (!frozen) start();
    },
    assertTurns(): void {
      const said = refusal();
      if (said) throw Object.assign(new Error(said), { status: 409, code: "moved" });
    },
    /** Why a frozen server refuses this request, or null when it takes it. */
    refuses(method: string, path: string): string | null {
      return frozen && !READS.has(method.toUpperCase()) && !STILL_CHANGES.test(path) ? refusal() : null;
    },
    freeze(cloud: string | null, named: string | null = null): void {
      if (frozen) return;
      writeFileAtomic(file, JSON.stringify({ v: 1, at: Date.now(), ...(cloud ? { cloud } : {}), ...(named ? { place: named } : {}) }), { mode: 0o600 });
      frozen = true;
      movedTo = cloud;
      place = named;
      each("stop");
    },
    /** Deletes this computer's copy of the workspace, credentials included, once the move is long done; only a computer
     * frozen by a move ever does. The server starts again after, frozen and empty. */
    forget(): boolean {
      if (exportOnly || !existsSync(file)) return false;
      for (const name of readdirSync(dataDir)) if (!kept(name)) rmSync(join(dataDir, name), { recursive: true, force: true });
      return true;
    },
    /** False for a server that may never be lifted: a Cloud that ended. */
    lifts: () => !exportOnly,
    /** False when this server may never be lifted: a Cloud that ended. */
    unfreeze(): boolean {
      if (exportOnly) return false;
      if (!frozen) return true;
      rmSync(file, { force: true });
      frozen = false;
      movedTo = null;
      place = null;
      each("start");
      return true;
    },
  };
}
