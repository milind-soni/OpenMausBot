// A cloud computer whose disk fills completely breaks in ways nobody can repair from inside it: its provider says
// snapshots fail, it can no longer be stopped or restarted, and ssh can stop working. No provider metrics are relied
// on here, so the disk is measured from inside with `df`, and at CLEAN_AT percent only what can be made again is removed.
// Security: every cleanup command is one of the fixed strings below. None takes a path, a name or any other text from
// the computer, the bot or the person, and none removes a file under the home folder outside the four cache folders.
// Unverified against a real computer: every command here, and what an upload to a full disk answers.
import { setTimeout as delay } from "node:timers/promises";

import { DISK_WARN_PERCENT, type CloudComputerDisk } from "../shared/cloud-computer-recovery.ts";
import { isolatedRemoteCommand, runCommand } from "./boat.ts";
import type { AppConfig } from "./config.ts";

export const DISK = {
  cleanAtPercent: DISK_WARN_PERCENT,
  foldersAtPercent: 90,
  writesFailAtPercent: 95,
  checkEveryMs: 10 * 60_000,
  cleanEveryMs: 60 * 60_000,
  /** The longest anything waits for one `df`, under the five seconds a computer call keeps back for its answer to
   * reach the bot; on the computer it is stopped a second sooner. */
  checkTimeoutMs: 3_000,
  checkLimitSeconds: 2,
  surveyTimeoutMs: 15_000,
  cleanupLimitSeconds: 300,
  cleanupFollowMs: 330_000,
  /** The longest an unattended run waits, before it starts, for a cleanup to end. */
  runWaitMs: 90_000,
  foldersLimitSeconds: 15,
  foldersTimeoutMs: 20_000,
  foldersCount: 8,
  noSpaceGapMs: 30_000,
  /** The panel keeps "cleared caches" for this long: past a day a time of day alone would mislead. */
  panelClearedMs: 24 * 60 * 60_000,
  maxComputers: 500,
} as const;

export interface DiskRow { mount: string; totalKb: number; usedKb: number; availableKb: number; percent: number }

/** `df -Pk` rows, read from the right: a device name may hold spaces, and a long one may push its numbers to the next line. */
export function parseDf(output: string): DiskRow[] {
  const rows = new Map<string, DiskRow>();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /(?:^|\s)(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+%|-)\s+(\/.*?)\s*$/.exec(line);
    if (!match) continue;
    const totalKb = Number(match[1]), usedKb = Number(match[2]), availableKb = Math.max(0, Number(match[3]));
    if (!Number.isSafeInteger(totalKb) || !Number.isSafeInteger(usedKb) || totalKb <= 0) continue;
    const shown = match[4] === "-" ? Number.NaN : Number.parseInt(match[4]!, 10);
    const computed = usedKb + availableKb > 0 ? Math.ceil((usedKb / (usedKb + availableKb)) * 100) : Number.NaN;
    const percent = Number.isFinite(shown) ? shown : computed;
    if (!Number.isFinite(percent)) continue;
    rows.set(match[5]!, { mount: match[5]!, totalKb, usedKb, availableKb, percent: Math.min(100, Math.max(0, percent)) });
  }
  return [...rows.values()];
}

export const fullest = (rows: DiskRow[]): DiskRow | null =>
  rows.reduce<DiskRow | null>((worst, row) => (!worst || row.percent > worst.percent ? row : worst), null);

export const DISK_CHECK_COMMAND = `timeout ${DISK.checkLimitSeconds} df -Pk / "$HOME" 2>/dev/null; true`;

const NO_SPACE = /no space left on device|\bENOSPC\b|disk quota exceeded|\bEDQUOT\b|answered 507 to the copy/i;
export const isNoSpaceError = (text: string): boolean => NO_SPACE.test(text);

const TOOLS = ["root", "sudo", "apt-get", "journalctl", "docker", "docker-sudo", "pnpm", "npm-cache", "pip-cache", "yarn-cache", "pnpm-cache"] as const;
export type DiskTool = (typeof TOOLS)[number];

