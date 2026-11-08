// What a newer or withdrawn release in the organization's catalog does to an install, after each relayed catalog.
//
// An update goes part by part, by the two hashes stamped on each part when it was written: `r`, the part as released,
// and `w`, the part as written here. A part changes only when the publisher changed it (the new release's hash is not
// `r`) and the person did not (the part as it is now still hashes to `w`); it is then written and stamped `r` = `w` =
// the new hash. A part the person edited is kept as they left it, and its stamp is left alone, so it stays theirs.
// Security: an update never raises approval, switches a routine on, or adds a connection or its values.
import type { PackageAgent, PackageDocument } from "../shared/package-format.ts";
import type { OrgInstall, OrgLibraryDeps, OrgLibraryEntry } from "./org-library.ts";
import {
  agentReleaseValues, pair, partHash, playbookValues, roomReleaseValues, routineReleaseValues, scheduleValue, skillReleaseValue,
  type AgentPart, type PartPair, type RoomPart, type RoutinePart,
} from "./package-parts.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export interface ReleaseContext {
  installs: Record<string, OrgInstall>;
  entries: readonly OrgLibraryEntry[];
  /** The install id this organization gives a package; another organization's installs are never touched. */
  currentInstallId(packageId: string): string | null;
  /** The entry's release, read and checked; null while it is not downloaded, or needs a newer app. */
  releaseDocument(entry: OrgLibraryEntry): PackageDocument | null;
  /** The release the install has now, while its file is still kept. */
  installedDocument(install: OrgInstall): PackageDocument | null;
  deps: OrgLibraryDeps;
  now(): number;
}

export function handleWithdrawn(context: ReleaseContext): boolean {
  let changed = false;
  for (const [installId, install] of Object.entries(context.installs)) {
    if (context.currentInstallId(install.packageId) !== installId) continue;
    if (install.status === "withdrawn" || (install.status === "removed" && install.withdrawnHandled === install.sha256)) continue;
    const entry = context.entries.find((candidate) => candidate.packageId === install.packageId);
    if (!entry?.withdrawnReleases.some((withdrawn) => withdrawn.sha256 === install.sha256)) continue;
    switchOff(context.deps, installId);
    if (install.status === "installed") install.status = "withdrawn";
    else install.withdrawnHandled = install.sha256;
    install.updatedAt = context.now();
    changed = true;
  }
  return changed;
}

