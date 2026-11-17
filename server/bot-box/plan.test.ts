import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { engineInstallRoots } from "../engine-roots.ts";
import { BOX_MUTATIONS, CPU_LIST_FILES, argvPaths, bwrapArgs, planBox, taskWorkspaceIds, visibleInBox, type BoxMutation, type BoxSetup } from "./plan.ts";

const home = "/data";
const dataDir = "/data/.openmausbot";
const setup = (mutate?: BoxMutation[]): BoxSetup => ({
  dataDir, home, codeRoots: ["/app"], engineRoots: engineInstallRoots(dataDir), seccompFd: 3,
  bridges: [{ name: "egress", port: 3128, socket: `${dataDir}/box/egress.sock` }, { name: "harness", port: 8799, socket: `${dataDir}/box/harness.sock` }],
  mutate: mutate ? new Set(mutate) : undefined,
});
const cwd = join(dataDir, "task-workspaces", "bot-a", "thread-1");
const turn = (mutate?: BoxMutation[]) => planBox(setup(mutate), {
  command: "/usr/local/bin/claude", args: ["-p", "--additional-mcp-config", "@/tmp/omb-copilot-mcp-x/config.json", "--append-system-prompt-file=/tmp/omb-system-y/prompt.txt"],
  cwd, env: { PATH: "/usr/bin", HOME: home, CLAUDE_CONFIG_DIR: "/data/.claude" }, rw: [join(dataDir, "perm-abc.sock")],
});

// The box runs only on a Linux Cloud home (detect.ts says "not-linux" anywhere else): its plan is bubblewrap's argv
// over POSIX paths, which Windows' path module would write with drive letters and backslashes.
const linuxBox = describe.skipIf(process.platform === "win32");

describe("explicit read-only grants", () => {
  it("overrides a writable engine profile for its staged skills", () => {
    const home = join(process.cwd(), "box-fixture-home");
    const dataDir = join(home, "data");
    const profile = join(dataDir, "providers", "antigravity", "account");
    const skills = join(profile, "omb-skills");
    const plan = planBox({ dataDir, home, codeRoots: [], engineRoots: [], bridges: [] }, {
      command: "antigravity", args: [], cwd: join(dataDir, "task-workspaces", "bot", "thread"),
      env: { HOME: home, GEMINI_HOME: profile }, ro: [skills],
    });
    expect(visibleInBox(plan, join(skills, "hash", "SKILL.md"))).toBe("ro");
    expect(visibleInBox(plan, join(profile, "antigravity-acp", "acp_token.json"))).toBe("rw");
    const args = bwrapArgs(plan);
    expect(args).toContain("--ro-bind-try");
    expect(args.slice(args.indexOf(skills) - 1, args.indexOf(skills) + 2)).toEqual(["--ro-bind-try", skills, skills]);
  });
});

