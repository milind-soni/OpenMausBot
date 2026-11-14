// A release with a new Local VM image leaves every existing desktop on the old one, which it can no longer run. This updates
// them by itself: prepare the new image once, then recreate each old desktop while nothing uses it, keeping its durable folder
// and website sign-ins. Until then the bot's own place is unavailable: a turn never moves its work to this computer instead.
import {
  containerRuntimeStatus,
  localVmWorkspaceExists,
  perBotLocalVmTarget,
  poolLocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
  type ContainerComputerStatus,
  type LocalVmTarget,
} from "./container-computer.ts";
import { discoverExistingPerBotLocalVms, discoverExistingPoolLocalVms, shouldArmLocalVmIdle, type LocalVmInventoryBot } from "./local-vm-inventory.ts";
import { keepFirefoxProfileBeforeRemove, keepInstalledAppsBeforeRemove } from "./local-vm-profiles.ts";

export type LocalVmUpdateNeed = "image" | "recreate";

/** A desktop OpenMausBot made, or a durable folder left by one, that this release cannot run without updating. */
export function localVmUpdateNeed(status: ContainerComputerStatus, workspaceExists: boolean): LocalVmUpdateNeed | null {
  if (!status.runtime || !status.daemonUp) return null;
  if (status.container === "missing") return workspaceExists && !status.image && status.create_supported ? "image" : null;
  if (!status.managed || status.imageMatches) return null;
  return status.image ? "recreate" : "image";
}

/** A VPS desktop OpenMausBot made whose image this release no longer runs. Replacing it deletes its files, so a person does it. */
export function vpsDesktopOutdated(status: {
  configured?: boolean; daemonUp?: boolean; container?: string; managed?: boolean; imageMatches?: boolean;
} | null | undefined): boolean {
  return Boolean(status?.configured && status.daemonUp && status.container !== "missing" && status.managed && !status.imageMatches);
}

export const VPS_OUTDATED_HINT =
  "Its VPS desktop runs an older version: the person can replace it from this bot's Computer panel, which deletes the files on it.";

export const HOST_WHILE_UPDATING = "This bot's own desktop is being updated or needs updating, so it does not use this computer instead.";

/** select_computer offers this computer to no bot whose own desktop awaits its update, or "auto" would land the work there. */
export function withoutHostWhileUpdating<T extends { surface: string; available: boolean }>(options: T[], barred: boolean): T[] {
  return barred ? options.map((option) => option.surface === "local"
    ? { ...option, available: false, ready: false, canStart: false, canCreate: false, reason: HOST_WHILE_UPDATING } : option) : options;
}

export const LOCAL_VM_UPDATING =
  "Updating this bot's desktop to the new version, once after an app update; it usually takes a few minutes. Its durable folder and website sign-ins are kept.";
export const LOCAL_VM_UPDATING_PROBLEM =
  "Updating this desktop to the new version, once after an app update; it usually takes a few minutes. Its durable folder and website sign-ins are kept.";

export function localVmUpdateNote(failure: string | null): string {
  return failure
    ? ` This bot's Local VM desktop runs an older version and could not be updated automatically (${failure}), so no computer is mounted this turn. Work that needs no screen can go ahead. If the request needs the desktop, do not use another computer: say plainly that its desktop needs updating, and that the person can update it in App Settings → Computers.`
    : " This bot's Local VM desktop is being updated to the new version after an app update, which usually takes a few minutes, so no computer is mounted this turn. Work that needs no screen can go ahead. If the request needs the desktop, do not use another computer: say plainly that its desktop is being updated and will be ready in a few minutes.";
}

type BusyFlag = { get(): boolean; set(busy: boolean): void };

export interface LocalVmUpdaterDeps {
  status(target: LocalVmTarget): Promise<ContainerComputerStatus>;
  act(action: "pull" | "stop" | "remove" | "run", target: LocalVmTarget): Promise<ContainerComputerStatus>;
  imageBusy: BusyFlag;
  provisionBusy: BusyFlag;
  lifecycleBusy: Set<string>;
  /** A turn, a person's lifecycle action or a mode change holds it; the update waits rather than pull it away. */
  inUse(target: LocalVmTarget): boolean;
  updated(target: LocalVmTarget, status: ContainerComputerStatus): void;
  keepSignIns?: typeof keepFirefoxProfileBeforeRemove;
  keepApps?: typeof keepInstalledAppsBeforeRemove;
  workspaceExists?(target: LocalVmTarget): boolean;
  pollMs?: number;
  /** How long a turn that needs the desktop waits for its update. */
  waitMs?: number;
  log?(message: string): void;
}

