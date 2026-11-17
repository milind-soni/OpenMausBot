// A cloud computer whose disk fills completely breaks in ways nobody can repair from inside it: its provider says
// snapshots fail, it can no longer be stopped or restarted, and ssh can stop working. No provider metrics are relied
// on here, so the disk is measured from inside with `df`, and space is freed in two tiers.
// Security, at 85% (caches only): apt's downloaded packages, journal logs beyond 50 MB, docker's build cache, and the
// npm, pip, yarn and pnpm cache folders under the home folder. No docker image, container or volume, nothing in /tmp.
// Security, at capacity (95% after the caches are gone, or a write that still fails for lack of space), in this order
// and only until the root filesystem is back under 80%: the caches again; docker containers that ended over 24 hours
// ago, then docker images no container uses; then whole top-level entries of /tmp, stalest first, under the rules
// written out at tmpSweep. An unused image or an old /tmp entry that someone still wanted is lost by this. Neither
// tier ever removes a docker volume, a running or recently stopped container or its image, anything reached through
// a mount point, or any file under the home folder outside the four cache folders.
// Every command is one of the fixed strings below; none takes a path or a name from the computer, the bot or the
// person, and the only values put into one are whole numbers this server worked out. Names read back from the
// computer reach the bot only as quoted data.
// Docker: `container prune --filter until=` goes by when a container was created, so containers are removed one by
// one by `.State.FinishedAt` instead. Linux: a bind mount on the same filesystem has the same device number, so
// neither `find -xdev` nor `rm --one-file-system` stops at it; /proc/self/mountinfo is what is checked.
// Unverified against a real computer: every command here, and what an upload to a full disk answers.
import { setTimeout as delay } from "node:timers/promises";

import { DISK_WARN_PERCENT, type CloudComputerDisk } from "../shared/cloud-computer-recovery.ts";
import { isolatedRemoteCommand, runCommand } from "./boat.ts";
import { COMMAND_WALL, trackedProcesses } from "./boat-command.ts";
import type { AppConfig } from "./config.ts";

export const DISK = {
  cleanAtPercent: DISK_WARN_PERCENT,
  foldersAtPercent: 90,
  writesFailAtPercent: 95,
  checkEveryMs: 10 * 60_000,
  cleanEveryMs: 60 * 60_000,
  /** After a cleanup that freed less than `helpedPoints` of the disk or less than `helpedKb`: what fills the disk is
   * not cache, and clearing the build cache again every hour would only cost rebuilds. */
  cleanAgainUnhelpedMs: 24 * 60 * 60_000,
  helpedPoints: 1,
  helpedKb: 500 * 1024,
  /** The longest anything waits for one `df`, under the five seconds a computer call keeps back for its answer to
   * reach the bot; on the computer it is stopped a second sooner. */
  checkTimeoutMs: 3_000,
  checkLimitSeconds: 2,
  surveyTimeoutMs: 15_000,
  stampTimeoutMs: 10_000,
  cleanupLimitSeconds: 300,
  cleanupFollowMs: 330_000,
  /** The longest an unattended run waits, before it starts, for the computer to have no command running, so that space
   * can be freed on it: a late run is better than one that fails on its first write. */
  runQuietWaitMs: 5 * 60_000,
  runQuietPollMs: 5_000,
  /** Once freeing has started an unattended run waits for it to end, so it never starts while a script is still
   * deleting: two surveys, both scripts as long as they are followed, the stamp, and four readings. */
  runWaitMs: 2 * (15_000 + 330_000) + 10_000 + 4 * 3_000,
  /** The capacity tier stops removing as soon as the root filesystem is under this. */
  capacityTargetPercent: 80,
  capacityEveryMs: 60 * 60_000,
  /** An entry of /tmp with anything modified this recently is never removed: twice the three hours an unattended run may take by default. */
  tmpQuietMinutes: 360,
  containerAgeHours: 24,
  removedShown: 8,
  foldersLimitSeconds: 15,
  foldersTimeoutMs: 20_000,
  foldersCount: 8,
  folderNameChars: 60,
  noSpaceGapMs: 30_000,
  /** The panel keeps "cleared caches" for this long: past a day a time of day alone would mislead. */
  panelClearedMs: 24 * 60 * 60_000,
  /** A stamp dated further ahead of the computer's own clock than this is not believed. */
  stampAheadSeconds: 300,
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

const HOME_MARK = "omb-disk:home";
export const DISK_CHECK_COMMAND = `timeout ${DISK.checkLimitSeconds} sh -c 'df -Pk /; echo ${HOME_MARK}; df -Pk "$HOME"' 2>/dev/null; true`;

export type DiskSide = "root" | "home";
/** The filesystem under `/` and the one that holds the home folder, which may be the same one. */
export type DiskReading = Record<DiskSide, DiskRow | null>;

export function parseReading(output: string): DiskReading | null {
  const lines = String(output ?? "").split(/\r?\n/);
  const mark = lines.findIndex((line) => line.trim() === HOME_MARK);
  if (mark < 0) return null;
  const rootRows = parseDf(lines.slice(0, mark).join("\n"));
  const reading = { root: rootRows.find((row) => row.mount === "/") ?? null, home: fullest(parseDf(lines.slice(mark + 1).join("\n"))) };
  return reading.root || reading.home ? reading : null;
}

export const fullestSide = (reading: DiskReading): DiskSide => ((reading.home?.percent ?? -1) > (reading.root?.percent ?? -1) ? "home" : "root");
export const percentOf = (reading: DiskReading): number => reading[fullestSide(reading)]!.percent;

const NO_SPACE = /no space left on device|\bENOSPC\b|disk quota exceeded|\bEDQUOT\b|answered 507 to the copy/i;
export const isNoSpaceError = (text: string): boolean => NO_SPACE.test(text);

const TOOLS = ["root", "sudo", "apt-get", "journalctl", "docker", "docker-sudo", "pgrep", "npm-cache", "pip-cache", "yarn-cache", "pnpm-cache"] as const;
export type DiskTool = (typeof TOOLS)[number];

const STAMP_DIR = '"$HOME/.cache/omb-disk"';
const STAMP_FILE = '"$HOME/.cache/omb-disk/last-cleanup"';
const CAPACITY_STAMP = '"$HOME/.cache/omb-disk/last-capacity"';
const RECENT_MARK = "omb-disk:recent";

export const DISK_SURVEY_COMMAND = [
  '[ "$(id -u)" = 0 ] && echo has:root',
  "sudo -n true >/dev/null 2>&1 && echo has:sudo",
  "for t in apt-get journalctl pgrep; do command -v $t >/dev/null 2>&1 && echo has:$t; done",
  "if command -v docker >/dev/null 2>&1; then if timeout 5 docker info >/dev/null 2>&1; then echo has:docker; elif timeout 5 sudo -n docker info >/dev/null 2>&1; then echo has:docker-sudo; fi; fi",
  '[ -d "$HOME/.npm/_cacache" ] && echo has:npm-cache',
  '[ -d "$HOME/.cache/pip" ] && echo has:pip-cache',
  '[ -d "$HOME/.cache/yarn" ] && echo has:yarn-cache',
  '[ -d "$HOME/.cache/pnpm" ] && echo has:pnpm-cache',
  'echo "now:$(date +%s)"',
  `[ -f ${STAMP_FILE} ] && echo "stamp:$(head -n 1 ${STAMP_FILE} 2>/dev/null)"`,
  "true",
].join("\n");

/** The last cleanup, as the computer's own stamp file records it; without a result when only its start was written. */
export interface DiskStamp { atSeconds: number; before: number | null; after: number | null; freedKb: number | null }

export interface DiskSurvey { found: Set<DiskTool>; nowSeconds: number | null; stamp: DiskStamp | null }

export function parseSurvey(output: string): DiskSurvey {
  const survey: DiskSurvey = { found: new Set(), nowSeconds: null, stamp: null };
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const name = /^has:([a-z-]+)$/.exec(line)?.[1] as DiskTool | undefined;
    if (name && TOOLS.includes(name)) survey.found.add(name);
    const now = /^now:(\d{9,11})$/.exec(line);
    if (now) survey.nowSeconds = Number(now[1]);
    const stamp = /^stamp:(\d{9,11})(?: (\d{1,3}) (\d{1,3}|-) (\d{1,12}|-))?$/.exec(line);
    if (stamp) {
      const number = (value: string | undefined, most: number) => (value === undefined || value === "-" ? null : Math.min(most, Number(value)));
      survey.stamp = { atSeconds: Number(stamp[1]), before: number(stamp[2], 100), after: number(stamp[3], 100), freedKb: number(stamp[4], Number.MAX_SAFE_INTEGER) };
    }
  }
  return survey;
}