function switchOff(deps: OrgLibraryDeps, installId: string): void {
  for (const bot of deps.store.bots) {
    for (const skill of deps.skills.stamps(bot.id)) {
      if (skill.stamp.installId !== installId || !skill.enabled) continue;
      const result = deps.skills.setEnabled(bot.id, skill.name, false);
      if ("error" in result) console.warn(`[org-library] could not switch off ${skill.name}: ${result.error}`);
    }
  }
  for (const bot of deps.store.bots) {
    const made = bot.installedPackage;
    if (made?.source !== "org" || made.installId !== installId || !made.presetKey || !made.ref) continue;
    const source = `org:${made.ref}@${made.release}`;
    for (const skill of deps.skills.list(bot.id)) {
      if (skill.source !== source || !skill.enabled) continue;
      const result = deps.skills.setEnabled(bot.id, skill.name, false);
      if ("error" in result) console.warn(`[org-library] could not switch off ${skill.name}: ${result.error}`);
    }
  }
  for (const routine of deps.routines.packageStamps()) {
    if (routine.stamp.installId !== installId || !routine.enabled) continue;
    try {
      deps.routines.update(routine.routineId, { enabled: false });
    } catch (error) {
      console.warn(`[org-library] could not pause a routine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Brings each added team up to its catalog release; the ids of the installs it moved to a new release. */
export function applyUpdates(context: ReleaseContext): { updated: string[]; retry: boolean } {
  const updated: string[] = [];
  let retry = false;
  for (const [installId, install] of Object.entries(context.installs)) {
    if (context.currentInstallId(install.packageId) !== installId || install.status !== "installed" || install.kind !== "team") continue;
    const entry = context.entries.find((candidate) => candidate.packageId === install.packageId);
    const release = entry?.release;
    if (!entry || !release || release.sha256 === install.sha256) continue;
    if (entry.withdrawnReleases.some((withdrawn) => withdrawn.sha256 === release.sha256)) continue;
    const next = context.releaseDocument(entry);
    if (!next) continue;
    const update = new InstallUpdate(context.deps, installId, install, next, release.sha256, context.installedDocument(install));
    try {
      update.bots();
      update.rooms();
      update.routines();
      update.brief();
    } catch (error) {
      // The parts written so far carry their new stamps, so the next catalog picks up from here.
      if ((error as { retryable?: boolean } | null)?.retryable) retry = true;
      console.warn(`[org-library] could not finish updating ${install.name || install.packageId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    install.release = release.version;
    install.sha256 = release.sha256;
    install.updatedAt = context.now();
    updated.push(installId);
  }
  return { updated, retry };
}

/** The parts the update writes; the others stay as they were added (see docs/org-library.md). */
const AGENT_UPDATED = ["name", "title", "description", "soul", "playbooks"] as const satisfies readonly AgentPart[];
const ROOM_UPDATED = ["name", "bulletin"] as const satisfies readonly RoomPart[];
const ROUTINE_UPDATED = ["name", "prompt", "schedule"] as const satisfies readonly RoutinePart[];

/** Whether a part should take the new release's value: the publisher changed it and the person did not. */
function takesRelease(stamp: PartPair | undefined, released: unknown, now: unknown): stamp is PartPair {
  return Boolean(stamp) && partHash(released) !== stamp!.r && partHash(now) === stamp!.w;
}

class InstallUpdate {
  private readonly deps: OrgLibraryDeps;
  private readonly installId: string;
  private readonly install: OrgInstall;
  private readonly pkg: PackageDocument["package"];
  private readonly sha256: string;
  private readonly previous: PackageDocument | null;
  private readonly ref: string;

  constructor(deps: OrgLibraryDeps, installId: string, install: OrgInstall, next: PackageDocument, sha256: string, previous: PackageDocument | null) {
    this.deps = deps;
    this.installId = installId;
    this.install = install;
    this.pkg = next.package;
    this.sha256 = sha256;
    this.previous = previous;
    this.ref = install.ref;
  }

  bots(): void {
    const playbookByKey = new Map((this.pkg.playbooks ?? []).map((playbook) => [playbook.key, playbook]));
    let deferred: (Error & { retryable?: boolean }) | undefined;
    for (const agent of this.pkg.agents) {
      const bot = this.deps.store.bot(this.install.bots[agent.key] ?? "");
      if (!bot?.packageBase) continue;
      const released = agentReleaseValues(agent, playbookByKey);
      const now: Record<(typeof AGENT_UPDATED)[number], unknown> = {
        name: bot.name, title: bot.title ?? "", description: bot.description ?? "", soul: bot.soul ?? "", playbooks: playbookValues(bot.playbooks ?? []),
      };
      const base: Partial<Record<AgentPart, PartPair>> = { ...bot.packageBase };
      const profile: Partial<Pick<BotRecord, "name" | "title" | "description" | "soul">> = {};
      let playbooks: BotRecord["playbooks"] | undefined;
      for (const part of AGENT_UPDATED) {
        if (!takesRelease(base[part], released[part], now[part])) continue;
        if (part === "name" && this.nameTaken(bot.id, String(released.name))) continue;
        if (part === "playbooks") playbooks = (agent.playbooks ?? []).flatMap((key) => (playbookByKey.has(key) ? [{ ...playbookByKey.get(key)! }] : []));
        else profile[part] = String(released[part]);
        base[part] = pair(released[part], part === "playbooks" ? playbookValues(playbooks ?? []) : released[part]);
      }
      const skillUpdate = this.skills(bot, agent);
      if (skillUpdate.error) {
        if (!deferred) deferred = skillUpdate.error;
        else if (skillUpdate.error.retryable) deferred.retryable = true;
        continue;
      }
      if (skillUpdate.changed) base.skills = pair(released.skills, released.skills);
      if (Object.keys(profile).length) this.deps.store.patchBotProfile(bot.id, profile);
      const installed = bot.installedPackage && { ...bot.installedPackage, release: this.pkg.release, sha256: this.sha256 };
      // The stamps go last: a part written before a crash and not yet stamped is kept, never written twice.
      this.deps.store.patchBot(bot.id, { ...(playbooks ? { playbooks } : {}), packageBase: base, ...(installed ? { installedPackage: installed } : {}) });
    }
    if (deferred) throw deferred;
  }

  /** Each skill the publisher changed and the person did not gets the new text; a skill new in this release is added, but
   * never one the person took off. Whether a skill is on is the person's and stays. */
  private skills(bot: BotRecord, agent: PackageAgent): { changed: boolean; error?: Error & { retryable?: boolean } } {
    const entries = new Map((this.pkg.skills?.entries ?? []).map((skill) => [skill.name, skill]));
    const stamped = new Map(this.deps.skills.stamps(bot.id).filter((skill) => skill.stamp.installId === this.installId).map((skill) => [skill.stamp.key, skill]));
    const before = this.previous?.package.agents.find((candidate) => candidate.key === agent.key)?.skills;
    const source = `org:${this.ref}@${this.pkg.release}`;
    let changed = false, deferred: (Error & { retryable?: boolean }) | undefined;
    const noteError = (error: Error & { retryable?: boolean }) => {
      if (!deferred) deferred = error;
      else if (error.retryable) deferred.retryable = true;
    };
    for (const name of agent.skills ?? []) {
      const skill = entries.get(name);
      if (!skill) continue;
      const value = skillReleaseValue(skill);
      const stamp = { installId: this.installId, key: name, release: this.pkg.release, ...pair(value, value) };
      const have = stamped.get(name);
      if (have) {
        const recovered = this.deps.skills.recoverOrg?.(bot.id, name);
        if (recovered && "error" in recovered) {
          noteError(Object.assign(new Error(`skill ${name} could not be synchronized: ${recovered.error}`), { retryable: true }));
          continue;
        }
        if (partHash(value) === have.stamp.r || !this.deps.skills.replaceOrg) continue;
        const result = this.deps.skills.replaceOrg(bot.id, source, skill, stamp, have.stamp);
        if ("stale" in result) continue;
        if ("error" in result) {
          noteError(Object.assign(new Error(`skill ${name} could not be updated: ${result.error}`), { retryable: result.retryable === true }));
          continue;
        }
        changed = true;
      } else if (before && !before.includes(name) && !this.deps.skills.list(bot.id).some((listed) => listed.name === name)) {
        const added = this.deps.skills.installOrg(bot.id, source, skill.instructions, stamp, skill.files);
        if ("error" in added) { noteError(new Error(`skill ${name} could not be added: ${added.error}`)); continue; }
        changed = true;
      }
    }
    return { changed, ...(deferred ? { error: deferred } : {}) };
  }

  rooms(): void {
    for (const room of this.pkg.rooms ?? []) {
      const group = this.deps.store.group(this.install.rooms[room.key] ?? "");
      const stamp = group?.installedPackage;
      if (!group || !stamp || stamp.installId !== this.installId) continue;
      const released = roomReleaseValues(room);
      const now: Record<(typeof ROOM_UPDATED)[number], unknown> = { name: group.name, bulletin: group.bulletin ?? "" };
      const parts = { ...stamp.parts };
      const patch: Partial<Pick<GroupRecord, "name" | "bulletin">> = {};
      for (const part of ROOM_UPDATED) {
        if (!takesRelease(parts[part], released[part], now[part])) continue;
        patch[part] = String(released[part]);
        parts[part] = pair(released[part], released[part]);
      }
      if (Object.keys(patch).length) this.deps.store.patchGroup(group.id, { ...patch, installedPackage: { ...stamp, parts } });
    }
  }

  routines(): void {
    if (!this.deps.routines.stampInstalledPackage) return;
    const stamps = new Map(this.deps.routines.packageStamps().map((routine) => [routine.routineId, routine.stamp]));
    for (const released of this.pkg.routines ?? []) {
      const id = this.install.routines[released.key] ?? "";
      const stamp = stamps.get(id);
      const routine = this.deps.routines.listRoutines().find((candidate) => candidate.id === id);
      if (!stamp || !routine || stamp.installId !== this.installId) continue;
      const values = routineReleaseValues(released);
      const now: Record<(typeof ROUTINE_UPDATED)[number], unknown> = { name: routine.name, prompt: routine.prompt, schedule: scheduleValue(routine) };
      const take = ROUTINE_UPDATED.filter((part) => takesRelease(stamp.parts[part], values[part], now[part]));
      if (!take.length) continue;
      const timeoutMinutes = released.timeoutMinutes === undefined ? undefined : Math.min(240, Math.max(5, released.timeoutMinutes));
      const updated = this.deps.routines.update(id, {
        ...(take.includes("name") ? { name: released.name } : {}),
        ...(take.includes("prompt") ? { prompt: released.prompt } : {}),
        ...(take.includes("schedule") ? {
          runOn: released.runOn, schedule: released.schedule, durationMinutes: released.durationMinutes,
          ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
          ...(released.overlap ? { overlap: released.overlap } : {}),
          ...(released.continuity && released.room === undefined ? { continuity: true } : {}),
          ...(released.runOnStartup ? { runOnStartup: true } : {}),
        } : {}),
      });
      if (!updated) continue;
      const written: Record<(typeof ROUTINE_UPDATED)[number], unknown> = { name: updated.name, prompt: updated.prompt, schedule: scheduleValue(updated) };
      const parts = { ...stamp.parts };
      for (const part of take) parts[part] = pair(values[part], written[part]);
      this.deps.routines.stampInstalledPackage(id, { ...stamp, parts });
    }
  }

  brief(): void {
    const stamp = this.install.team?.parts.brief;
    const sections = this.deps.sections;
    if (!stamp || !sections || !this.install.section) return;
    const released = this.pkg.team?.brief ?? "";
    if (!takesRelease(stamp, released, sections.read(this.install.section))) return;
    sections.write(this.install.section, released);
    this.install.team!.parts.brief = pair(released, released);
  }

  private nameTaken(botId: string, name: string): boolean {
    const wanted = name.trim().toLowerCase();
    return this.deps.store.bots.some((other) => other.id !== botId && other.name.trim().toLowerCase() === wanted);
  }
}
