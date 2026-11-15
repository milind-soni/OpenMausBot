// No computer and no shell: a fake command runner answers the fixed commands, and a clock that only moves when told.
import { describe, expect, it } from "vitest";

import { isolatedRemoteCommand } from "./boat.ts";
import {
  cleanupCommand, cleanupSteps, createCloudComputerDisk, DISK, DISK_CHECK_COMMAND, DISK_FOLDERS_COMMAND, DISK_SURVEY_COMMAND, diskNotice, fullest,
  isNoSpaceError, parseDf, parseFolders, parseSurvey, sized, type DiskFacts, type DiskTool,
} from "./cloud-computer-disk.ts";

const BOX = "bx_23456789";
const GB = 1024 * 1024;
const MINUTE = 60_000;

const df = (percent: number, mount = "/", totalKb = 84 * GB) => {
  const used = Math.round((totalKb * percent) / 100);
  return `Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/vda1 ${totalKb} ${used} ${totalKb - used} ${percent}% ${mount}\n`;
};

const ALL_TOOLS: DiskTool[] = ["root", "sudo", "apt-get", "journalctl", "docker", "docker-sudo", "pnpm", "npm-cache", "pip-cache", "yarn-cache", "pnpm-cache"];

const pulledUnused = (docker: string) => [
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

const TMP_STEP = "find /tmp -xdev -mindepth 1 -not -path '/tmp/.*' -type f -user \"$(id -u)\" -mtime +0 -atime +0 -delete";

/** Every command a cleanup may ever hold, written out: a new one has to be added here by hand. */
const ALLOWED = new Set([
  "apt-get clean", "sudo -n apt-get clean",
  "journalctl --vacuum-size=50M", "sudo -n journalctl --vacuum-size=50M",
  "docker image prune -f", "sudo -n docker image prune -f",
  "docker builder prune -f", "sudo -n docker builder prune -f",
  pulledUnused("docker"), pulledUnused("sudo -n docker"),
  `pgrep '^(npm|npx)' >/dev/null 2>&1 || rm -rf -- "$HOME/.npm/_cacache"`,
  `pgrep '^(pip)' >/dev/null 2>&1 || rm -rf -- "$HOME/.cache/pip"`,
  `pgrep '^(yarn)' >/dev/null 2>&1 || rm -rf -- "$HOME/.cache/yarn"`,
  `pgrep '^(pnpm)' >/dev/null 2>&1 || rm -rf -- "$HOME/.cache/pnpm"`,
  `pgrep '^(pnpm)' >/dev/null 2>&1 || pnpm store prune`,
  TMP_STEP,
]);

interface World {
  percent: number;
  /** What the disk reads once a cleanup has run. */
  cleansTo: number | null;
  df: "ok" | "error" | "hang" | "garbage";
  survey: "ok" | "error" | "hang";
  cleanup: "ok" | "hang" | "error";
  tools: DiskTool[];
  folders: string;
}

function harness(over: Partial<World> = {}) {
  let at = 1_700_000_000_000;
  const world: World = { percent: 50, cleansTo: null, df: "ok", survey: "ok", cleanup: "ok", tools: ["sudo", "apt-get"], folders: "home:/home/user\n100\t/home/user\n", ...over };
  const sent: Array<{ command: string; timeoutMs: number; long: boolean }> = [];
  const sleepers: Array<{ due: number; wake: () => void }> = [];
  const logs: string[] = [];
  const hang = () => new Promise<never>(() => {});
  const disk = createCloudComputerDisk<null>({
    now: () => at,
    sleep: (ms) => new Promise<void>((wake) => { sleepers.push({ due: at + ms, wake }); }),
    log: (line) => { logs.push(line); },
    run: async (_cfg, boxId, command, opts) => {
      expect(boxId).toBe(BOX);
      sent.push({ command, timeoutMs: opts.timeoutMs, long: opts.long === true });
      if (command === DISK_CHECK_COMMAND) {
        if (world.df === "hang") return hang();
        if (world.df === "error") throw new Error("fetch failed");
        return { ok: true, stdout: world.df === "garbage" ? "df: cannot read table of mounted file systems\n" : df(world.percent) };
      }
      if (command === isolatedRemoteCommand(DISK_SURVEY_COMMAND)) {
        if (world.survey === "hang") return hang();
        if (world.survey === "error") return { ok: false, stdout: "" };
        return { ok: true, stdout: world.tools.map((tool) => `has:${tool}`).join("\n") };
      }
      if (command === isolatedRemoteCommand(DISK_FOLDERS_COMMAND)) return { ok: true, stdout: world.folders };
      if (!command.includes(`timeout -k 10 ${DISK.cleanupLimitSeconds} /bin/sh -c`)) throw new Error(`a command nothing here should send: ${command}`);
      if (world.cleanup === "hang") return hang();
      if (world.cleanup === "error") throw new Error("fetch failed");
      if (world.cleansTo !== null) world.percent = world.cleansTo;
      return { ok: true, stdout: "" };
    },
  });
  const flush = async () => { for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const advance = async (ms: number) => {
    at += ms;
    for (const sleeper of sleepers.splice(0)) { if (sleeper.due <= at) sleeper.wake(); else sleepers.push(sleeper); }
    await flush();
  };
  const count = (what: "check" | "survey" | "cleanup" | "folders") => sent.filter(({ command }) =>
    what === "check" ? command === DISK_CHECK_COMMAND
      : what === "survey" ? command === isolatedRemoteCommand(DISK_SURVEY_COMMAND)
      : what === "folders" ? command === isolatedRemoteCommand(DISK_FOLDERS_COMMAND)
      : command.includes("/bin/sh -c")).length;
  /** One use of the computer, with everything it set off run to its end. */
  const use = async () => { disk.used(null, BOX); await flush(); await disk.idle(BOX); await flush(); };
  return { disk, world, sent, logs, flush, advance, count, use, now: () => at };
}

describe("reading df", () => {
  it("reads the root and home filesystems and takes the fuller one", () => {
    const rows = parseDf([
      "Filesystem     1024-blocks     Used Available Capacity Mounted on",
      "/dev/vda1         88080384 74448896  13631488      85% /",
      "/dev/vdb1         10485760  1048576   9437184      10% /home/user",
    ].join("\n"));
    expect(rows).toEqual([
      { mount: "/", totalKb: 88080384, usedKb: 74448896, availableKb: 13631488, percent: 85 },
      { mount: "/home/user", totalKb: 10485760, usedKb: 1048576, availableKb: 9437184, percent: 10 },
    ]);
    expect(fullest(rows)?.mount).toBe("/");
  });

  it("counts one filesystem once when the home folder is on the root disk", () => {
    const line = "overlay 88080384 80000000 8080384 91% /";
    expect(parseDf(`Filesystem 1024-blocks Used Available Capacity Mounted on\n${line}\n${line}\n`)).toHaveLength(1);
  });

  it.each([
    ["a device name with spaces", "//server/my share 1000 910 90 91% /mnt", { mount: "/mnt", percent: 91 }],
    ["a long device name that pushes its numbers to the next line", "/dev/mapper/a-very-long-volume-name\n                     1000 910 90 91% /", { mount: "/", percent: 91 }],
    ["Windows line endings", "/dev/vda1 1000 910 90 91% /\r\n", { mount: "/", percent: 91 }],
    ["a header in another language", "Dateisystem 1024-Blöcke Benutzt Verfügbar Kapazität Eingehängt auf\n/dev/vda1 1000 910 90 91% /", { mount: "/", percent: 91 }],
    ["no capacity column, worked out the way df does, rounded up", "/dev/vda1 1000 901 99 - /", { mount: "/", percent: 91 }],
    ["a mount point with spaces", "/dev/vda1 1000 500 500 50% /home/user/My Files", { mount: "/home/user/My Files", percent: 50 }],
    ["more used than the disk holds", "/dev/vda1 1000 1200 -5 120% /", { mount: "/", percent: 100, availableKb: 0 }],
  ])("reads %s", (_name, output, expected) => {
    expect(parseDf(output)).toEqual([expect.objectContaining(expected)]);
  });

  it.each([
    ["nothing", ""],
    ["only a header", "Filesystem 1024-blocks Used Available Capacity Mounted on\n"],
    ["an error", "df: /home/user: No such file or directory"],
    ["a table of the wrong shape", "/dev/vda1 84G 71G 13G 85% /"],
    ["a disk of no size", "none 0 0 0 - /proc"],
    ["something that is not text", undefined as unknown as string],
  ])("makes no reading of %s", (_name, output) => {
    expect(parseDf(output)).toEqual([]);
    expect(fullest(parseDf(output))).toBeNull();
  });
});

describe("what a cleanup may run", () => {
  it("is only the /tmp sweep on a computer that has nothing else", () => {
    expect(cleanupSteps(new Set())).toEqual([TMP_STEP]);
  });

  it("is the whole list, in order, on a computer that has everything, as its ordinary user", () => {
    expect(cleanupSteps(new Set<DiskTool>(["sudo", "apt-get", "journalctl", "docker", "pnpm", "npm-cache", "pip-cache", "yarn-cache", "pnpm-cache"]))).toEqual([
      "sudo -n apt-get clean",
      "sudo -n journalctl --vacuum-size=50M",
      "docker image prune -f",
      "docker builder prune -f",
      pulledUnused("docker"),
      `pgrep '^(npm|npx)' >/dev/null 2>&1 || rm -rf -- "$HOME/.npm/_cacache"`,
      `pgrep '^(pip)' >/dev/null 2>&1 || rm -rf -- "$HOME/.cache/pip"`,
      `pgrep '^(yarn)' >/dev/null 2>&1 || rm -rf -- "$HOME/.cache/yarn"`,
      `pgrep '^(pnpm)' >/dev/null 2>&1 || rm -rf -- "$HOME/.cache/pnpm"`,
      `pgrep '^(pnpm)' >/dev/null 2>&1 || pnpm store prune`,
      TMP_STEP,
    ]);
  });

  it("leaves out each step whose tool is missing", () => {
    expect(cleanupSteps(new Set<DiskTool>(["apt-get", "journalctl"]))).toEqual([TMP_STEP]);
    expect(cleanupSteps(new Set<DiskTool>(["sudo"]))).toEqual([TMP_STEP]);
    expect(cleanupSteps(new Set<DiskTool>(["root", "apt-get"]))).toEqual(["apt-get clean", TMP_STEP]);
    expect(cleanupSteps(new Set<DiskTool>(["sudo", "journalctl"]))).toEqual(["sudo -n journalctl --vacuum-size=50M", TMP_STEP]);
    expect(cleanupSteps(new Set<DiskTool>(["docker-sudo"]))).toEqual(["sudo -n docker image prune -f", "sudo -n docker builder prune -f", pulledUnused("sudo -n docker"), TMP_STEP]);
    expect(cleanupSteps(new Set<DiskTool>(["pip-cache"]))).toEqual([`pgrep '^(pip)' >/dev/null 2>&1 || rm -rf -- "$HOME/.cache/pip"`, TMP_STEP]);
  });

  it("holds nothing but the allowed commands, whatever the computer has", () => {
    for (let mask = 0; mask < 2 ** ALL_TOOLS.length; mask++) {
      const found = new Set(ALL_TOOLS.filter((_tool, bit) => mask & (1 << bit)));
      for (const step of cleanupSteps(found)) expect(ALLOWED.has(step), step).toBe(true);
    }
  });

  it("never removes volumes, containers, tagged local images, or anything by force or by a name it was given", () => {
    const everything = [...ALLOWED].join("\n");
    for (const banned of ["volume", "system prune", "container prune", "network", "prune -a", "--all", "rmi -f", "rmi --force", "docker rm ", "sudo rm", "git ", "node_modules", "$1", "$@", "eval"]) {
      expect(everything, banned).not.toContain(banned);
    }
    const removed = [...everything.matchAll(/rm -rf -- (\S+)/g)].map((match) => match[1]);
    expect(removed).toEqual(['"$HOME/.npm/_cacache"', '"$HOME/.cache/pip"', '"$HOME/.cache/yarn"', '"$HOME/.cache/pnpm"']);
    expect(everything.match(/\brm\b/g)).toHaveLength(4);
    expect(everything.match(/-delete\b/g)).toHaveLength(1);
    expect(TMP_STEP).toContain("-type f");
    expect(TMP_STEP).toContain("-mtime +0 -atime +0");
    expect(TMP_STEP.startsWith("find /tmp -xdev ")).toBe(true);
  });

  it("runs as one shell under a time limit, each step on its own, and always ends well", () => {
    const command = cleanupCommand(["first 'quoted'", "second"]);
    expect(command).toBe("timeout -k 10 300 /bin/sh -c '( first '\\''quoted'\\''\n) >/dev/null 2>&1 </dev/null\n( second\n) >/dev/null 2>&1 </dev/null\ntrue'; true");
  });

  it("reads which tools the computer has, and ignores anything else it prints", () => {
    expect([...parseSurvey("has:sudo\nhas:apt-get\r\nhas:rm-everything\nhas:docker extra\n has:pnpm \nnoise")]).toEqual(["sudo", "apt-get", "pnpm"]);
    expect(parseSurvey("").size).toBe(0);
  });

  it("asks the computer with fixed commands that always end well", () => {
    expect(DISK_CHECK_COMMAND).toBe('timeout 2 df -Pk / "$HOME" 2>/dev/null; true');
    expect(DISK_SURVEY_COMMAND.endsWith("\ntrue")).toBe(true);
    expect(DISK_FOLDERS_COMMAND).toBe('echo "home:$HOME"; timeout 15 du -xk -d 1 "$HOME" 2>/dev/null | sort -rn | head -n 9; true');
  });
});

describe("a no-space error", () => {
  it.each([
    "bash: line 1: echo: write error: No space left on device",
    "Error: ENOSPC: no space left on device, write",
    "OSError: [Errno 28] No space left on device",
    "npm ERR! code ENOSPC",
    "cp: error writing 'a': Disk quota exceeded",
    "write /var/lib/docker/tmp/x: no space left on device",
    "The cloud computer answered 507 to the copy. Try again in a minute.",
  ])("is recognised in: %s", (text) => {
    expect(isNoSpaceError(text)).toBe(true);
  });

  it.each([
    "captured",
    "Not enough space for data.csv: it needs 1.0 GiB with 256.0 MiB kept free, and the working folder's disk has 0.1 GiB free.",
    "The cloud computer answered 404 to the copy. Try again in a minute.",
    "namespace left on device list",
  ])("is not seen in: %s", (text) => {
    expect(isNoSpaceError(text)).toBe(false);
  });
});

describe("the largest folders", () => {
  it("are the top eight under the home folder, without the home folder's own total", () => {
    const lines = ["home:/home/user", "900\t/home/user", ...Array.from({ length: 10 }, (_unused, index) => `${(index + 1) * 10}\t/home/user/dir${index + 1}`), "junk", "0\t/home/user/empty"];
    const folders = parseFolders(lines.join("\n"));
    expect(folders).toHaveLength(8);
    expect(folders[0]).toEqual({ path: "/home/user/dir10", kb: 100 });
    expect(folders.at(-1)).toEqual({ path: "/home/user/dir3", kb: 30 });
  });

  it("are none when du printed nothing", () => {
    expect(parseFolders("home:/home/user\n")).toEqual([]);
    expect(parseFolders("")).toEqual([]);
  });

  it("are sized for reading", () => {
    expect([sized(500), sized(300 * 1024), sized(1.5 * GB), sized(31 * GB)]).toEqual(["1 MB", "300 MB", "1.5 GB", "31 GB"]);
  });
});

describe("what the bot is told", () => {
  const NOW = 1_700_000_000_000;
  const facts = (over: Partial<DiskFacts>): DiskFacts => ({ percent: 50, cleaning: false, cleanup: null, cleanupTold: true, folders: null, ...over });
  const folders = [{ path: "/home/user/data", kb: 31 * GB }, { path: "/home/user/.local", kb: 9.2 * GB }];

  it("is nothing while the disk is fine", () => {
    expect(diskNotice(facts({ percent: 84 }), NOW)).toBeNull();
    expect(diskNotice(facts({ percent: 84, folders }), NOW)).toBeNull();
  });

  it("is one line after a cleanup that made room", () => {
    expect(diskNotice(facts({ percent: 62, cleanupTold: false, cleanup: { at: NOW, before: 85, after: 62, freedKb: 19 * GB } }), NOW))
      .toBe("Disk note: this cloud computer's disk was 85% full; MausBot cleared caches (19 GB freed), now 62%.");
  });

  it("adds the largest folders when it is still at 90% after the cleanup", () => {
    expect(diskNotice(facts({ percent: 91, cleanupTold: false, cleanup: { at: NOW, before: 93, after: 91, freedKb: 2 * GB }, folders }), NOW)).toBe(
      "Disk note: this cloud computer's disk was 93% full; MausBot cleared caches (2.0 GB freed), now 91%.\n"
      + "Largest folders: /home/user/data 31 GB, /home/user/.local 9.2 GB. Remove what is no longer needed.");
    expect(diskNotice(facts({ percent: 89, cleanupTold: false, cleanup: { at: NOW, before: 93, after: 89, freedKb: 3 * GB }, folders }), NOW)).not.toContain("Largest folders");
  });

  it("says plainly at 95% that writes may fail", () => {
    expect(diskNotice(facts({ percent: 96, cleanupTold: false, cleanup: { at: NOW, before: 97, after: 96, freedKb: 100 }, folders }), NOW)).toBe(
      "Disk note: this cloud computer's disk was 97% full; MausBot cleared caches, now 96%. Writes may fail until space is freed.\n"
      + "Largest folders: /home/user/data 31 GB, /home/user/.local 9.2 GB. Remove what is no longer needed.");
    expect(diskNotice(facts({ percent: 94 }), NOW)).not.toContain("Writes may fail");
  });

  it("says a cleanup is under way, and when the last one was, in at most two lines", () => {
    expect(diskNotice(facts({ percent: 97, cleaning: true, folders }), NOW))
      .toBe("Disk note: this cloud computer's disk is 97% full; MausBot is clearing caches now, which can take a few minutes. Writes may fail until space is freed.");
    expect(diskNotice(facts({ percent: 87, cleanup: { at: NOW - 20 * MINUTE, before: 90, after: 87, freedKb: GB } }), NOW))
      .toBe("Disk note: this cloud computer's disk is 87% full; its caches were cleared 20 min ago.");
    expect(diskNotice(facts({ percent: 87, cleanup: { at: NOW - 61 * MINUTE, before: 90, after: 87, freedKb: GB } }), NOW))
      .toBe("Disk note: this cloud computer's disk is 87% full.");
    for (const percent of [85, 90, 95, 100]) {
      expect(diskNotice(facts({ percent, folders: Array.from({ length: 8 }, (_unused, index) => ({ path: `/home/user/d${index}`, kb: GB })) }), NOW)!.split("\n").length).toBeLessThanOrEqual(2);
    }
  });
});

describe("watching a computer's disk", () => {
  it("does nothing to a disk under 85%, and says nothing", async () => {
    const h = harness({ percent: 84 });
    await h.use();
    expect(h.disk.percent(BOX)).toBe(84);
    expect([h.count("check"), h.count("survey"), h.count("cleanup")]).toEqual([1, 0, 0]);
    expect(await h.disk.after(null, BOX, ["captured"])).toBeNull();
    expect(h.disk.panel(BOX)).toBeNull();
  });

  it("clears caches at 85% in the background, with only the steps the computer has tools for, and tells the bot once", async () => {
    const h = harness({ percent: 85, cleansTo: 62, tools: ["sudo", "apt-get", "pip-cache"] });
    await h.use();
    expect([h.count("check"), h.count("survey"), h.count("cleanup"), h.count("folders")]).toEqual([2, 1, 1, 0]);
    const cleanup = h.sent.find(({ command }) => command.includes("/bin/sh -c"))!;
    expect(cleanup.command).toBe(isolatedRemoteCommand(cleanupCommand(["sudo -n apt-get clean", `pgrep '^(pip)' >/dev/null 2>&1 || rm -rf -- "$HOME/.cache/pip"`, TMP_STEP])));
    expect(cleanup).toMatchObject({ long: true, timeoutMs: DISK.cleanupFollowMs });
    expect(h.sent.filter(({ long }) => long)).toHaveLength(1);
    expect(await h.disk.after(null, BOX, ["captured"])).toBe("Disk note: this cloud computer's disk was 85% full; MausBot cleared caches (19 GB freed), now 62%.");
    expect(await h.disk.after(null, BOX, ["captured"])).toBeNull();
    expect(h.logs).toEqual([`cloud computer ${BOX}: disk was 85% full; cleared caches, now 62%`]);
  });

  it("lists the largest folders when the disk is still at 90% after the cleanup", async () => {
    const h = harness({ percent: 96, cleansTo: 92, folders: "home:/home/user\n9000000\t/home/user\n5242880\t/home/user/data\n2097152\t/home/user/.cache\n" });
    await h.use();
    expect(h.count("folders")).toBe(1);
    expect(await h.disk.after(null, BOX, [])).toBe(
      "Disk note: this cloud computer's disk was 96% full; MausBot cleared caches (3.4 GB freed), now 92%.\nLargest folders: /home/user/data 5.0 GB, /home/user/.cache 2.0 GB. Remove what is no longer needed.");
  });

  it("holds the note back while the cleanup runs, so the bot is told once, with the result", async () => {
    const h = harness({ percent: 91, cleanup: "hang" });
    h.disk.used(null, BOX);
    await h.flush();
    expect(h.count("cleanup")).toBe(1);
    expect(await h.disk.after(null, BOX, ["captured"])).toBeNull();
  });

  it("reads the disk at most once in ten minutes, however often the computer is used", async () => {
    const h = harness({ percent: 40 });
    for (let call = 0; call < 5; call++) await h.use();
    expect(h.count("check")).toBe(1);
    await h.advance(DISK.checkEveryMs - 1);
    await h.use();
    expect(h.count("check")).toBe(1);
    await h.advance(1);
    await h.use();
    expect(h.count("check")).toBe(2);
  });

  it("does not read again for ten minutes after a df that failed", async () => {
    const h = harness({ df: "error" });
    await h.use();
    await h.use();
    expect(h.count("check")).toBe(1);
    expect(h.disk.percent(BOX)).toBeNull();
  });

  it("clears caches at most once an hour, and tells the bot when the level rises in between", async () => {
    const h = harness({ percent: 88 });
    await h.use();
    expect(h.count("cleanup")).toBe(1);
    expect(await h.disk.after(null, BOX, [])).toBe("Disk note: this cloud computer's disk was 88% full; MausBot cleared caches, now 88%.");
    for (let round = 0; round < 4; round++) { await h.advance(DISK.checkEveryMs); await h.use(); }
    expect([h.count("check"), h.count("cleanup")]).toEqual([6, 1]);
    expect(await h.disk.after(null, BOX, [])).toBeNull();
    h.world.percent = 96;
    await h.advance(DISK.checkEveryMs);
    await h.use();
    expect([h.count("cleanup"), h.count("folders")]).toEqual([1, 1]);
    expect(await h.disk.after(null, BOX, [])).toBe("Disk note: this cloud computer's disk is 96% full; its caches were cleared 50 min ago. Writes may fail until space is freed.");
    expect(await h.disk.after(null, BOX, [])).toBeNull();
    await h.advance(DISK.checkEveryMs);
    await h.use();
    expect(h.count("cleanup")).toBe(2);
  });

  it("tries the cleanup again at the next reading when the computer could not be asked what it has", async () => {
    const h = harness({ percent: 90, survey: "error" });
    await h.use();
    expect([h.count("survey"), h.count("cleanup")]).toEqual([1, 0]);
    h.world.survey = "ok";
    await h.advance(DISK.checkEveryMs);
    await h.use();
    expect([h.count("survey"), h.count("cleanup")]).toEqual([2, 1]);
  });

  it("treats a df that errors, prints nonsense or never answers as unknown, never as full", async () => {
    for (const broken of ["error", "garbage", "hang"] as const) {
      const h = harness({ percent: 99, df: broken });
      h.disk.used(null, BOX);
      await h.advance(DISK.checkTimeoutMs);
      expect(h.disk.percent(BOX), broken).toBeNull();
      expect([h.count("survey"), h.count("cleanup")], broken).toEqual([0, 0]);
      expect(await h.disk.after(null, BOX, ["captured"]), broken).toBeNull();
      expect(h.disk.panel(BOX), broken).toBeNull();
    }
  });

  it("reads at once after a no-space error, inside the ten minutes, and says a cleanup has started", async () => {
    const h = harness({ percent: 40, cleanup: "hang" });
    await h.use();
    h.world.percent = 99;
    const note = await h.disk.after(null, BOX, ['{"ok":false,"exitCode":1,"stdout":"","stderr":"cp: error writing: No space left on device"}']);
    expect(h.count("check")).toBe(2);
    expect(note).toBe("Disk note: this cloud computer's disk is 99% full; MausBot is clearing caches now, which can take a few minutes. Writes may fail until space is freed.");
    await h.flush();
    expect(h.count("cleanup")).toBe(1);
    await h.disk.after(null, BOX, ["ENOSPC"]);
    expect(h.count("check")).toBe(2);
    await h.advance(DISK.noSpaceGapMs);
    await h.disk.after(null, BOX, ["ENOSPC"]);
    expect(h.count("check")).toBe(3);
  });

  it("says nothing after a no-space error on a disk that has room, such as a quota or another filesystem", async () => {
    const h = harness({ percent: 40 });
    expect(await h.disk.after(null, BOX, ["Disk quota exceeded"])).toBeNull();
    expect([h.count("check"), h.count("survey")]).toEqual([1, 0]);
  });

  it("never holds a call: using the computer returns at once, and a reading that hangs is given up after three seconds", async () => {
    const h = harness({ df: "hang" });
    expect(h.disk.used(null, BOX)).toBeUndefined();
    let settled: string | null | undefined;
    void h.disk.after(null, BOX, ["captured"]).then((note) => { settled = note; });
    await h.flush();
    expect(settled).toBeNull();

    const full = harness({ df: "hang" });
    let answered = false;
    void full.disk.after(null, BOX, ["No space left on device"]).then(() => { answered = true; });
    await full.advance(DISK.checkTimeoutMs - 1);
    expect(answered).toBe(false);
    await full.advance(1);
    expect(answered).toBe(true);
    expect(DISK.checkTimeoutMs).toBeLessThanOrEqual(3_000);
    expect(full.sent.every(({ timeoutMs }) => timeoutMs === DISK.checkTimeoutMs)).toBe(true);
  });

  it("answers a call even when the runner throws on the spot", async () => {
    const disk = createCloudComputerDisk<null>({ now: () => 0, sleep: () => new Promise(() => {}), log: () => {}, run: () => { throw new Error("no computer"); } });
    expect(() => disk.used(null, BOX)).not.toThrow();
    await expect(disk.after(null, BOX, ["No space left on device"])).resolves.toBeNull();
    await expect(disk.beforeRun(null, BOX)).resolves.toBeUndefined();
  });

  it("rides on the ready probe: one df in place of `true` per ten minutes, and its answer starts a cleanup", async () => {
    const h = harness({ cleansTo: 60 });
    expect(h.disk.probeCommand(BOX)).toBe(DISK_CHECK_COMMAND);
    expect(h.disk.probeCommand(BOX)).toBeNull();
    h.disk.probed(null, BOX, df(91));
    await h.flush();
    await h.disk.idle(BOX);
    expect([h.count("check"), h.count("cleanup")]).toEqual([1, 1]);
    await h.use();
    expect(h.count("check")).toBe(1);
    await h.advance(DISK.checkEveryMs);
    expect(h.disk.probeCommand(BOX)).toBe(DISK_CHECK_COMMAND);
    h.disk.probed(null, BOX, "captured");
    expect(h.disk.percent(BOX)).toBe(60);
  });

  it("keeps a bounded number of computers", () => {
    const h = harness();
    for (let index = 0; index < DISK.maxComputers + 5; index++) h.disk.probeCommand(`bx_${index}`);
    expect(h.disk.probeCommand("bx_0")).toBe(DISK_CHECK_COMMAND);
    expect(h.disk.probeCommand(`bx_${DISK.maxComputers + 4}`)).toBeNull();
  });
});

describe("before an unattended run", () => {
  it("sends nothing when the disk was never read or was last seen with room", async () => {
    const h = harness({ percent: 70 });
    await h.disk.beforeRun(null, BOX);
    expect(h.sent).toEqual([]);
    await h.use();
    await h.disk.beforeRun(null, BOX);
    expect(h.count("check")).toBe(1);
  });

  it("reads again and waits for the cleanup when the disk was last seen at 85% or more", async () => {
    const h = harness({ percent: 93, cleansTo: 93 });
    await h.use();
    await h.advance(DISK.cleanEveryMs);
    h.world.cleansTo = 60;
    const before = h.count("cleanup");
    await h.disk.beforeRun(null, BOX);
    expect(h.count("cleanup")).toBe(before + 1);
    expect(h.disk.percent(BOX)).toBe(60);
  });

  it("starts the run after a bounded wait when the cleanup does not end, and at once when the reading fails", async () => {
    const h = harness({ percent: 93 });
    await h.use();
    await h.advance(DISK.cleanEveryMs);
    h.world.cleanup = "hang";
    let started = false;
    void h.disk.beforeRun(null, BOX).then(() => { started = true; });
    await h.flush();
    await h.advance(DISK.runWaitMs - 1);
    expect(started).toBe(false);
    await h.advance(1);
    expect(started).toBe(true);

    const silent = harness({ percent: 93 });
    await silent.use();
    silent.world.df = "hang";
    let ready = false;
    void silent.disk.beforeRun(null, BOX).then(() => { ready = true; });
    await silent.flush();
    expect(ready).toBe(false);
    await silent.advance(DISK.checkTimeoutMs);
    expect(ready).toBe(true);
  });
});

describe("the panel's disk figure", () => {
  it("is absent under 85%, the figure from 85%, and the time of the last cleanup for a day", async () => {
    const h = harness({ percent: 84 });
    await h.use();
    expect(h.disk.panel(BOX)).toBeNull();
    expect(h.disk.panel(null)).toBeNull();
    expect(h.disk.panel("bx_other")).toBeNull();

    const full = harness({ percent: 91, cleansTo: 91 });
    await full.use();
    const clearedAt = full.now();
    expect(full.disk.panel(BOX)).toEqual({ percent: 91, clearedAt });

    const cleared = harness({ percent: 91, cleansTo: 62 });
    await cleared.use();
    expect(cleared.disk.panel(BOX)).toEqual({ percent: 62, clearedAt: cleared.now() });
    await cleared.advance(DISK.panelClearedMs);
    expect(cleared.disk.panel(BOX)).toBeNull();
  });
});