/** Whether a cleanup made enough room to be worth running again an hour later; an unknown result counts as no. */
export const cleanupHelped = (before: number | null, after: number | null, freedKb: number | null): boolean =>
  before !== null && after !== null && freedKb !== null && before - after >= DISK.helpedPoints && freedKb >= DISK.helpedKb;

/** Matches the command line of a running npm, npx, pnpm, yarn, pip or uv, however it was started. Each name has one
 * letter in brackets so that the cleanup's own command line, which holds this text, never matches it. */
export const INSTALLER_RUNNING = "(^|[/ ])(n[p]m|n[p]x|p[n]pm|y[a]rn|p[i]p[0-9.]*|u[v])(-cli)?([.]c?js)?( |$)|python[0-9.]* -m p[i]p";

/** Skips the step when pgrep is missing, fails, or finds an installer: only "no such process" lets the cache go. */
const cacheStep = (folder: string) =>
  `command -v pgrep >/dev/null 2>&1 || exit 0; pgrep -f '${INSTALLER_RUNNING}' >/dev/null 2>&1; [ $? -eq 1 ] || exit 0; rm -rf -- "$HOME/${folder}"`;

/** The whole cleanup, in order, for a computer that has `found`, for the filesystems that are full: packages, logs and
 * docker's build cache live under `/`, the four cache folders under the home folder. This list is the allowlist. */