export const DISK_SURVEY_COMMAND = [
  '[ "$(id -u)" = 0 ] && echo has:root',
  "sudo -n true >/dev/null 2>&1 && echo has:sudo",
  "for t in apt-get journalctl pnpm; do command -v $t >/dev/null 2>&1 && echo has:$t; done",
  "if command -v docker >/dev/null 2>&1; then if timeout 5 docker info >/dev/null 2>&1; then echo has:docker; elif timeout 5 sudo -n docker info >/dev/null 2>&1; then echo has:docker-sudo; fi; fi",
  '[ -d "$HOME/.npm/_cacache" ] && echo has:npm-cache',
  '[ -d "$HOME/.cache/pip" ] && echo has:pip-cache',
  '[ -d "$HOME/.cache/yarn" ] && echo has:yarn-cache',
  '[ -d "$HOME/.cache/pnpm" ] && echo has:pnpm-cache',
  "true",
].join("\n");

export function parseSurvey(output: string): Set<DiskTool> {
  const found = new Set<DiskTool>();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const name = /^has:([a-z-]+)$/.exec(line.trim())?.[1] as DiskTool | undefined;
    if (name && TOOLS.includes(name)) found.add(name);
  }
  return found;
}

/** Removes an image only when no container, running or stopped, was made from it and every tag it carries is of a
 * repository it also has a registry digest for, so the same image can be pulled again. An image built here has no
 * digest and stays, tagged or not; `docker rmi` without -f refuses an image a container uses as well. */
const pulledUnusedImages = (docker: string): string => [
  `used=" $(${docker} ps -aq --no-trunc | xargs -r ${docker} inspect --format '{{.Image}}' | tr '\\n' ' ')"`,
  `for i in $(${docker} images -q --no-trunc | sort -u); do`,
  '  case "$used" in *" $i "*) continue;; esac',
  `  d=" $(${docker} image inspect --format '{{range .RepoDigests}}{{.}} {{end}}' "$i")"`,
  '  [ "$d" != " " ] || continue',
  "  keep=",
  `  for t in $(${docker} image inspect --format '{{range .RepoTags}}{{.}} {{end}}' "$i"); do case "$d" in *" \${t%:*}@"*) ;; *) keep=1;; esac; done`,
  '  [ -z "$keep" ] || continue',
  `  ${docker} image inspect --format '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}' "$i" | xargs -r ${docker} rmi`,
  "done",
].join("\n");

const busy = (names: string) => `pgrep '^(${names})' >/dev/null 2>&1`;