linuxBox("the box plan", () => {
  it("shows the turn its own folders and the code, and nothing else of the data folder", () => {
    const plan = turn();
    expect(plan.botId).toBe("bot-a");
    expect(visibleInBox(plan, cwd)).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "bots", "bot-a", "SOUL.md")), "its own standing instructions, never writable").toBe("ro");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-a", "MEMORY.md"))).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "perm-abc.sock"))).toBe("rw");
    expect(visibleInBox(plan, "/data/.claude/settings.json")).toBe("rw");
    expect(visibleInBox(plan, "/tmp/omb-copilot-mcp-x/config.json")).toBe("ro");
    expect(visibleInBox(plan, "/tmp/omb-system-y/prompt.txt")).toBe("ro");
    expect(visibleInBox(plan, "/app/dist-server/index.js")).toBe("ro");
    expect(visibleInBox(plan, "/usr/local/bin/claude")).toBe("ro");
    for (const hidden of ["messages.db", "config.json", "logins.json", "providers/x", "tools/y", "box/egress.sock",
      "workspaces/bot-b/MEMORY.md", "task-workspaces/bot-b/thread-9/notes.md", "task-workspaces/bot-a/thread-2/notes.md",
      "bots/bot-b/SOUL.md", "bots/bot-a/other.json"]) {
      expect(visibleInBox(plan, join(dataDir, hidden)), hidden).toBe("none");
    }
    expect(visibleInBox(plan, "/tmp/other-turn/mcp.json")).toBe("none");
    expect(visibleInBox(plan, "/.fly/api")).toBe("none");
    expect(visibleInBox(plan, "/root/.ssh/id_ed25519")).toBe("none");
  });

  it("a process the bot's conversations share sees all of that bot's conversation folders and uploads, and no other bot's", () => {
    const plan = planBox(setup(), { command: "opencode", args: ["acp"], cwd, env: { HOME: home }, botThreads: true });
    expect(plan.botId).toBe("bot-a");
    for (const own of ["task-workspaces/bot-a/thread-1/a.md", "task-workspaces/bot-a/thread-2/notes.md", "workspaces/bot-a/MEMORY.md"]) expect(visibleInBox(plan, join(dataDir, own)), own).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "box-uploads", "bot-a", "thread-2", "photo.png"))).toBe("ro");
    for (const hidden of ["task-workspaces/bot-b/thread-9/notes.md", "workspaces/bot-b/MEMORY.md", "box-uploads/bot-b/thread-9/x.png", "messages.db"]) {
      expect(visibleInBox(plan, join(dataDir, hidden)), hidden).toBe("none");
    }
    expect(visibleInBox(turn(), join(dataDir, "box-uploads", "bot-a", "thread-2", "photo.png")), "one conversation's box keeps only its own uploads").toBe("none");
  });

  it("writes the bubblewrap argv in mount order, with its own namespaces and the bridged sockets", () => {
    const args = bwrapArgs(turn());
    const text = args.join(" ");
    for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--hostname omb-box", "--seccomp 3", `--chdir ${cwd}`]) expect(text).toContain(flag);
    expect(bwrapArgs(planBox({ ...setup(), seccompFd: undefined }, { command: "/usr/bin/x", args: [], env: {} })).join(" ")).not.toContain("--seccomp");
    expect(text).toContain("--ro-bind /usr /usr");
    expect(text).toContain("--symlink usr/bin /bin");
    expect(text).toContain("--proc /proc --dev /dev --tmpfs /tmp");
    // HOME, then the data folder emptied, then the turn's own folders put back: order is the protection.
    const order = [args.indexOf("--bind"), args.indexOf("--tmpfs", args.indexOf(home)), args.indexOf(cwd)];
    expect(args[order[0]! + 1]).toBe(home);
    expect(args[order[1]! + 1]).toBe(dataDir);
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(text).toContain(`--dir /run/omb --bind ${dataDir}/box/egress.sock /run/omb/egress.sock --bind ${dataDir}/box/harness.sock /run/omb/harness.sock`);
    expect(text).not.toContain("--new-session");
  });

  it("puts the engines OpenMausBot installed back whole and read-only, whatever else the turn may write", () => {
    // npm's bin entries are relative links into the prefix: `bin/opencode -> ../lib/node_modules/opencode-ai/bin/opencode.exe`.
    const prefix = join(dataDir, "tools", "npm");
    const engineFiles = [`${prefix}/bin/opencode`, `${prefix}/lib/node_modules/opencode-ai/bin/opencode.exe`, `${prefix}/bin/codex`,
      `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`, join(dataDir, "tools", "antigravity-acp", "linux-x64", "versions", "abc", "agy_acp_server"),
      // An AI's own build the app installed without Node.js: the PATH entry and its version folder.
      join(dataDir, "tools", "standalone", "opencode", "bin", "opencode"), join(dataDir, "tools", "standalone", "opencode", "1.19.4", "opencode")];
    const asked = planBox(setup(), {
      command: `${prefix}/bin/opencode`, args: ["acp", `${prefix}/lib/node_modules/opencode-ai/package.json`], cwd,
      env: { HOME: home, XDG_CACHE_HOME: `${prefix}/cache`, OPENCODE_HOME: `${prefix}/lib` }, rw: [`${prefix}/bin`, join(dataDir, "tools")],
    });
    for (const plan of [turn(), turn(["bind-data"]), asked]) {
      for (const file of engineFiles) expect(visibleInBox(plan, file), file).toBe("ro");
    }
    for (const other of ["tools/chrome/131/linux/chrome", "tools/agent-browser/0.37/agent-browser", "tools/token"]) {
      expect(visibleInBox(turn(), join(dataDir, other)), other).toBe("none");
    }
    const args = bwrapArgs(turn());
    const engines = args.findIndex((arg, i) => arg === "--ro-bind-try" && args[i + 1] === prefix && args[i + 2] === prefix);
    expect(engines).toBeGreaterThan(args.findIndex((arg, i) => arg === "--tmpfs" && args[i + 1] === dataDir));
    const lastWritable = args.reduce((last, arg, i) => (arg === "--bind" || arg === "--bind-try") && !args[i + 2]!.startsWith("/run/omb/") ? i : last, -1);
    expect(engines).toBeGreaterThan(lastWritable);
  });

  it("the engines are there wherever HOME and the data folder are", () => {
    const own = join(dataDir, "engine-homes", "member-aaaaaaaaaaaaaaaa");
    const team = planBox(setup(), { command: "opencode", args: [], cwd, env: { HOME: own }, home: own });
    expect(visibleInBox(team, join(dataDir, "tools", "npm", "bin", "opencode"))).toBe("ro");
    const apart = planBox({ ...setup(), dataDir: "/srv/omb", home: "/home/maus", engineRoots: engineInstallRoots("/srv/omb") }, { command: "opencode", args: [], cwd: "/srv/omb/task-workspaces/b/t", env: {} });
    expect(visibleInBox(apart, "/srv/omb/tools/npm/bin/opencode")).toBe("ro");
    expect(visibleInBox(apart, "/srv/omb/messages.db")).toBe("none");
  });

  it("TMPDIR never puts the host's /tmp back; another temp folder is put back", () => {
    const plan = planBox(setup(), { command: "/usr/bin/x", args: [], cwd, env: { TMPDIR: "/tmp" } });
    expect(visibleInBox(plan, "/tmp/other-turn/mcp.json")).toBe("none");
    expect(visibleInBox(plan, "/tmp")).toBe("none");
    const elsewhere = planBox(setup(), { command: "/usr/bin/x", args: [], cwd, env: { TMPDIR: "/data/scratch" } });
    expect(visibleInBox(elsewhere, "/data/scratch/x")).toBe("rw");
  });

  it("a shared-network box (a browser) has no bridges and no network namespace", () => {
    const plan = planBox(setup(), { command: "/opt/chrome", args: [], env: {}, net: "shared", rw: ["/data/.openmausbot/browser/profiles/p1"] });
    expect(plan.net).toBe("shared");
    expect(bwrapArgs(plan).join(" ")).not.toContain("--unshare-net");
    expect(bwrapArgs(plan).join(" ")).not.toContain("/run/omb");
    expect(visibleInBox(plan, "/data/.openmausbot/browser/profiles/p1/Default")).toBe("rw");
    expect(visibleInBox(plan, "/data/.openmausbot/messages.db")).toBe("none");
  });

  it("a relay socket goes in at /run/omb/relay.sock only for a box with its own network", () => {
    const relay = `${dataDir}/box/relay-ab12.sock`;
    const plan = planBox(setup(), { command: "/usr/bin/agy", args: [], cwd, env: { HOME: home }, relay });
    expect(bwrapArgs(plan).join(" ")).toContain(`--bind ${relay} /run/omb/relay.sock`);
    expect(visibleInBox(plan, "/run/omb/relay.sock")).toBe("rw");
    expect(visibleInBox(plan, relay)).toBe("none");
    expect(visibleInBox(plan, `${dataDir}/box/egress.sock`)).toBe("none");
    const shared = planBox(setup(), { command: "/opt/chrome", args: [], env: {}, net: "shared", relay });
    expect(bwrapArgs(shared).join(" ")).not.toContain(relay);
  });

  it("has the machine's CPU list read-only and nothing else of /sys, so a TCMalloc runtime (Antigravity) can start", () => {
    // Measured on a Fly Cloud home (2, 4 and 8 shared CPUs): without `possible` Google's runtime stops at start with
    // "tcmalloc/internal/sysinfo.h:76] CHECK in NumCPUs" and exit 134; with it, initialize answers.
    const command = join(dataDir, "tools", "antigravity-acp", "linux-x64", "versions", "abc", "agy_acp_server.par");
    for (const plan of [turn(), planBox(setup(), { command, args: ["--uid="], cwd, env: { HOME: home } })]) {
      expect(visibleInBox(plan, "/sys/devices/system/cpu/possible")).toBe("ro");
      expect(visibleInBox(plan, "/sys/devices/system/cpu/online")).toBe("ro");
      for (const hidden of ["/sys/devices/system/cpu/vulnerabilities/spectre_v2", "/sys/class/net/eth0/address", "/sys/fs/cgroup/memory.max", "/sys/kernel/mm"]) {
        expect(visibleInBox(plan, hidden), hidden).toBe("none");
      }
      const text = bwrapArgs(plan).join(" ");
      for (const file of CPU_LIST_FILES) expect(text).toContain(`--ro-bind-try ${file} ${file}`);
      expect(text).not.toMatch(/--(?:ro-)?bind(?:-try)? \/sys /);
    }
  });

  it("Antigravity's own profile (GEMINI_HOME) goes back read-write, and no other account's", () => {
    const profile = join(dataDir, "providers", "antigravity", "a".repeat(64));
    const plan = planBox(setup(), { command: join(dataDir, "tools", "antigravity-acp", "linux-x64", "versions", "abc", "agy_acp_server"), args: ["--uid="], cwd, env: { HOME: home, GEMINI_HOME: profile } });
    expect(visibleInBox(plan, join(profile, "antigravity-acp", "acp_token.json"))).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "providers", "antigravity", "b".repeat(64), "antigravity-acp", "acp_token.json"))).toBe("none");
    expect(visibleInBox(plan, join(dataDir, "providers", "key"))).toBe("none");
  });

  it("a cwd outside the data folder is the turn's folder; a bot named by the caller gets its own folder", () => {
    const plan = planBox(setup(), { command: "/usr/bin/codex", args: [], cwd: "/data/projects/site", env: { HOME: home }, botId: "bot-z" });
    expect(plan.botId).toBe("bot-z");
    expect(visibleInBox(plan, "/data/projects/site/index.html")).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-z"))).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-y"))).toBe("none");
  });

  it("on a Team Cloud the turn's HOME is its audience's engine home: the server's HOME and every other audience's home are not there", () => {
    const own = join(dataDir, "engine-homes", "member-aaaaaaaaaaaaaaaa"), other = join(dataDir, "engine-homes", "member-bbbbbbbbbbbbbbbb");
    const plan = planBox(setup(), {
      command: "/usr/local/bin/claude", args: [], cwd, env: { HOME: own, CLAUDE_CONFIG_DIR: `${own}/.claude-work`, CODEX_HOME: `${own}/.omb-folders/CODEX_HOME-abc` },
      home: own, shared: [{ source: "/data/.claude/.credentials.json", target: `${own}/.claude/.credentials.json` }, { source: "/data/x", target: "/elsewhere/x" }],
    });
    expect(visibleInBox(plan, `${own}/.claude/projects/p/s.jsonl`)).toBe("rw");
    expect(visibleInBox(plan, `${own}/.claude/.credentials.json`)).toBe("rw");
    for (const hidden of [`${other}/.claude/projects/p/s.jsonl`, "/data/.claude/projects/p/s.jsonl", "/data/.claude/.credentials.json", "/data/.codex/sessions/x.jsonl",
      "/data/notes.txt", join(dataDir, "engine-homes", ".held", "1", "x"), join(dataDir, "messages.db"), "/elsewhere/x"]) {
      expect(visibleInBox(plan, hidden), hidden).toBe("none");
    }
    expect(visibleInBox(plan, cwd)).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-a", "MEMORY.md"))).toBe("rw");
    // The home goes back after the data folder is emptied, the team's sign-in over its name in the home after that.
    const args = bwrapArgs(plan);
    const at = (flag: string, target: string) => args.findIndex((arg, i) => arg === flag && args[i + (flag === "--tmpfs" ? 1 : 2)] === target);
    expect(args).not.toContain(home);
    expect(at("--tmpfs", dataDir)).toBeGreaterThan(-1);
    expect(at("--tmpfs", dataDir)).toBeLessThan(at("--bind", own));
    expect(at("--bind", own)).toBeLessThan(at("--bind-try", `${own}/.claude/.credentials.json`));
    expect(args.join(" ")).toContain(`--bind-try /data/.claude/.credentials.json ${own}/.claude/.credentials.json`);
    expect(args.filter((arg) => arg.startsWith(`${own}/.omb-folders`) || arg === `${own}/.claude-work`)).toEqual([]);
    // Without an engine home (a My Cloud, a desktop) the box has the server's HOME as before.
    expect(visibleInBox(turn(), "/data/.claude/projects/p/s.jsonl")).toBe("rw");
  });

  it("a data folder outside HOME is simply not there", () => {
    const plan = planBox({ ...setup(), dataDir: "/srv/omb", home: "/home/maus" }, { command: "/usr/bin/x", args: [], cwd: "/srv/omb/task-workspaces/b/t", env: {} });
    expect(visibleInBox(plan, "/srv/omb/messages.db")).toBe("none");
    expect(visibleInBox(plan, "/srv/omb/task-workspaces/b/t")).toBe("rw");
    expect(visibleInBox(plan, "/srv/omb/workspaces/b")).toBe("rw");
    expect(bwrapArgs(plan).join(" ")).not.toContain("--tmpfs /srv/omb");
  });

  it("shows no path on the command line that is in the data folder or holds it, unless the caller named it", () => {
    for (const { dataDir, home } of [{ dataDir: "/data/.openmausbot", home: "/data" }, { dataDir: "/srv/omb", home: "/home/maus" }]) {
      const server = ["config.json", "sessions.json", "messages.db", "workspaces/other/MEMORY.md"].map((file) => join(dataDir, file));
      const ask = (args: string[], ro: string[] = []) => planBox({ ...setup(), dataDir, home }, { command: "/bin/sh", args, cwd: join(dataDir, "task-workspaces", "b", "t"), env: {}, botId: "b", ro });
      for (const args of [server, [dataDir], [`--model=${server[0]}`], [`@${server[0]}`], [join(dataDir, "..")], [join(dataDir, "workspaces", "..")], ["/srv", "/var"]]) {
        const plan = ask(args);
        for (const file of server) expect(visibleInBox(plan, file), `${dataDir}: ${args.join(" ")}`).toBe("none");
      }
      // A server whose program is in the bot's own folder still finds it: with the bot known its folder is there
      // anyway, and without one (a configured server run for a chat) the file itself is shown, read-only.
      expect(visibleInBox(ask([join(dataDir, "workspaces", "b", "tools", "server.js")]), join(dataDir, "workspaces", "b", "tools", "server.js"))).not.toBe("none");
      const noBot = planBox({ ...setup(), dataDir, home }, { command: "python3", args: [join(dataDir, "workspaces", "b", "tools", "server.py")], env: {}, configured: true });
      expect(visibleInBox(noBot, join(dataDir, "workspaces", "b", "tools", "server.py"))).toBe("ro");
      expect(visibleInBox(noBot, join(dataDir, "config.json"))).toBe("none");
      // Never another bot's for a box that has a bot, and never the folder of every bot.
      expect(visibleInBox(ask([join(dataDir, "workspaces", "other", "MEMORY.md")]), join(dataDir, "workspaces", "other", "MEMORY.md"))).toBe("none");
      for (const all of [join(dataDir, "workspaces"), join(dataDir, "task-workspaces")]) {
        expect(visibleInBox(planBox({ ...setup(), dataDir, home }, { command: "ls", args: [all], env: {}, configured: true }), join(all, "other", "MEMORY.md"))).toBe("none");
      }
      expect(visibleInBox(ask(["--token", join(dataDir, "hook-tokens", "t", "token")], [join(dataDir, "hook-tokens", "t")]), join(dataDir, "hook-tokens", "t", "token"))).toBe("ro");
      expect(visibleInBox(ask(["--mcp-config", "/tmp/omb-mcp-1/mcp.json"]), "/tmp/omb-mcp-1/mcp.json")).toBe("ro");
      expect(visibleInBox(ask([]), join(dataDir, "bots", "b", "SOUL.md"))).toBe("ro");
    }
  });

  it("makes nothing of the data folder writable for a configured server's environment, but the bot's own folders", () => {
    const dataDir = "/data/.openmausbot";
    const ask = (env: Record<string, string>, configured: boolean) => planBox({ ...setup(), dataDir, home: "/data" }, { command: "sh", args: [], cwd: join(dataDir, "task-workspaces", "b", "t"), env, botId: "b", configured });
    for (const value of [join(dataDir, "config.json"), join(dataDir, "box"), dataDir, join(dataDir, "workspaces", "other"), "/"]) {
      for (const name of ["XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
        const plan = ask({ [name]: value }, true);
        for (const file of ["config.json", "box/harness.sock", "messages.db", "workspaces/other/MEMORY.md"]) expect(visibleInBox(plan, join(dataDir, file)), `${name}=${value}`).toBe("none");
      }
    }
    expect(visibleInBox(ask({ XDG_CACHE_HOME: join(dataDir, "workspaces", "b", "cache") }, true), join(dataDir, "workspaces", "b", "cache", "x"))).toBe("rw");
    // An engine OpenMausBot starts keeps the home it was given there.
    expect(visibleInBox(ask({ CODEX_HOME: join(dataDir, "providers", "codex-1") }, false), join(dataDir, "providers", "codex-1", "auth.json"))).toBe("rw");
  });

  it("each mutation opens exactly the hole it names", () => {
    const base = turn();
    const flips: Record<BoxMutation, (plan: ReturnType<typeof turn>) => boolean> = {
      "bind-data": (plan) => visibleInBox(plan, join(dataDir, "messages.db")) === "rw",
      "bind-otherws": (plan) => visibleInBox(plan, join(dataDir, "workspaces", "bot-b", "MEMORY.md")) === "rw",
      "share-pid": (plan) => !plan.options.includes("--unshare-pid"),
      "share-net": (plan) => plan.net === "shared",
      "env-all": () => true,
      "tmp-shared": (plan) => visibleInBox(plan, "/tmp/other-turn/mcp.json") === "rw",
      "no-seccomp": (plan) => !plan.options.includes("--seccomp"),
      "engines-rw": (plan) => visibleInBox(plan, join(dataDir, "tools", "npm", "bin", "opencode")) === "rw",
    };
    for (const mutation of BOX_MUTATIONS) {
      if (mutation === "env-all") continue;
      expect(flips[mutation](base), `${mutation} without the mutation`).toBe(false);
      expect(flips[mutation](turn([mutation])), `${mutation} with the mutation`).toBe(true);
    }
    // One mutation never opens another's hole.
    expect(flips["bind-data"](turn(["share-pid"]))).toBe(false);
    expect(flips["share-pid"](turn(["bind-otherws"]))).toBe(false);
    expect(flips["tmp-shared"](turn(["bind-data"]))).toBe(false);
    expect(flips["share-net"](turn(["share-pid"]))).toBe(false);
  });

  it("reads the bot and conversation off a task workspace, and absolute paths off the command line", () => {
    expect(taskWorkspaceIds(cwd, dataDir)).toEqual({ botId: "bot-a", threadId: "thread-1" });
    expect(taskWorkspaceIds("/data/projects/x", dataDir)).toBeNull();
    expect(taskWorkspaceIds(join(dataDir, "task-workspaces"), dataDir)).toBeNull();
    expect(taskWorkspaceIds(join(dataDir, "task-workspaces", "../../etc", "x"), dataDir)).toBeNull();
    expect(argvPaths(["-p", "--mcp-config", "/tmp/a/mcp.json", "--additional-mcp-config", "@/tmp/copilot/mcp.json", "--settings=/tmp/b/s.json", "/", "relative/file", "--model", "x"])).toEqual(["/tmp/a/mcp.json", "/tmp/copilot/mcp.json", "/tmp/b/s.json"]);
  });
});