export function cleanupSteps(found: ReadonlySet<DiskTool>, full: Record<DiskSide, boolean>): string[] {
  const steps: string[] = [];
  if (full.root) {
    const root = found.has("root") ? "" : found.has("sudo") ? "sudo -n " : null;
    if (root !== null && found.has("apt-get")) steps.push(`${root}apt-get clean`);
    if (root !== null && found.has("journalctl")) steps.push(`${root}journalctl --vacuum-size=50M`);
    const docker = found.has("docker") ? "docker" : found.has("docker-sudo") ? "sudo -n docker" : null;
    if (docker) steps.push(`${docker} builder prune -f`);
  }
  if (full.home && found.has("pgrep")) {
    if (found.has("npm-cache")) steps.push(cacheStep(".npm/_cacache"));
    if (found.has("pip-cache")) steps.push(cacheStep(".cache/pip"));
    if (found.has("yarn-cache")) steps.push(cacheStep(".cache/yarn"));
    if (found.has("pnpm-cache")) steps.push(cacheStep(".cache/pnpm"));
  }
  return steps;
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** One shell, stopped with everything it started when the limit ends; a step that fails never stops the next. It runs
 * nothing when the stamp file says a cleanup started on this computer within the hour, whichever app started it. */
export function cleanupCommand(steps: string[]): string {
  const body = [
    `if [ -n "$(find ${STAMP_FILE} -mmin -60 2>/dev/null)" ]; then echo ${RECENT_MARK}; exit 0; fi`,
    `mkdir -p ${STAMP_DIR} 2>/dev/null; date +%s > ${STAMP_FILE} 2>/dev/null`,
    ...steps.map((step) => `( ${step}\n) >/dev/null 2>&1 </dev/null`),
    "true",
  ].join("\n");
  return `timeout -k 10 ${DISK.cleanupLimitSeconds} /bin/sh -c ${quote(body)}; true`;
}

const sudoFor = (found: ReadonlySet<DiskTool>): string => (!found.has("root") && found.has("sudo") ? "sudo -n " : "");
const dockerFor = (found: ReadonlySet<DiskTool>): string | null => (found.has("docker") ? "docker" : found.has("docker-sudo") ? "sudo -n docker" : null);

/** Stops the capacity tier: true once the root filesystem is under the target, and also when it cannot be read. */
const ENOUGH = `enough() { p=$(df -P / 2>/dev/null | awk 'NR==2 { sub("%", "", $5); print $5 }'); case "$p" in ''|*[!0-9]*) return 0;; esac; [ "$p" -lt ${DISK.capacityTargetPercent} ]; }`;
const FINISHED = "omb-disk:end";
const BELOW_MARK = "omb-disk:below";

/** The two levels the capacity tier may be started at; the script checks its own first reading against the one it was given. */
export type CapacityTrigger = typeof DISK.writesFailAtPercent | typeof DISK.cleanAtPercent;

const UNDER_ENTRY = `E="$e" awk 'BEGIN { e = ENVIRON["E"] } $0 == e || index($0, e "/") == 1 { hit = 1 } END { exit !hit }'`;

/** Removes whole top-level entries of /tmp, stalest first by the newest modification anywhere inside each, one at a
 * time, until `enough`. An entry is moved aside in one rename, made writable and deleted, and is reported only once
 * it is gone; one that cannot be deleted is put back and ends the stage.
 * Kept: dot entries; links; names with a space or any character outside A-Z a-z 0-9 . _ + = , @ : -; entries of
 * other users; entries holding another user's file, a socket or a pipe; entries with anything modified in the last
 * 6 hours; entries with a mount point at or below them; and entries that are, or lie above, the folder, root,
 * program, open file or mapped file of any running process, or a running container's mount.
 * The whole stage does nothing unless every process can be read (root, or sudo without a password), and nothing where
 * /tmp is a link or not on the root filesystem, where find is not GNU find, where the mount table cannot be read,
 * where docker is installed but its running containers' mounts cannot be read, or where a running container mounts
 * /tmp or a folder above it. A process list that reads as empty counts as "in use".
 * It stops when the first three removals did not lower the root filesystem's use, and after 200 removals.
 * Prints "<kB><tab><name>" for each entry removed. */
function tmpSweep(found: ReadonlySet<DiskTool>, tmp: string): string[] {
  if (!found.has("root") && !found.has("sudo")) return [];
  const docker = dockerFor(found);
  const sudo = sudoFor(found);
  const usedKb = "df -Pk / 2>/dev/null | awk 'NR==2 { print $3 }'";
  return [
    `t=${tmp}`,
    `if [ ! -L "$t" ] && t=$(realpath "$t" 2>/dev/null) && [ -n "$t" ] && [ "$t" != / ] && [ "$(stat -c %d "$t" 2>/dev/null)" = "$(stat -c %d / 2>/dev/null)" ] && find /proc/self/cwd -maxdepth 0 -lname '*' -printf '' 2>/dev/null; then`,
    `  u=$(id -u); tab=$(printf '\\t'); mounts=; sure=1`,
    "  points=$(awk '{ print $5 }' /proc/self/mountinfo 2>/dev/null) || sure=",
    '  [ -n "$points" ] || sure=',
    ...(docker ? [
      `  c=$(${docker} ps -q 2>/dev/null) || sure=`,
      `  mounts=$(printf '%s\\n' "$c" | xargs -r ${docker} inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' 2>/dev/null) || sure=`,
      `  printf '%s\\n' "$mounts" | T="$t" awk 'BEGIN { t = ENVIRON["T"] "/" } $0 == "/" || ($0 != "" && index(t, $0 "/") == 1) { all = 1 } END { exit !all }' && sure=`,
    ] : [
      "  if command -v docker >/dev/null 2>&1 || [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then sure=; fi",
    ]),
    '  for old in "$t"/.omb-disk-removing.*; do [ -d "$old" ] && [ ! -L "$old" ] && { chmod -R u+w "$old" 2>/dev/null; rm -rf --one-file-system -- "$old" 2>/dev/null; }; done',
    '  g=$(mktemp -d "$t/.omb-disk-removing.XXXXXX" 2>/dev/null) || sure=',
    '  [ -n "$g" ] && [ -d "$g" ] || sure=',
    '  if [ -n "$sure" ]; then',
    `    u0=$(${usedKb})`,
    '    for e in "$t"/*; do',
    '      [ -L "$e" ] && continue',
    '      [ -e "$e" ] || continue',
    '      case "${e##*/}" in *[!A-Za-z0-9._+=,@:-]*) continue;; esac',
    '      [ "$(stat -c %u "$e" 2>/dev/null)" = "$u" ] || continue',
    `      [ -z "$(find "$e" -xdev \\( -mmin -${DISK.tmpQuietMinutes} -o ! -user "$u" -o -type s -o -type p \\) -print -quit 2>&1)" ] || continue`,
    `      m=$(find "$e" -xdev -printf '%T@\\n' 2>/dev/null | sort -rn | head -n 1)`,
    `      [ -n "$m" ] && printf '%s\\t%s\\n' "\${m%%.*}" "$e"`,
    '    done | sort -n | { n=0; while IFS="$tab" read -r m e; do',
    "      enough && break",
    `      [ -z "$(find "$e" -xdev -mmin -${DISK.tmpQuietMinutes} -print -quit 2>&1)" ] || continue`,
    `      used=$( { ${sudo}find /proc/[0-9]*/cwd /proc/[0-9]*/exe /proc/[0-9]*/root /proc/[0-9]*/fd -maxdepth 1 -type l -printf '%l\\n' 2>/dev/null; ${sudo}cat /proc/[0-9]*/maps 2>/dev/null | awk '{ i = index($0, "/"); if (i) print substr($0, i) }'; } | sort -u )`,
    '      case "$used" in */*) ;; *) continue;; esac',
    `      { printf '%s\\n' "$used"; printf '%s\\n' "$mounts"; awk '{ print $5 }' /proc/self/mountinfo 2>/dev/null || echo "$e"; } | ${UNDER_ENTRY} && continue`,
    '      k=$(du -sxk "$e" 2>/dev/null | cut -f1)',
    '      held="$g/${e##*/}"',
    '      mv -- "$e" "$held" 2>/dev/null || continue',
    '      chmod -R u+w "$held" 2>/dev/null; rm -rf --one-file-system -- "$held" 2>/dev/null',
    '      if [ -e "$held" ] || [ -L "$held" ]; then mv -- "$held" "$e" 2>/dev/null; break; fi',
    `      printf '%s\\t%s\\n' "\${k:-0}" "\${e##*/}"`,
    "      n=$((n + 1))",
    '      [ "$n" -lt 200 ] || break',
    `      if [ "$n" -eq 3 ]; then u1=$(${usedKb}); case "$u0" in ''|*[!0-9]*) break;; esac; case "$u1" in ''|*[!0-9]*) break;; esac; [ "$u1" -lt "$u0" ] || break; fi`,
    "    done; }",
    "  fi",
    '  [ -z "$g" ] || rmdir -- "$g" 2>/dev/null',
    "fi",
  ];
}

/** Removes containers that are not running and ended over 24 hours ago, by when each one ended, then the images no
 * container uses: a container that stopped a moment ago, such as a database the full disk brought down, stays, and so
 * does its image. `docker rm` without -f refuses a running container and leaves volumes alone. Prints each name removed. */
const dockerStage = (docker: string): string[] => [
  "echo omb-disk:containers; now=$(date +%s)",
  `for c in $(${docker} ps -aq --no-trunc --filter status=exited --filter status=dead 2>/dev/null </dev/null); do`,
  `  f=$(${docker} inspect --format '{{.State.FinishedAt}}' "$c" 2>/dev/null </dev/null) || continue`,
  '  s=$(date -d "$f" +%s 2>/dev/null) || continue',
  `  case "$s" in ''|*[!0-9]*) continue;; esac`,
  `  [ "$((now - s))" -gt ${DISK.containerAgeHours * 3600} ] || continue`,
  `  name=$(${docker} inspect --format '{{.Name}}' "$c" 2>/dev/null </dev/null)`,
  `  ${docker} rm "$c" >/dev/null 2>&1 </dev/null && printf '%s\\n' "\${name#/}"`,
  "done",
  `echo omb-disk:images; ${docker} image prune -a -f 2>/dev/null </dev/null | grep -E '^untagged: ' | grep -v '@sha256:' | head -n 40`,
];

/** The capacity tier as one shell under the same time limit. It does nothing when its own first reading of the root
 * filesystem is under `trigger`, or when the stamp file says this tier started on this computer within the hour; each
 * stage then runs only while the root filesystem is still at or over the target. `tmp` is /tmp; a test may point it
 * at a folder of its own. */
export function capacityCommand(found: ReadonlySet<DiskTool>, full: Record<DiskSide, boolean>, trigger: CapacityTrigger, tmp = "/tmp"): string {
  const docker = dockerFor(found);
  const stop = `enough && { echo ${FINISHED}; exit 0; }`;
  const body = [
    `p=$(df -P / 2>/dev/null | awk 'NR==2 { sub("%", "", $5); print $5 }'); case "$p" in ''|*[!0-9]*) echo ${BELOW_MARK}; exit 0;; esac`,
    `[ "$p" -ge ${trigger} ] || { echo ${BELOW_MARK}; exit 0; }`,
    `if [ -n "$(find ${CAPACITY_STAMP} -mmin -60 2>/dev/null)" ]; then echo ${RECENT_MARK}; exit 0; fi`,
    `mkdir -p ${STAMP_DIR} 2>/dev/null; date +%s > ${CAPACITY_STAMP} 2>/dev/null`,
    ENOUGH,
    ...cleanupSteps(found, full).map((step) => `( ${step}\n) >/dev/null 2>&1 </dev/null`),
    stop,
    ...(docker ? [...dockerStage(docker), stop] : []),
    "echo omb-disk:tmp",
    ...tmpSweep(found, tmp),
    `echo ${FINISHED}`,
  ].join("\n");
  return `timeout -k 10 ${DISK.cleanupLimitSeconds} /bin/sh -c ${quote(body)}; true`;
}

export interface DiskRemoved { images: string[]; containers: string[]; items: DiskFolder[] }

const shownName = (raw: string): string => raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, DISK.folderNameChars);