interface Entry {
  target: LocalVmTarget;
  failure: string | null;
  failedAt: number;
  run: Promise<void> | null;
}

/** A failed update is retried by a turn that waits for it at once, and by anything else after this long. */
const RETRY_AFTER_MS = 5 * 60_000;

export interface WaitHooks {
  isCurrent(): boolean;
  cancelled(): Error;
  announce(text: string): void;
}

export function createLocalVmUpdater(deps: LocalVmUpdaterDeps) {
  const entries = new Map<string, Entry>();
  const fine = new Set<string>();
  const pollMs = deps.pollMs ?? 1_000;
  const waitMs = deps.waitMs ?? Math.max(1_000, Number(process.env.OMB_LOCAL_VM_UPDATE_WAIT_MS) || 20 * 60_000);
  const keepSignIns = deps.keepSignIns ?? keepFirefoxProfileBeforeRemove;
  const keepApps = deps.keepApps ?? keepInstalledAppsBeforeRemove;
  const workspaceExists = deps.workspaceExists ?? localVmWorkspaceExists;
  let image: Promise<void> | null = null;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Records what a status probe saw; true while the desktop waits for, or is in the middle of, its update. */
  function observe(target: LocalVmTarget, status: ContainerComputerStatus | null | undefined): boolean {
    const entry = entries.get(target.key);
    if (!status) return Boolean(entry);
    if (localVmUpdateNeed(status, workspaceExists(target))) {
      fine.delete(target.key);
      if (!entry) entries.set(target.key, { target, failure: null, failedAt: 0, run: null });
      return true;
    }
    // Between the old desktop's removal and the new one's start a probe sees nothing to update: the entry stays until it ends.
    if (entry?.run) return true;
    entries.delete(target.key);
    fine.add(target.key);
    return false;
  }

  /** One build for every desktop; a person's own Prepare, already running, is waited for rather than repeated. */
  async function prepareImage(target: LocalVmTarget): Promise<ContainerComputerStatus> {
    while (deps.imageBusy.get() && !image) await sleep(pollMs);
    const status = await deps.status(target);
    if (status.image) return status;
    image ??= (async () => {
      deps.imageBusy.set(true);
      try {
        await deps.act("pull", target);
      } finally {
        deps.imageBusy.set(false);
        image = null;
      }
    })();
    await image;
    return deps.status(target);
  }

  async function recreate(target: LocalVmTarget): Promise<void> {
    let status = await deps.status(target);
    if (!localVmUpdateNeed(status, workspaceExists(target))) return;
    if (!status.image) {
      status = await prepareImage(target);
      if (!status.image) throw new Error(status.problem ?? "the new desktop image could not be prepared");
    }
    if (status.container === "missing") return;
    const perBot = target.key.startsWith("bot:");
    // Checked and claimed with no await between, so no turn or lifecycle action can start on it mid-update.
    while (deps.inUse(target) || deps.lifecycleBusy.has(target.key) || (perBot && deps.provisionBusy.get())) await sleep(pollMs);
    deps.lifecycleBusy.add(target.key);
    if (perBot) deps.provisionBusy.set(true);
    try {
      status = await deps.status(target);
      if (status.container === "missing" || !status.managed || status.imageMatches) return;
      await keepSignIns(target, status, () => deps.act("stop", target));
      await keepApps(target, { ...status, container: "stopped" }, () => deps.act("stop", target));
      await deps.act("remove", target);
      status = await deps.act("run", target);
    } finally {
      if (perBot) deps.provisionBusy.set(false);
      deps.lifecycleBusy.delete(target.key);
    }
    deps.updated(target, status);
  }

  /** Starts the update, or joins the one running. A failed update is kept as such: the desktop is never deleted on a failure. */
  function update(target: LocalVmTarget): Promise<void> {
    let entry = entries.get(target.key);
    if (!entry) {
      entry = { target, failure: null, failedAt: 0, run: null };
      entries.set(target.key, entry);
    }
    const current = entry;
    current.run ??= recreate(target).then(
      () => {
        current.failure = null;
        if (entries.get(target.key) === current) entries.delete(target.key);
        fine.add(target.key);
      },
      (error: unknown) => {
        current.failure = (error instanceof Error ? error.message : String(error)).trim().replace(/[\s.]+$/u, "").slice(0, 300);
        current.failedAt = Date.now();
        deps.log?.(`Local VM ${target.label}: could not update automatically: ${current.failure}`);
      },
    ).finally(() => { current.run = null; });
    return current.run;
  }

  const due = (entry: Entry | undefined) => Boolean(entry && !entry.run && (!entry.failure || Date.now() - entry.failedAt > RETRY_AFTER_MS));

  return {
    observe,
    pending: (target: LocalVmTarget) => entries.has(target.key),
    /** For a turn that will not wait: starts the update in the background and returns what to tell the bot. */
    kick(target: LocalVmTarget): string {
      const entry = entries.get(target.key);
      if (due(entry)) void update(target);
      return localVmUpdateNote(entry?.failure ?? null);
    },
    /** Settings shows the update, which is then under way, rather than the old desktop's problem. */
    describe(target: LocalVmTarget, status: ContainerComputerStatus): ContainerComputerStatus {
      if (!observe(target, status)) return status;
      const entry = entries.get(target.key);
      if (due(entry)) void update(target);
      return { ...status, problem: entry?.failure ? `This desktop could not be updated automatically: ${entry.failure}` : LOCAL_VM_UPDATING_PROBLEM };
    },
    /** A turn that needs this desktop waits out its update, with one plain line in its thread. Throws when it cannot. */
    async waitFor(target: LocalVmTarget, hooks: WaitHooks): Promise<void> {
      if (!entries.has(target.key) && !fine.has(target.key)) observe(target, await deps.status(target).catch(() => null));
      if (!entries.has(target.key)) return;
      hooks.announce(LOCAL_VM_UPDATING);
      let settled = false;
      void update(target).finally(() => { settled = true; });
      const deadline = Date.now() + waitMs;
      while (!settled) {
        if (!hooks.isCurrent()) throw hooks.cancelled();
        if (Date.now() > deadline) throw new Error("this bot's desktop is still being updated — try again in a few minutes");
        await sleep(200);
      }
      const failure = entries.get(target.key)?.failure;
      if (failure) throw new Error(`this bot's desktop could not be updated automatically (${failure}) — update it in App Settings → Computers`);
    },
    /** After boot: the image is built once, then each old desktop is recreated as soon as nothing uses it. */
    async sweep(): Promise<void> {
      await Promise.all([...entries.values()].filter(due).map((entry) => update(entry.target)));
    },
  };
}