/** The whole cleanup, in order, for a computer that has `found`. This list is the allowlist: nothing else ever runs. */
export function cleanupSteps(found: ReadonlySet<DiskTool>): string[] {
  const steps: string[] = [];
  const root = found.has("root") ? "" : found.has("sudo") ? "sudo -n " : null;
  if (root !== null && found.has("apt-get")) steps.push(`${root}apt-get clean`);
  if (root !== null && found.has("journalctl")) steps.push(`${root}journalctl --vacuum-size=50M`);
  const docker = found.has("docker") ? "docker" : found.has("docker-sudo") ? "sudo -n docker" : null;
  if (docker) steps.push(`${docker} image prune -f`, `${docker} builder prune -f`, pulledUnusedImages(docker));
  if (found.has("npm-cache")) steps.push(`${busy("npm|npx")} || rm -rf -- "$HOME/.npm/_cacache"`);
  if (found.has("pip-cache")) steps.push(`${busy("pip")} || rm -rf -- "$HOME/.cache/pip"`);
  if (found.has("yarn-cache")) steps.push(`${busy("yarn")} || rm -rf -- "$HOME/.cache/yarn"`);
  if (found.has("pnpm-cache")) steps.push(`${busy("pnpm")} || rm -rf -- "$HOME/.cache/pnpm"`);
  if (found.has("pnpm")) steps.push(`${busy("pnpm")} || pnpm store prune`);
  steps.push("find /tmp -xdev -mindepth 1 -not -path '/tmp/.*' -type f -user \"$(id -u)\" -mtime +0 -atime +0 -delete");
  return steps;
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** One shell, stopped with everything it started when the limit ends; a step that fails never stops the next. */
export function cleanupCommand(steps: string[]): string {
  const body = [...steps.map((step) => `( ${step}\n) >/dev/null 2>&1 </dev/null`), "true"].join("\n");
  return `timeout -k 10 ${DISK.cleanupLimitSeconds} /bin/sh -c ${quote(body)}; true`;
}

export const DISK_FOLDERS_COMMAND =
  `echo "home:$HOME"; timeout ${DISK.foldersLimitSeconds} du -xk -d 1 "$HOME" 2>/dev/null | sort -rn | head -n ${DISK.foldersCount + 1}; true`;

export interface DiskFolder { path: string; kb: number }

export function parseFolders(output: string): DiskFolder[] {
  const lines = String(output ?? "").split(/\r?\n/);
  const home = /^home:(.*)$/.exec(lines[0] ?? "")?.[1]?.replace(/\/+$/, "") ?? "";
  const folders: DiskFolder[] = [];
  for (const line of lines.slice(1)) {
    const match = /^(\d+)\s+(\/.*)$/.exec(line);
    if (!match) continue;
    const path = match[2]!.replace(/\/+$/, "");
    const kb = Number(match[1]);
    if (path === home || !Number.isSafeInteger(kb) || kb <= 0) continue;
    folders.push({ path: path.replace(/\p{Cc}/gu, "?").slice(0, 120), kb });
  }
  return folders.sort((a, b) => b.kb - a.kb).slice(0, DISK.foldersCount);
}

export function sized(kb: number): string {
  const gb = kb / (1024 * 1024);
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(kb / 1024))} MB`;
}

export interface DiskCleanup { at: number; before: number; after: number | null; freedKb: number | null }

export interface DiskFacts {
  percent: number;
  /** A cleanup is running now. */
  cleaning: boolean;
  /** The latest cleanup that ended, and whether the bot has been told of it. */
  cleanup: DiskCleanup | null;
  cleanupTold: boolean;
  folders: DiskFolder[] | null;
}

/** What the bot reads at the end of a computer call's result: one line, and a second with the largest folders. */
export function diskNotice(facts: DiskFacts, now: number): string | null {
  const { percent, cleanup } = facts;
  let line: string;
  if (cleanup && !facts.cleanupTold && cleanup.after !== null) {
    const freed = cleanup.freedKb !== null && cleanup.freedKb >= 1024 ? ` (${sized(cleanup.freedKb)} freed)` : "";
    line = `Disk note: this cloud computer's disk was ${cleanup.before}% full; MausBot cleared caches${freed}, now ${cleanup.after}%.`;
  } else if (percent < DISK.cleanAtPercent) {
    return null;
  } else if (facts.cleaning) {
    line = `Disk note: this cloud computer's disk is ${percent}% full; MausBot is clearing caches now, which can take a few minutes.`;
  } else if (cleanup && now - cleanup.at < DISK.cleanEveryMs) {
    line = `Disk note: this cloud computer's disk is ${percent}% full; its caches were cleared ${Math.max(1, Math.round((now - cleanup.at) / 60_000))} min ago.`;
  } else {
    line = `Disk note: this cloud computer's disk is ${percent}% full.`;
  }
  if (percent >= DISK.writesFailAtPercent) line += " Writes may fail until space is freed.";
  if (percent < DISK.foldersAtPercent || facts.cleaning || !facts.folders?.length) return line;
  return `${line}\nLargest folders: ${facts.folders.map((folder) => `${folder.path} ${sized(folder.kb)}`).join(", ")}. Remove what is no longer needed.`;
}

const level = (percent: number): number =>
  percent >= DISK.writesFailAtPercent ? 3 : percent >= DISK.foldersAtPercent ? 2 : percent >= DISK.cleanAtPercent ? 1 : 0;

export interface DiskCommandResult { ok: boolean; stdout: string }