/** What the capacity tier printed: null when the computer said the tier already ran within the hour, or that its
 * disk is under the level the tier was started for. */
export function parseCapacityReport(output: string): DiskRemoved | null {
  const removed: DiskRemoved = { images: [], containers: [], items: [] };
  let section = "";
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (line.trim() === RECENT_MARK || line.trim() === BELOW_MARK) return null;
    const mark = /^omb-disk:(containers|images|tmp|end)\s*$/.exec(line)?.[1];
    if (mark) { section = mark; continue; }
    const container = section === "containers" ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.exec(line.trim())?.[0] : undefined;
    if (container && removed.containers.length < 200) removed.containers.push(container);
    const image = section === "images" ? /^untagged: ([A-Za-z0-9][A-Za-z0-9._/:-]{0,127})$/.exec(line.trim())?.[1] : undefined;
    if (image && !removed.images.includes(image)) removed.images.push(image);
    const item = section === "tmp" ? /^(\d{1,15})\t([^/]+)$/.exec(line) : null;
    const name = item ? shownName(item[2]!) : "";
    if (item && name) removed.items.push({ name, kb: Number(item[1]) });
  }
  return removed;
}

const whole = (value: number | null, most: number): string => {
  if (value === null) return "-";
  if (!Number.isSafeInteger(value) || value < 0 || value > most) throw new RangeError("a stamp holds whole numbers only");
  return String(value);
};