export type LocalVmUpdater = ReturnType<typeof createLocalVmUpdater>;

/** Finds the desktops a previous run left, so Auto turns can use them and idle ones stop on time. */
export async function recoverLocalVms(input: {
  mode: "shared" | "per-bot" | "pool";
  seats: number;
  bots: LocalVmInventoryBot[];
  seen: Set<string>;
  status(target: LocalVmTarget): Promise<ContainerComputerStatus | null>;
  note(target: LocalVmTarget, status: ContainerComputerStatus | null): void;
  armIdle(target: LocalVmTarget): void;
}): Promise<void> {
  const settle = async (targets: LocalVmTarget[]) => {
    const statuses = await Promise.all(targets.map((target) => input.status(target)));
    targets.forEach((target, index) => {
      input.note(target, statuses[index]);
      if (shouldArmLocalVmIdle(statuses[index])) input.armIdle(target);
    });
  };
  if (input.mode === "shared") return settle([SHARED_LOCAL_VM_TARGET]);
  const workspaces = input.mode === "pool"
    ? Array.from({ length: input.seats }, (_, seat) => poolLocalVmTarget(seat))
    : input.bots.map((bot) => perBotLocalVmTarget(bot.id));
  for (const target of workspaces) if (localVmWorkspaceExists(target)) input.seen.add(target.key);
  const runtime = await containerRuntimeStatus().catch(() => null);
  if (!runtime?.runtime || !runtime.daemonUp) return;
  const existing = input.mode === "pool"
    ? await discoverExistingPoolLocalVms(input.seats, runtime.runtime).catch(() => [])
    : (await discoverExistingPerBotLocalVms(input.bots, runtime.runtime).catch(() => [])).map(({ target }) => target);
  await settle(existing);
}