export interface DiskDeps<C> {
  /** Runs `command` on the computer; `long` starts it detached and follows it. May reject or never settle. */
  run(cfg: C, boxId: string, command: string, opts: { timeoutMs: number; long?: boolean }): Promise<DiskCommandResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

interface Known {
  row: DiskRow | null;
  checkedAt: number;
  cleanStartedAt: number;
  cleanup: DiskCleanup | null;
  cleanupTold: boolean;
  folders: DiskFolder[] | null;
  foldersAt: number;
  toldLevel: number;
  noSpaceAt: number;
  checking: Promise<DiskRow | null> | null;
  working: Promise<void> | null;
  cleaning: boolean;
}

const NEVER = Number.NEGATIVE_INFINITY;

export function createCloudComputerDisk<C>(deps: DiskDeps<C>) {
  const computers = new Map<string, Known>();

  function known(boxId: string): Known {
    let entry = computers.get(boxId);
    if (!entry) {
      if (computers.size >= DISK.maxComputers) computers.delete(computers.keys().next().value!);
      entry = { row: null, checkedAt: NEVER, cleanStartedAt: NEVER, cleanup: null, cleanupTold: true, folders: null, foldersAt: NEVER, toldLevel: 0, noSpaceAt: NEVER, checking: null, working: null, cleaning: false };
      computers.set(boxId, entry);
    }
    return entry;
  }

  const run = async (cfg: C, boxId: string, command: string, opts: { timeoutMs: number; long?: boolean }) => deps.run(cfg, boxId, command, opts);

  /** Settles within `ms` whatever `work` does; null stands for unknown. */
  const within = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([work.catch(() => null), deps.sleep(ms).then(() => null)]);

  function record(entry: Known, row: DiskRow | null): void {
    if (!row) return;
    entry.row = row;
    entry.checkedAt = deps.now();
    if (row.percent < DISK.cleanAtPercent) entry.toldLevel = 0;
  }

  function measure(cfg: C, boxId: string): Promise<DiskRow | null> {
    const entry = known(boxId);
    entry.checking ??= within(run(cfg, boxId, DISK_CHECK_COMMAND, { timeoutMs: DISK.checkTimeoutMs }), DISK.checkTimeoutMs)
      .then((out) => {
        const row = out ? fullest(parseDf(out.stdout)) : null;
        record(entry, row);
        return row;
      })
      .finally(() => { entry.checking = null; });
    return entry.checking;
  }

  async function listFolders(cfg: C, boxId: string, entry: Known): Promise<void> {
    entry.foldersAt = deps.now();
    const out = await within(run(cfg, boxId, isolatedRemoteCommand(DISK_FOLDERS_COMMAND), { timeoutMs: DISK.foldersTimeoutMs }), DISK.foldersTimeoutMs);
    entry.folders = out ? parseFolders(out.stdout) : null;
  }

  async function clean(cfg: C, boxId: string, entry: Known, before: DiskRow): Promise<void> {
    const earlier = entry.cleanStartedAt;
    entry.cleanStartedAt = deps.now();
    entry.cleaning = true;
    try {
      const survey = await within(run(cfg, boxId, isolatedRemoteCommand(DISK_SURVEY_COMMAND), { timeoutMs: DISK.surveyTimeoutMs }), DISK.surveyTimeoutMs);
      if (!survey?.ok) {
        entry.cleanStartedAt = earlier;
        return;
      }
      const command = isolatedRemoteCommand(cleanupCommand(cleanupSteps(parseSurvey(survey.stdout))));
      await within(run(cfg, boxId, command, { timeoutMs: DISK.cleanupFollowMs, long: true }), DISK.cleanupFollowMs);
    } finally {
      entry.cleaning = false;
    }
    const after = await measure(cfg, boxId);
    entry.cleanup = { at: deps.now(), before: before.percent, after: after?.percent ?? null, freedKb: after && after.mount === before.mount ? Math.max(0, before.usedKb - after.usedKb) : null };
    entry.cleanupTold = false;
    deps.log(`cloud computer ${boxId}: disk was ${before.percent}% full; cleared caches, now ${after ? `${after.percent}%` : "unknown"}`);
  }

  /** Starts whatever the latest reading calls for, at most one piece of work per computer at a time. */
  function act(cfg: C, boxId: string): void {
    const entry = known(boxId);
    const row = entry.row;
    if (!row || entry.working || row.percent < DISK.cleanAtPercent) return;
    const now = deps.now();
    const cleanDue = now - entry.cleanStartedAt >= DISK.cleanEveryMs;
    const foldersDue = row.percent >= DISK.foldersAtPercent && now - entry.foldersAt >= DISK.cleanEveryMs;
    if (!cleanDue && !foldersDue) return;
    entry.cleaning = cleanDue;
    entry.working = (async () => {
      if (cleanDue) await clean(cfg, boxId, entry, row);
      if ((entry.row?.percent ?? 0) >= DISK.foldersAtPercent && (cleanDue || foldersDue)) await listFolders(cfg, boxId, entry);
    })().catch(() => undefined).finally(() => { entry.working = null; });
  }

  function notice(boxId: string, forced: boolean): string | null {
    const entry = computers.get(boxId);
    if (!entry?.row) return null;
    if (entry.working && !forced) return null;
    const rose = level(entry.row.percent) > entry.toldLevel;
    if (!forced && !rose && entry.cleanupTold) return null;
    const text = diskNotice({ percent: entry.row.percent, cleaning: entry.cleaning, cleanup: entry.cleanup, cleanupTold: entry.cleanupTold, folders: entry.folders }, deps.now());
    if (!text) return null;
    if (!entry.cleaning) entry.cleanupTold = true;
    entry.toldLevel = level(entry.row.percent);
    return text;
  }

  return {
    /** For the ready probe: the command to send in place of `true` when a reading is due, else null. It always exits 0. */
    probeCommand(boxId: string): string | null {
      const entry = known(boxId);
      if (entry.checking || deps.now() - entry.checkedAt < DISK.checkEveryMs) return null;
      entry.checkedAt = deps.now();
      return DISK_CHECK_COMMAND;
    },
    /** What the ready probe's command printed. */
    probed(cfg: C, boxId: string, stdout: string): void {
      record(known(boxId), fullest(parseDf(stdout)));
      act(cfg, boxId);
    },
    /** A turn is about to use the computer. Never waits: a reading that is due is taken beside the call. */
    used(cfg: C, boxId: string): void {
      const entry = known(boxId);
      if (entry.checking || deps.now() - entry.checkedAt < DISK.checkEveryMs) return;
      entry.checkedAt = deps.now();
      void measure(cfg, boxId).then(() => act(cfg, boxId)).catch(() => undefined);
    },
    /** After a computer call: the note for the bot, if there is one to give. Waits only when the call's own text
     * reports a full disk, and then for one reading, DISK.checkTimeoutMs at most. */
    async after(cfg: C, boxId: string, texts: readonly string[]): Promise<string | null> {
      try {
        const entry = known(boxId);
        const noSpace = texts.some(isNoSpaceError) && deps.now() - entry.noSpaceAt >= DISK.noSpaceGapMs;
        if (noSpace) {
          entry.noSpaceAt = deps.now();
          if (await measure(cfg, boxId)) act(cfg, boxId);
        }
        return notice(boxId, noSpace);
      } catch {
        return null;
      }
    },
    /** Before an unattended run's first command: when the last reading was at or over the cleanup level, reads again
     * and waits for the cleanup, DISK.checkTimeoutMs + DISK.runWaitMs at most. Never rejects. */
    async beforeRun(cfg: C, boxId: string): Promise<void> {
      try {
        const entry = computers.get(boxId);
        if (!entry?.row || entry.row.percent < DISK.cleanAtPercent) return;
        if (await measure(cfg, boxId)) act(cfg, boxId);
        if (entry.working) await within(entry.working, DISK.runWaitMs);
      } catch {
        return;
      }
    },
    /** For the computer panel's state line; null while there is nothing to say. */
    panel(boxId: string | null): CloudComputerDisk | null {
      const entry = boxId ? computers.get(boxId) : undefined;
      if (!entry?.row) return null;
      const full = entry.row.percent >= DISK.cleanAtPercent;
      const cleared = entry.cleanup && deps.now() - entry.cleanup.at < DISK.panelClearedMs ? entry.cleanup.at : null;
      if (!full && cleared === null) return null;
      return { percent: entry.row.percent, ...(cleared !== null ? { clearedAt: cleared } : {}) };
    },
    /** The latest reading, or null when the disk has not been read. */
    percent: (boxId: string): number | null => computers.get(boxId)?.row?.percent ?? null,
    /** Resolves once no cleanup or folder listing is under way. */
    idle: async (boxId: string): Promise<void> => { await computers.get(boxId)?.checking; await computers.get(boxId)?.working; },
  };
}

export type CloudComputerDiskMonitor<C> = ReturnType<typeof createCloudComputerDisk<C>>;

/** Readings are sent as probes, so a `df` that fails never counts against the computer's health. */
export const cloudComputerDisk = createCloudComputerDisk<AppConfig>({
  run: (cfg, boxId, command, opts) => runCommand(cfg, boxId, command, opts.long ? { timeoutMs: opts.timeoutMs } : { timeoutMs: opts.timeoutMs, probe: true }),
  now: Date.now,
  sleep: (ms) => delay(ms, undefined, { ref: false }).then(() => undefined),
  log: (line) => console.warn(line),
});