/** Records how the cleanup ended beside when it started, for this app after a restart and for any other app that uses the computer. */
export const stampCommand = (before: number, after: number | null, freedKb: number | null): string =>
  `mkdir -p ${STAMP_DIR} 2>/dev/null; echo "$(date +%s) ${whole(before, 100)} ${whole(after, 100)} ${whole(freedKb, 999_999_999_999)}" > ${STAMP_FILE} 2>/dev/null; true`;

export const DISK_FOLDERS_COMMAND =
  `echo "home:$HOME"; timeout ${DISK.foldersLimitSeconds} du -xk -d 1 "$HOME" 2>/dev/null | sort -rn | head -n ${DISK.foldersCount + 1}; true`;

export interface DiskFolder { name: string; kb: number }

/** Only folders directly inside the home folder, by their own name, with control and formatting characters removed. */
export function parseFolders(output: string): DiskFolder[] {
  const lines = String(output ?? "").split(/\r?\n/);
  const home = /^home:(\/.*?)\/*$/.exec(lines[0] ?? "")?.[1];
  if (!home) return [];
  const folders: DiskFolder[] = [];
  for (const line of lines.slice(1)) {
    const match = /^(\d+)\s(.*)$/.exec(line);
    const kb = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(kb) || kb <= 0 || !match[2]!.startsWith(`${home}/`)) continue;
    const inside = match[2]!.slice(home.length + 1);
    if (inside.includes("/")) continue;
    const name = shownName(inside);
    if (name) folders.push({ name, kb });
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
export interface DiskCapacity extends DiskRemoved { at: number; before: number; after: number | null }

export interface DiskFacts {
  percent: number;
  /** "now": a cleanup is running. "soon": one is due and starts when no command runs on the computer. */
  cleaning: "now" | "soon" | false;
  /** The latest cleanup that ended, and whether the bot has been told of it. */
  cleanup: DiskCleanup | null;
  cleanupTold: boolean;
  /** The latest run of the capacity tier the bot has not been told of. */
  capacity?: DiskCapacity | null;
  folders: DiskFolder[] | null;
}

const some = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const listed = (shown: string[], total: number) => (total > shown.length ? `${shown.join(", ")}, and ${total - shown.length} more` : shown.join(", "));

/** What the capacity tier removed, with every name as quoted data, so the bot knows if something it expected is gone. */
export function removedText(removed: DiskRemoved): string {
  const parts: string[] = [];
  if (removed.images.length) {
    parts.push(`${some(removed.images.length, "unused Docker image", "unused Docker images")} (${listed(removed.images.slice(0, DISK.removedShown).map((name) => JSON.stringify(name)), removed.images.length)})`);
  }
  if (removed.containers.length) {
    parts.push(`${some(removed.containers.length, "stopped Docker container", "stopped Docker containers")} (${listed(removed.containers.slice(0, DISK.removedShown).map((name) => JSON.stringify(name)), removed.containers.length)})`);
  }
  if (removed.items.length) {
    const largest = [...removed.items].sort((a, b) => b.kb - a.kb).slice(0, DISK.removedShown).map((item) => `${JSON.stringify(item.name)} ${sized(item.kb)}`);
    parts.push(`${some(removed.items.length, "old item", "old items")} in /tmp: ${listed(largest, removed.items.length)}`);
  }
  if (!parts.length) return "MausBot cleared its caches and found nothing else it could safely remove.";
  return `MausBot removed ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`;
}

const ago = (ms: number): string => (ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)} h`);

/** What the bot reads at the end of a computer call's result: one line, and a second with the largest folders. */
export function diskNotice(facts: DiskFacts, now: number): string | null {
  const { percent, cleanup } = facts;
  let line: string;
  if (facts.capacity) {
    line = `Disk note: this cloud computer's disk was ${facts.capacity.before}% full; ${removedText(facts.capacity)}${facts.capacity.after !== null ? ` Now ${facts.capacity.after}%.` : ""}`;
  } else if (cleanup && !facts.cleanupTold && cleanup.after !== null) {
    const freed = cleanup.freedKb !== null && cleanup.freedKb >= 1024 ? ` (${sized(cleanup.freedKb)} freed)` : "";
    line = `Disk note: this cloud computer's disk was ${cleanup.before}% full; MausBot cleared caches${freed}, now ${cleanup.after}%.`;
  } else if (percent < DISK.cleanAtPercent) {
    return null;
  } else if (facts.cleaning === "now") {
    line = `Disk note: this cloud computer's disk is ${percent}% full; MausBot is freeing space now, which can take a few minutes.`;
  } else if (facts.cleaning === "soon") {
    line = `Disk note: this cloud computer's disk is ${percent}% full; MausBot frees space once no command is running on it.`;
  } else if (cleanup && now - cleanup.at < DISK.cleanAgainUnhelpedMs) {
    line = `Disk note: this cloud computer's disk is ${percent}% full; its caches were cleared ${ago(now - cleanup.at)} ago.`;
  } else {
    line = `Disk note: this cloud computer's disk is ${percent}% full.`;
  }
  if (percent >= DISK.writesFailAtPercent) line += " Writes may fail until space is freed.";
  if (percent < DISK.foldersAtPercent || facts.cleaning || !facts.folders?.length) return line;
  const names = facts.folders.map((folder) => `${JSON.stringify(folder.name)} ${sized(folder.kb)}`).join(", ");
  return `${line}\nLargest folders in the home directory (names as found): ${names}. Remove what is no longer needed.`;
}

const level = (percent: number): number =>
  percent >= DISK.writesFailAtPercent ? 3 : percent >= DISK.foldersAtPercent ? 2 : percent >= DISK.cleanAtPercent ? 1 : 0;

export interface DiskCommandResult { ok: boolean; stdout: string }

export interface DiskDeps<C> {
  /** Runs `command` on the computer; `long` starts it detached and follows it. May reject or never settle. */
  run(cfg: C, boxId: string, command: string, opts: { timeoutMs: number; long?: boolean }): Promise<DiskCommandResult>;
  /** Whether a command a bot started earlier (in the background, or left running by a call that ran out of time) may still run on the computer. */
  commandsRunning(boxId: string): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

interface Known {
  reading: DiskReading | null;
  checkedAt: number;
  nextCleanAt: number;
  cleanup: DiskCleanup | null;
  cleanupTold: boolean;
  folders: DiskFolder[] | null;
  foldersAt: number;
  toldLevel: number;
  noSpaceAt: number;
  /** When a failed call last reported a full disk, and when the caches were last dealt with (cleared, or found cleared). */
  writeFailedAt: number;
  cachesDoneAt: number;
  nextCapacityAt: number;
  capacity: DiskCapacity | null;
  capacityTold: boolean;
  /** Computer calls under way on it, from every turn this server runs. */
  calls: number;
  checking: Promise<DiskReading | null> | null;
  working: Promise<void> | null;
  cleanWork: Promise<void> | null;
  cleaning: boolean;
}

const NEVER = Number.NEGATIVE_INFINITY;

export function createCloudComputerDisk<C>(deps: DiskDeps<C>) {
  const computers = new Map<string, Known>();

  function known(boxId: string): Known {
    let entry = computers.get(boxId);
    if (!entry) {
      if (computers.size >= DISK.maxComputers) computers.delete(computers.keys().next().value!);
      entry = {
        reading: null, checkedAt: NEVER, nextCleanAt: NEVER, cleanup: null, cleanupTold: true, folders: null, foldersAt: NEVER, toldLevel: 0, noSpaceAt: NEVER,
        writeFailedAt: NEVER, cachesDoneAt: NEVER, nextCapacityAt: NEVER, capacity: null, capacityTold: true, calls: 0, checking: null, working: null, cleanWork: null, cleaning: false,
      };
      computers.set(boxId, entry);
    }
    return entry;
  }

  const run = async (cfg: C, boxId: string, command: string, opts: { timeoutMs: number; long?: boolean }) => deps.run(cfg, boxId, command, opts);

  /** Settles within `ms`, or as soon as `signal` aborts, whatever `work` does; null stands for unknown. */
  const within = <T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | null> => Promise.race([
    work.catch(() => null), deps.sleep(ms).then(() => null),
    ...(signal ? [new Promise<null>((resolve) => { if (signal.aborted) resolve(null); else signal.addEventListener("abort", () => resolve(null), { once: true }); })] : []),
  ]);

  const percent = (entry: Known): number => (entry.reading ? percentOf(entry.reading) : 0);

  function record(entry: Known, reading: DiskReading | null): void {
    if (!reading) return;
    entry.reading = reading;
    entry.checkedAt = deps.now();
    if (percentOf(reading) < DISK.cleanAtPercent) entry.toldLevel = 0;
  }

  function measure(cfg: C, boxId: string): Promise<DiskReading | null> {
    const entry = known(boxId);
    entry.checking ??= within(run(cfg, boxId, DISK_CHECK_COMMAND, { timeoutMs: DISK.checkTimeoutMs }), DISK.checkTimeoutMs)
      .then((out) => {
        const reading = out ? parseReading(out.stdout) : null;
        record(entry, reading);
        return reading;
      })
      .finally(() => { entry.checking = null; });
    return entry.checking;
  }

  async function listFolders(cfg: C, boxId: string, entry: Known): Promise<void> {
    entry.foldersAt = deps.now();
    const out = await within(run(cfg, boxId, isolatedRemoteCommand(DISK_FOLDERS_COMMAND), { timeoutMs: DISK.foldersTimeoutMs }), DISK.foldersTimeoutMs);
    entry.folders = out ? parseFolders(out.stdout) : null;
  }

  async function clean(cfg: C, boxId: string, entry: Known, before: DiskReading): Promise<void> {
    const startedAt = deps.now();
    entry.nextCleanAt = startedAt + DISK.cleanEveryMs;
    const asked = await within(run(cfg, boxId, isolatedRemoteCommand(DISK_SURVEY_COMMAND), { timeoutMs: DISK.surveyTimeoutMs }), DISK.surveyTimeoutMs);
    if (!asked?.ok) {
      entry.nextCleanAt = startedAt;
      return;
    }
    const survey = parseSurvey(asked.stdout);
    entry.cachesDoneAt = startedAt;
    const stamp = survey.stamp;
    if (stamp && survey.nowSeconds !== null && stamp.atSeconds <= survey.nowSeconds + DISK.stampAheadSeconds) {
      const ageMs = Math.max(0, survey.nowSeconds - stamp.atSeconds) * 1000;
      const wait = cleanupHelped(stamp.before, stamp.after, stamp.freedKb) ? DISK.cleanEveryMs : DISK.cleanAgainUnhelpedMs;
      if (ageMs < wait) {
        entry.nextCleanAt = startedAt - ageMs + wait;
        if (stamp.before !== null && (!entry.cleanup || entry.cleanup.at < startedAt - ageMs)) {
          entry.cleanup = { at: startedAt - ageMs, before: stamp.before, after: stamp.after, freedKb: stamp.freedKb };
          entry.cleanupTold = true;
        }
        return;
      }
    }
    const steps = cleanupSteps(survey.found, { root: (before.root?.percent ?? 0) >= DISK.cleanAtPercent, home: (before.home?.percent ?? 0) >= DISK.cleanAtPercent });
    if (!steps.length) return;
    entry.cleaning = true;
    let ran: DiskCommandResult | null;
    try {
      ran = await within(run(cfg, boxId, isolatedRemoteCommand(cleanupCommand(steps)), { timeoutMs: DISK.cleanupFollowMs, long: true }), DISK.cleanupFollowMs);
    } finally {
      entry.cleaning = false;
    }
    if (ran?.stdout.includes(RECENT_MARK)) return;
    const side = fullestSide(before);
    const was = before[side]!;
    const now = (await measure(cfg, boxId))?.[side] ?? null;
    const freedKb = now && now.mount === was.mount ? Math.max(0, was.usedKb - now.usedKb) : null;
    entry.cleanup = { at: deps.now(), before: was.percent, after: now?.percent ?? null, freedKb };
    entry.cleanupTold = false;
    entry.cachesDoneAt = deps.now();
    entry.nextCleanAt = startedAt + (cleanupHelped(was.percent, now?.percent ?? null, freedKb) ? DISK.cleanEveryMs : DISK.cleanAgainUnhelpedMs);
    deps.log(`cloud computer ${boxId}: disk was ${was.percent}% full; cleared caches, now ${now ? `${now.percent}%` : "unknown"}`);
    await within(run(cfg, boxId, isolatedRemoteCommand(stampCommand(was.percent, now?.percent ?? null, freedKb)), { timeoutMs: DISK.stampTimeoutMs }), DISK.stampTimeoutMs);
  }

  const cleanDue = (entry: Known): boolean => percent(entry) >= DISK.cleanAtPercent && deps.now() >= entry.nextCleanAt;

  /** At capacity: the caches have been dealt with and the root filesystem is still at 95%, or a call failed for lack
   * of space after that, with a reading taken then that showed the root filesystem at 85% or more. Null otherwise. */
  function capacityTrigger(entry: Known): CapacityTrigger | null {
    const root = entry.reading?.root?.percent ?? 0;
    if (cleanDue(entry) || entry.cachesDoneAt === NEVER || deps.now() < entry.nextCapacityAt) return null;
    if (root >= DISK.writesFailAtPercent) return DISK.writesFailAtPercent;
    return root >= DISK.cleanAtPercent && entry.writeFailedAt >= entry.cachesDoneAt ? DISK.cleanAtPercent : null;
  }
  const capacityDue = (entry: Known): boolean => capacityTrigger(entry) !== null;

  const quiet = (entry: Known, boxId: string): boolean => entry.calls === 0 && !deps.commandsRunning(boxId);

  /** Decides on a reading taken now, not on the one that brought it here. */
  async function capacity(cfg: C, boxId: string, entry: Known): Promise<void> {
    const before = await measure(cfg, boxId);
    const trigger = capacityTrigger(entry);
    if (!before?.root || trigger === null || !quiet(entry, boxId)) return;
    const startedAt = deps.now();
    entry.nextCapacityAt = startedAt + DISK.capacityEveryMs;
    entry.writeFailedAt = NEVER;
    const asked = await within(run(cfg, boxId, isolatedRemoteCommand(DISK_SURVEY_COMMAND), { timeoutMs: DISK.surveyTimeoutMs }), DISK.surveyTimeoutMs);
    if (!asked?.ok) {
      entry.nextCapacityAt = startedAt;
      return;
    }
    const found = parseSurvey(asked.stdout).found;
    const root = before.root;
    const homeOnRoot = before.home?.mount === root.mount;
    entry.cleaning = true;
    let ran: DiskCommandResult | null;
    try {
      const command = isolatedRemoteCommand(capacityCommand(found, { root: true, home: homeOnRoot }, trigger));
      ran = await within(run(cfg, boxId, command, { timeoutMs: DISK.cleanupFollowMs, long: true }), DISK.cleanupFollowMs);
    } finally {
      entry.cleaning = false;
    }
    const removed = ran ? parseCapacityReport(ran.stdout) : { images: [], containers: [], items: [] };
    if (!removed) return;
    const now = (await measure(cfg, boxId))?.root ?? null;
    entry.capacity = { ...removed, at: deps.now(), before: root.percent, after: now?.percent ?? null };
    entry.capacityTold = false;
    deps.log(`cloud computer ${boxId}: disk was ${root.percent}% full; removed ${removed.images.length} unused docker images, ${removed.containers.length} stopped containers and ${removed.items.length} old /tmp entries, now ${now ? `${now.percent}%` : "unknown"}`);
  }

  /** Starts whatever the latest reading calls for, one piece of work per computer at a time, and only while no
   * computer call is under way on it and no command a bot started is still running there: a cleanup never starts
   * beside a command. What was held back starts when a later call ends or a later reading comes in. */
  function act(cfg: C, boxId: string): void {
    const entry = known(boxId);
    const reading = entry.reading;
    if (!reading || entry.working || percent(entry) < DISK.cleanAtPercent || !quiet(entry, boxId)) return;
    const foldersDue = () => percent(entry) >= DISK.foldersAtPercent && deps.now() - entry.foldersAt >= DISK.cleanEveryMs;
    const caches = cleanDue(entry);
    const cleaning = caches || capacityDue(entry) ? (async () => {
      if (caches) await clean(cfg, boxId, entry, reading);
      if (capacityDue(entry) && quiet(entry, boxId)) await capacity(cfg, boxId, entry);
    })().catch(() => undefined).finally(() => { entry.cleanWork = null; }) : null;
    if (!cleaning && !foldersDue()) return;
    entry.cleanWork = cleaning;
    entry.working = (async () => {
      await cleaning;
      if (foldersDue()) await listFolders(cfg, boxId, entry);
    })().catch(() => undefined).finally(() => { entry.working = null; });
  }

  function notice(boxId: string, forced: boolean): string | null {
    const entry = computers.get(boxId);
    if (!entry?.reading) return null;
    const soon = cleanDue(entry) || capacityDue(entry) || Boolean(entry.cleanWork);
    if ((entry.working || soon) && !forced) return null;
    const rose = level(percent(entry)) > entry.toldLevel;
    if (!forced && !rose && entry.cleanupTold && entry.capacityTold) return null;
    const cleaning = entry.cleaning ? "now" as const : soon ? "soon" as const : false;
    const text = diskNotice({
      percent: percent(entry), cleaning, cleanup: entry.cleanup, cleanupTold: entry.cleanupTold, capacity: entry.capacityTold ? null : entry.capacity, folders: entry.folders,
    }, deps.now());
    if (!text) return null;
    if (!cleaning) entry.cleanupTold = entry.capacityTold = true;
    entry.toldLevel = level(percent(entry));
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
      record(known(boxId), parseReading(stdout));
      act(cfg, boxId);
    },
    /** A computer call is about to be sent. Never waits: a reading that is due is taken beside the call. Every call
     * that began must be given to `ended`. */
    began(cfg: C, boxId: string): void {
      const entry = known(boxId);
      entry.calls += 1;
      if (entry.checking || deps.now() - entry.checkedAt < DISK.checkEveryMs) return;
      entry.checkedAt = deps.now();
      void measure(cfg, boxId).then(() => act(cfg, boxId)).catch(() => undefined);
    },
    /** The call is over, however it went. A cleanup that was waiting starts once no other call is under way. */
    ended(cfg: C, boxId: string): void {
      const entry = known(boxId);
      entry.calls = Math.max(0, entry.calls - 1);
      act(cfg, boxId);
    },
    /** After a computer call's result is in: the note for the bot, if there is one to give. Waits only when a call
     * that `failed` reports a full disk in its own text, and then for one reading, DISK.checkTimeoutMs at most. */
    async after(cfg: C, boxId: string, texts: readonly string[], failed = false): Promise<string | null> {
      try {
        const entry = known(boxId);
        const noSpace = failed && texts.some(isNoSpaceError) && deps.now() - entry.noSpaceAt >= DISK.noSpaceGapMs;
        if (noSpace) {
          entry.noSpaceAt = deps.now();
          const reading = await measure(cfg, boxId);
          if ((reading?.root?.percent ?? 0) >= DISK.cleanAtPercent) entry.writeFailedAt = deps.now();
        }
        return notice(boxId, noSpace);
      } catch {
        return null;
      }
    },
    /** Before an unattended run's first command: reads the disk and frees what the reading calls for. While another
     * command runs on the computer it waits, DISK.runQuietWaitMs at most, for that to end before freeing anything;
     * once freeing has started it waits for it to end, DISK.runWaitMs at most. No wait outlasts `signal`. It never
     * waits for the folder listing and never rejects. Resolves with the percentage when the disk is still at the
     * level where writes may fail, so the run can be started with that said; the run is started either way. */
    async beforeRun(cfg: C, boxId: string, signal?: AbortSignal): Promise<number | null> {
      try {
        if (signal?.aborted) return null;
        const entry = known(boxId);
        if (await within(measure(cfg, boxId), DISK.checkTimeoutMs, signal)) {
          const giveUpAt = deps.now() + DISK.runQuietWaitMs;
          while (!signal?.aborted && !entry.working && (cleanDue(entry) || capacityDue(entry)) && !quiet(entry, boxId) && deps.now() < giveUpAt) {
            await within(deps.sleep(DISK.runQuietPollMs), DISK.runQuietPollMs, signal);
          }
          act(cfg, boxId);
        }
        if (entry.cleanWork && !signal?.aborted) await within(entry.cleanWork, DISK.runWaitMs, signal);
        if (!entry.reading || percent(entry) < DISK.writesFailAtPercent) return null;
        // The run is a new turn: its bot is told the disk is full on its first computer call, whatever an earlier turn was told.
        entry.toldLevel = 0;
        return percent(entry);
      } catch {
        return null;
      }
    },
    /** For the computer panel's state line; null while there is nothing to say. */
    panel(boxId: string | null): CloudComputerDisk | null {
      const entry = boxId ? computers.get(boxId) : undefined;
      if (!entry?.reading) return null;
      const full = percent(entry) >= DISK.cleanAtPercent;
      const recent = (at: number | undefined) => (at !== undefined && deps.now() - at < DISK.panelClearedMs ? at : null);
      const cleared = recent(entry.cleanup?.at), space = recent(entry.capacity?.at);
      if (!full && cleared === null && space === null) return null;
      return { percent: percent(entry), ...(space !== null ? { spaceClearedAt: space } : cleared !== null ? { clearedAt: cleared } : {}) };
    },
    /** The latest reading, or null when the disk has not been read. */
    percent: (boxId: string): number | null => { const entry = computers.get(boxId); return entry?.reading ? percent(entry) : null; },
    /** Resolves once no reading, cleanup or folder listing is under way. */
    idle: async (boxId: string): Promise<void> => { await computers.get(boxId)?.checking; await computers.get(boxId)?.working; },
  };
}

export type CloudComputerDiskMonitor<C> = ReturnType<typeof createCloudComputerDisk<C>>;

/** Readings are sent as probes, so a `df` that fails never counts against the computer's health. */
export const cloudComputerDisk = createCloudComputerDisk<AppConfig>({
  run: (cfg, boxId, command, opts) => runCommand(cfg, boxId, command, opts.long ? { timeoutMs: opts.timeoutMs } : { timeoutMs: opts.timeoutMs, probe: true }),
  commandsRunning: (boxId) => [...trackedProcesses(boxId).values()].some((startedAt) => Date.now() - startedAt < COMMAND_WALL.leftRunningMs),
  now: Date.now,
  sleep: (ms) => delay(ms, undefined, { ref: false }).then(() => undefined),
  log: (line) => console.warn(line),
});
