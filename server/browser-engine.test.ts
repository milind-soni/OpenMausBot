import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { credentialStoreFlags } from "./browser/egress/gate.ts";
import { browserRoot } from "./browser/chrome/profile.ts";
import { strays } from "./browser/chrome/processes.ts";
import {
  agentBrowserDevToolsPorts,
  agentBrowserIntegration,
  browserProfileDirectory,
  browserProfilesRoot,
  browserEngineEncryptionKey,
  cachedAgentBrowserVersion,
  pendingAgentBrowserVersionProbe,
  browserEngineStatus,
  describeBrowserEngine,
  browserDaemonFile,
  browserRestoreKey,
  browserSessionId,
  clearBrowserSessionState,
  closeBrowserSession,
  ensureChrome,
  inRunningBrowser,
  installAgentBrowserBinary,
  isMusl,
  isTemporaryBrowserSession,
  pinnedBinaryPath,
  prepareBrowserSessionState,
  resolveAgentBrowserBinary,
  setBrowserViewport,
} from "./browser-engine.ts";
import { AGENT_BROWSER_VERSION, agentBrowserReleaseUrl, agentBrowserReleaseVersion, resolveAgentBrowserReleaseAsset } from "./browser-engine-release.ts";
import { browserBundlePaths, browserBundleSpec, SUPPORTED_BROWSER_TARGETS } from "./browser-bundle-release.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const scratch: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

function lifecycleChild(args: readonly string[] = [], options: { code?: number; onClose?: () => void; sessions?: string[]; inventory?: string } = {}): ReturnType<typeof spawn> {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
  queueMicrotask(() => {
    if (args[0] === "session") child.stdout.emit("data", options.inventory ?? JSON.stringify({ success: true, data: { sessions: options.sessions ?? [] } }));
    else options.onClose?.();
    child.emit("exit", args[0] === "session" ? 0 : options.code ?? 0);
    child.emit("close", args[0] === "session" ? 0 : options.code ?? 0);
  });
  return child as ReturnType<typeof spawn>;
}

/** The engine over a set of running daemons: `session list` lists them, and
 * a `close` that succeeds (code 0) stops the session it was sent for. */
function runningDaemons(running: Set<string>, options: { code?: number; onClose?: () => void } = {}) {
  return ((_binary: string, args: readonly string[], spawnOptions?: { env?: NodeJS.ProcessEnv }) => lifecycleChild(args, {
    ...options, sessions: [...running],
    onClose: () => { options.onClose?.(); if (!options.code) running.delete(spawnOptions?.env?.AGENT_BROWSER_SESSION ?? ""); },
  })) as unknown as typeof spawn;
}

describe("sizing the page of a launched browser", () => {
  function viewportChild(output: string, code = 0): ReturnType<typeof spawn> {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
    queueMicrotask(() => { child.stdout.emit("data", output); child.emit("close", code); });
    return child as ReturnType<typeof spawn>;
  }
  const env = { AGENT_BROWSER_SESSION: "bot-a", AGENT_BROWSER_HEADLESS: "1", AGENT_BROWSER_RESTORE: "omb-key", PATH: "/bin" };

  it("sets the standard viewport through the session's own launch environment", async () => {
    vi.mocked(spawn).mockImplementation(() => viewportChild(JSON.stringify({ success: true, data: { width: 1280, height: 720 } })));
    expect(await setBrowserViewport("/engine", env)).toBe(true);
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("/engine");
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["set", "viewport", "1280", "720", "--json", "--no-webmcp"]);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toMatchObject(env);
  });

  it("reports failure instead of throwing", async () => {
    vi.mocked(spawn).mockImplementation(() => viewportChild(JSON.stringify({ success: false, error: "no page" })));
    expect(await setBrowserViewport("/engine", env)).toBe(false);
    vi.mocked(spawn).mockImplementation(() => viewportChild("", 1));
    expect(await setBrowserViewport("/engine", env)).toBe(false);
  });

  it("leaves an attached or headed browser alone", async () => {
    expect(await setBrowserViewport("/engine", { ...env, AGENT_BROWSER_CDP: "http://127.0.0.1:9222" })).toBe(true);
    expect(await setBrowserViewport("/engine", { ...env, AGENT_BROWSER_AUTO_CONNECT: "1" })).toBe(true);
    expect(await setBrowserViewport("/engine", { ...env, AGENT_BROWSER_HEADLESS: undefined })).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("asking a running browser", () => {
  function engine(running: string[][], answer: unknown = { success: true, data: { cdpUrl: "ws://127.0.0.1:9/devtools/browser/x" } }) {
    const home = mkdtempSync(join(tmpdir(), "omb-browser-running-"));
    scratch.push(home);
    vi.mocked(spawn).mockImplementation((_binary, args) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
      queueMicrotask(() => {
        const sessions = args[0] === "session" ? running.shift() ?? [] : null;
        child.stdout.emit("data", JSON.stringify(sessions ? { success: true, data: { sessions } } : answer));
        child.emit("close", 0);
      });
      return child as ReturnType<typeof spawn>;
    });
    return { HOME: home, USERPROFILE: home, PATH: "", AGENT_BROWSER_SESSION: "work", AGENT_BROWSER_RESTORE: "omb-key", AGENT_BROWSER_HEADLESS: "1" };
  }

  it("never launches a stopped browser just to ask it something", async () => {
    const env = engine([["other"]]);
    expect(await inRunningBrowser("/engine", env, ["get", "cdp-url"])).toBeNull();
    expect(vi.mocked(spawn).mock.calls.map((call) => call[1])).toEqual([["session", "list", "--json"]]);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).not.toHaveProperty("AGENT_BROWSER_HEADLESS");
  });

  it("asks a running one with the session's own launch environment", async () => {
    const env = engine([["work"]]);
    expect(await inRunningBrowser("/engine", env, ["get", "cdp-url"])).toEqual({ cdpUrl: "ws://127.0.0.1:9/devtools/browser/x" });
    expect(vi.mocked(spawn).mock.calls[1]?.[1]).toEqual(["get", "cdp-url", "--json", "--no-webmcp"]);
    expect(vi.mocked(spawn).mock.calls[1]?.[2]?.env).toMatchObject({ AGENT_BROWSER_SESSION: "work", AGENT_BROWSER_RESTORE: "omb-key", AGENT_BROWSER_HEADLESS: "1" });
  });

  it("treats a browser that closed while being asked as stopped, and any other failure as an error", async () => {
    expect(await inRunningBrowser("/engine", engine([["work"], []], { success: false }), ["state", "save", "/x"])).toBeNull();
    await expect(inRunningBrowser("/engine", engine([["work"], ["work"]], { success: false }), ["state", "save", "/x"])).rejects.toThrow("did not answer");
  });
});

describe("deleting one browser session's saved logins", () => {
  function fixture(closeCode = 0) {
    const home = mkdtempSync(join(tmpdir(), "omb-browser-cleanup-"));
    scratch.push(home);
    const directory = join(home, ".agent-browser", "sessions");
    mkdirSync(join(directory, ".tmp"), { recursive: true });
    const running = new Set(["work"]);
    vi.mocked(spawn).mockImplementation(runningDaemons(running, { code: closeCode }));
    return { home, directory, running, options: { env: { HOME: home, USERPROFILE: home, PATH: "" }, dataDir: home } };
  }

  it("deletes the session's kept profile with its saved state, and no other profile", async () => {
    const { home, options } = fixture();
    for (const session of ["work", "work-client"]) {
      mkdirSync(join(browserProfileDirectory(session, home), "Default"), { recursive: true });
      writeFileSync(join(browserProfileDirectory(session, home), "Default", "Cookies"), "signed in");
    }
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(true);
    expect(existsSync(browserProfileDirectory("work", home))).toBe(false);
    expect(readFileSync(join(browserProfileDirectory("work-client", home), "Default", "Cookies"), "utf8")).toBe("signed in");
  });

  it("keeps the kept profile when the browser would not close", async () => {
    const { home, options } = fixture(1);
    mkdirSync(browserProfileDirectory("work", home), { recursive: true });
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(false);
    expect(existsSync(browserProfileDirectory("work", home))).toBe(true);
  });

  it("removes only exact state/backup/candidate files and never calls state clear", async () => {
    const { directory, options } = fixture();
    const removed = ["work-work.json", "work-work.json.enc", "work-work.json.previous", "work-work.json.enc.previous", ".tmp/work-work-candidate-123.json.enc", `${browserRestoreKey("work")}-work.json.enc`, `${browserRestoreKey("work")}-work.json.enc.previous`, `.tmp/${browserRestoreKey("work")}-work-candidate-123.json.enc`];
    const preserved = ["work-client-work-client.json.enc", "personal-personal.json", "work-another.json", "notes.json", ".tmp/work-client-work-client-candidate-123.json.enc", `${browserRestoreKey("work-client")}-work-client.json.enc`];
    for (const name of [...removed, ...preserved]) writeFileSync(join(directory, name), "fixture state");
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(true);
    for (const name of removed) expect(existsSync(join(directory, name)), name).toBe(false);
    for (const name of preserved) expect(readFileSync(join(directory, name), "utf8"), name).toBe("fixture state");
    expect(vi.mocked(spawn).mock.calls.map((call) => call[1])).toEqual([["session", "list", "--json"], ["close"], ["session", "list", "--json"]]);
  });

  it("never sends close to a browser that is not running", async () => {
    const { options, running } = fixture();
    running.clear();
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(true);
    expect(vi.mocked(spawn).mock.calls.map((call) => call[1])).toEqual([["session", "list", "--json"]]);
  });

  it("cannot launch a browser from close through inherited launch flags or native user config", async () => {
    const { home, options } = fixture();
    options.env = {
      ...options.env, AGENT_BROWSER_EXECUTABLE_PATH: "/fixture/chrome", AGENT_BROWSER_NO_WEBMCP: "1",
      AGENT_BROWSER_PROFILE: "/fixture/shared", AGENT_BROWSER_CONFIG: "/fixture/unsafe-config.json",
      AGENT_BROWSER_SOCKET_DIR: "/fixture/sockets",
    } as typeof options.env;
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(true);
    expect(vi.mocked(spawn).mock.calls.map((call) => call[1])).toContainEqual(["close"]);
    for (const [, , spawned] of vi.mocked(spawn).mock.calls) {
      const env = spawned?.env;
      expect(env).not.toHaveProperty("AGENT_BROWSER_EXECUTABLE_PATH");
      expect(env).not.toHaveProperty("AGENT_BROWSER_NO_WEBMCP");
      expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
      expect(env?.AGENT_BROWSER_SOCKET_DIR).toBe("/fixture/sockets");
      expect(env?.AGENT_BROWSER_CONFIG).toBe(join(home, ".agent-browser", "omb-managed-config.json"));
      expect(readFileSync(env!.AGENT_BROWSER_CONFIG!, "utf8")).toBe("{}\n");
    }
  });

  it("preserves state when closing the daemon fails", async () => {
    const { directory, options } = fixture(1);
    const path = join(directory, "work-work.json.enc");
    writeFileSync(path, "saved login");
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("saved login");
  });

  it("waits for actual daemon disappearance after close acknowledgement", async () => {
    const { options } = fixture();
    let polls = 0;
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { sessions: args?.[0] === "session" && ++polls <= 2 ? ["work", "work-client"] : ["work-client"] }));
    expect(await closeBrowserSession("fixture-browser", { ...options.env, AGENT_BROWSER_SESSION: "work" })).toBe(true);
    expect(polls).toBe(3);
  });

  it("finishes when its daemon is gone even though a new one took the session's name", async () => {
    const { options } = fixture();
    const env = { ...options.env, AGENT_BROWSER_SESSION: "work" };
    const pidFile = browserDaemonFile(env, ".pid");
    mkdirSync(join(pidFile, ".."), { recursive: true });
    writeFileSync(pidFile, "2147483000");
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { sessions: ["work"], onClose: () => writeFileSync(pidFile, "2147483001") }));
    const started = Date.now();
    expect(await closeBrowserSession("fixture-browser", env, 10_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(readFileSync(pidFile, "utf8")).toBe("2147483001");
  });

  it("joins a close of the same browser already in flight instead of sending a second", async () => {
    const { options } = fixture();
    const env = { ...options.env, AGENT_BROWSER_SESSION: "work" };
    expect(await Promise.all([closeBrowserSession("fixture-browser", env), closeBrowserSession("fixture-browser", env)])).toEqual([true, true]);
    expect(vi.mocked(spawn).mock.calls.filter((call) => call[1]?.[0] === "close")).toHaveLength(1);
  });

  it("waits for inventory stdout to finish after the process exits", async () => {
    const { options } = fixture();
    let polls = 0;
    vi.mocked(spawn).mockImplementation((_binary, args) => {
      if (args?.[0] !== "session") return lifecycleChild(args);
      const sessions = ++polls === 1 ? ["work"] : [];
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
      queueMicrotask(() => {
        child.emit("exit", 0);
        queueMicrotask(() => {
          child.stdout.emit("data", JSON.stringify({ success: true, data: { sessions } }));
          child.emit("close", 0);
        });
      });
      return child as ReturnType<typeof spawn>;
    });
    expect(await closeBrowserSession("fixture-browser", { ...options.env, AGENT_BROWSER_SESSION: "work" })).toBe(true);
    expect(polls).toBe(2);
  });

  it.each(['not-json', '{"success":true}', '{"success":false,"data":{"sessions":[]}}'])("refuses an invalid shutdown inventory %s", async (inventory) => {
    const { options } = fixture();
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { inventory }));
    expect(await closeBrowserSession("fixture-browser", { ...options.env, AGENT_BROWSER_SESSION: "work" })).toBe(false);
  });

  it("keeps saved state when the daemon remains alive past the close deadline", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "work-work.json.enc"), "saved login");
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { sessions: ["work"] }));
    expect(await clearBrowserSessionState("fixture-browser", "work", { ...options, timeoutMs: 35 })).toBe(false);
    expect(readFileSync(join(directory, "work-work.json.enc"), "utf8")).toBe("saved login");
  });

  it("does not recursively remove a directory with a state-like name", async () => {
    const { directory, options } = fixture();
    const path = join(directory, "work-work.json");
    mkdirSync(path);
    writeFileSync(join(path, "keep"), "unrelated data");
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(false);
    expect(readFileSync(join(path, "keep"), "utf8")).toBe("unrelated data");
  });

  it("handles an already-empty session without changing other state", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "other-other.json"), "keep");
    expect(await clearBrowserSessionState("fixture-browser", "guest-123", options)).toBe(true);
    expect(readFileSync(join(directory, "other-other.json"), "utf8")).toBe("keep");
  });

  // Dotted ids are legitimate browserSessionId output; only path-shaped, glob-shaped, empty and over-long names are invalid.
  it.each(["", "../personal", "work/client", "work*", "x".repeat(97)])("rejects invalid session %j before invoking a process", async (session) => {
    const { options } = fixture();
    expect(await clearBrowserSessionState("fixture-browser", session, options)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("a browser daemon that will not close (#2603)", () => {
  it.each([
    [{ AGENT_BROWSER_SOCKET_DIR: "/s", XDG_RUNTIME_DIR: "/x", AGENT_BROWSER_NAMESPACE: "ns" }, "/s/work.pid"],
    [{ XDG_RUNTIME_DIR: "/x" }, "/x/agent-browser/work.pid"],
    [{ XDG_RUNTIME_DIR: "/x", AGENT_BROWSER_NAMESPACE: "ns" }, "/x/agent-browser/namespaces/ns/run/work.pid"],
    [{ AGENT_BROWSER_NAMESPACE: "ns" }, "/h/.agent-browser/namespaces/ns/run/work.pid"],
    [{}, "/h/.agent-browser/work.pid"],
  ])("finds the daemon's pid file where agent-browser writes it (%j)", (extra, expected) => {
    if (!posix) return;
    expect(browserDaemonFile({ HOME: "/h", USERPROFILE: "/h", AGENT_BROWSER_SESSION: "work", ...extra }, ".pid")).toBe(expected);
  });

  // A symlink to node stands in for the agent-browser binary: `ps` shows the
  // path a daemon was started through. The inventory and `close` are faked;
  // the daemon, its browser and the process listing are real.
  const groups: number[] = [];
  afterEach(() => { for (const group of groups.splice(0)) { try { process.kill(-group, "SIGKILL"); } catch {} } });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const gone = (actual: typeof import("node:child_process"), pid: number) => {
    try { return actual.execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); } catch { return true; }
  };
  // The daemon's browser leads a process group of its own, as Chrome does, with
  // a helper inside it; each writes its pid where the test can read it.
  // On USR1 it starts one more helper, as Chrome does for a new page.
  const BROWSER = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
    const helper = spawn('sleep', ['30'], { stdio: 'ignore' });
    process.on('SIGUSR1', () => { const late = spawn('sleep', ['30'], { stdio: 'ignore' }); fs.writeFileSync(process.env.HELPER_PID + '.late', String(late.pid)); });
    fs.writeFileSync(process.env.HELPER_PID, String(helper.pid)); setInterval(() => {}, 1000);`;
  const DAEMON = `const { spawn } = require('node:child_process');
    const browser = spawn(process.execPath, ['-e', ${JSON.stringify(BROWSER)}, '--', '--remote-debugging-port=0', '--user-data-dir=' + process.env.PROFILE_DIR], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(process.env.BROWSER_PID, String(browser.pid)); setInterval(() => {}, 1000);`;
  // agent-browser's daemon on TERM: it saves the session's sign-ins over its
  // browser's DevTools connection, which takes a moment, then stops that
  // browser's group itself and exits. It records whether the browser was
  // still there to save from.
  const SAVING_DAEMON = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
    const browser = spawn(process.execPath, ['-e', ${JSON.stringify(BROWSER)}, '--', '--remote-debugging-port=0', '--user-data-dir=' + process.env.PROFILE_DIR], { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.env.BROWSER_PID, String(browser.pid));
    process.on('SIGTERM', () => setTimeout(() => {
      let running = true; try { process.kill(browser.pid, 0); } catch { running = false; }
      fs.writeFileSync(process.env.BROWSER_PID + '.saved', running ? 'saved' : 'browser already gone');
      try { process.kill(-browser.pid, 'SIGKILL'); } catch {}
      process.exit(0);
    }, 200));
    setInterval(() => {}, 1000);`;
  async function engine(options: { close: (pids: { daemon: number; browser: number; helper: number }) => number | Promise<number>; via?: "symlink" | "resolved" | "unreaped"; daemon?: string }) {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const home = mkdtempSync(join(tmpdir(), "omb-browser-hung-"));
    scratch.push(home);
    const binaryPath = join(home, "agent-browser");
    symlinkSync(process.execPath, binaryPath);
    const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", AGENT_BROWSER_SESSION: "work" };
    mkdirSync(join(home, ".agent-browser"), { recursive: true });
    const files = { BROWSER_PID: join(home, "browser.pid"), HELPER_PID: join(home, "helper.pid"), PROFILE_DIR: join(home, `agent-browser-chrome-${randomUUID()}`) };
    mkdirSync(join(files.PROFILE_DIR, "Default"), { recursive: true });
    // What agent-browser hands each daemon, and its Chrome inherits.
    const daemonEnv = { ...process.env, ...files, AGENT_BROWSER_DAEMON: "1", AGENT_BROWSER_SESSION: "work" };
    let daemon: number;
    if (options.via === "unreaped") {
      // No init: the daemon's parent never collects it, so once killed it stays a zombie.
      const parent = actual.spawn("/bin/sh", ["-c", `"$0" -e "$1" & echo $! > "$2"; exec sleep 30`, binaryPath, options.daemon ?? DAEMON, join(home, "daemon.pid")], { detached: true, stdio: "ignore", env: daemonEnv });
      groups.push(parent.pid!);
      await vi.waitFor(() => expect(existsSync(join(home, "daemon.pid")) && readFileSync(join(home, "daemon.pid"), "utf8").trim()).toBeTruthy());
      daemon = Number(readFileSync(join(home, "daemon.pid"), "utf8").trim());
    } else {
      // agent-browser starts its daemon through its canonical path, which a
      // global npm install reaches through a symlink.
      const started = actual.spawn(options.via === "resolved" ? realpathSync(process.execPath) : binaryPath, ["-e", options.daemon ?? DAEMON], { detached: true, stdio: "ignore", env: daemonEnv });
      started.unref();
      daemon = started.pid!;
    }
    groups.push(daemon);
    await vi.waitFor(() => expect(existsSync(files.BROWSER_PID) && existsSync(files.HELPER_PID) && readFileSync(files.HELPER_PID, "utf8").trim()).toBeTruthy(), { timeout: 5_000 });
    const pids = { daemon, browser: Number(readFileSync(files.BROWSER_PID, "utf8")), helper: Number(readFileSync(files.HELPER_PID, "utf8")) };
    groups.push(pids.browser);
    writeFileSync(browserDaemonFile(env, ".pid"), String(daemon));
    const running = new Set(["work"]);
    vi.mocked(spawn).mockImplementation(((binary: string, args: readonly string[], spawnOptions: object) => {
      if (args[0] === "session") return lifecycleChild(args, { sessions: [...running] });
      if (args[0] !== "close") return actual.spawn(binary, args, spawnOptions);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
      void Promise.resolve(options.close(pids)).then((code) => {
        if (code === 0) running.delete("work");
        child.emit("exit", code); child.emit("close", code);
      });
      return child;
    }) as unknown as typeof spawn);
    return { actual, binaryPath, env, pids, profile: files.PROFILE_DIR, lateHelper: () => Number(readFileSync(`${files.HELPER_PID}.late`, "utf8")) };
  }

  it.skipIf(!posix)("stops the daemon and the browser under it when close fails, and removes the profile folder it would have", async () => {
    const { actual, binaryPath, env, pids, profile } = await engine({ close: () => 1 });
    expect(existsSync(profile)).toBe(true);
    expect(await closeBrowserSession(binaryPath, env, 2_000)).toBe(true);
    for (const pid of Object.values(pids)) expect(gone(actual, pid), String(pid)).toBe(true);
    expect(existsSync(profile)).toBe(false);
  });

  it.skipIf(!posix)("lets a daemon that will not close save its sign-ins from its browser before anything else is stopped", async () => {
    const { actual, binaryPath, env, pids } = await engine({ close: () => 1, daemon: SAVING_DAEMON });
    expect(await closeBrowserSession(binaryPath, env, 1_000)).toBe(true);
    expect(readFileSync(join(env.HOME, "browser.pid.saved"), "utf8")).toBe("saved");
    for (const pid of Object.values(pids)) expect(gone(actual, pid), String(pid)).toBe(true);
  });

  it.skipIf(!posix)("does not report closed while the browser it started still runs", async () => {
    const { actual, binaryPath, env, pids } = await engine({ close: ({ daemon }) => { process.kill(daemon, "SIGKILL"); return 0; } });
    expect(await closeBrowserSession(binaryPath, env, 500)).toBe(true);
    for (const pid of Object.values(pids)) expect(gone(actual, pid), String(pid)).toBe(true);
  });

  it.skipIf(!posix)("stops what the browser started after the close began, by its process group", async () => {
    let late = "";
    const { actual, binaryPath, env, pids } = await engine({ close: async ({ browser }) => {
      process.kill(browser, "SIGUSR1");
      await vi.waitFor(() => { late = readFileSync(join(env.HOME, "helper.pid.late"), "utf8"); expect(late).toBeTruthy(); });
      return 1;
    } });
    expect(await closeBrowserSession(binaryPath, env, 1_000)).toBe(true);
    for (const pid of [...Object.values(pids), Number(late)]) expect(gone(actual, pid), String(pid)).toBe(true);
  });

  it.skipIf(!posix)("returns as soon as the daemon and its browser have exited", async () => {
    const { actual, binaryPath, env, pids } = await engine({ close: ({ daemon, browser }) => { process.kill(-browser, "SIGTERM"); process.kill(daemon, "SIGTERM"); return 0; } });
    const started = Date.now();
    expect(await closeBrowserSession(binaryPath, env, 10_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    for (const pid of Object.values(pids)) expect(gone(actual, pid), String(pid)).toBe(true);
  });

  it.skipIf(!posix)("finds a daemon started through the binary's resolved path", async () => {
    const { actual, binaryPath, env, pids } = await engine({ close: () => 1, via: "resolved" });
    expect(await closeBrowserSession(binaryPath, env, 1_000)).toBe(true);
    for (const pid of Object.values(pids)) expect(gone(actual, pid), String(pid)).toBe(true);
  });

  it.skipIf(!posix)("counts a stopped daemon nothing collects as gone", async () => {
    const { actual, binaryPath, env, pids } = await engine({ close: () => 1, via: "unreaped" });
    expect(await closeBrowserSession(binaryPath, env, 1_000)).toBe(true);
    expect(alive(pids.daemon)).toBe(true); // a zombie still answers signal 0
    for (const pid of Object.values(pids)) expect(gone(actual, pid), String(pid)).toBe(true);
  });

  it.skipIf(!posix)("stops a daemon that ignores TERM in no process group of its own by its pid", async () => {
    const { actual, binaryPath, env, pids } = await engine({ close: () => 1, via: "unreaped", daemon: `process.on('SIGTERM', () => {}); ${DAEMON}` });
    expect(await closeBrowserSession(binaryPath, env, 500)).toBe(true);
    for (const pid of Object.values(pids)) expect(gone(actual, pid), String(pid)).toBe(true);
  });

  it.skipIf(!posix)("leaves alone a process the pid file names that is not this agent-browser", async () => {
    const { actual, binaryPath, env } = await engine({ close: () => 1 });
    const stranger = actual.spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(browserDaemonFile(env, ".pid"), String(stranger.pid));
      expect(await closeBrowserSession(binaryPath, env, 1_000)).toBe(false);
      expect(alive(stranger.pid!)).toBe(true);
    } finally {
      stranger.kill("SIGKILL");
    }
  });

  it.skipIf(!posix)("leaves alone another session's daemon, or an engine command, that took the pid of this one", async () => {
    const { actual, binaryPath, env } = await engine({ close: () => 1 });
    for (const taken of [{ AGENT_BROWSER_DAEMON: "1", AGENT_BROWSER_SESSION: "play" }, { AGENT_BROWSER_SESSION: "work" }]) {
      const other = actual.spawn(binaryPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, ...taken } });
      groups.push(other.pid!);
      writeFileSync(browserDaemonFile(env, ".pid"), String(other.pid));
      expect(await closeBrowserSession(binaryPath, env, 500)).toBe(false);
      expect(alive(other.pid!)).toBe(true);
    }
  });
});

describe("restoring exactly one browser profile", () => {
  function fixture() {
    const home = mkdtempSync(join(tmpdir(), "omb-browser-restore-"));
    scratch.push(home);
    const directory = join(home, ".agent-browser", "sessions");
    mkdirSync(directory, { recursive: true });
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args));
    return { directory, options: { env: { HOME: home, USERPROFILE: home } } };
  }

  it("uses fixed-length restore identities even for overlapping legacy names", () => {
    const keys = ["work", "work-client", "work-work-client", "WORK", "work_"].map(browserRestoreKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => /^omb-[a-f0-9]{64}$/.test(key))).toBe(true);
    for (const a of keys) for (const b of keys) if (a !== b) expect(b.startsWith(a + "-")).toBe(false);
  });

  it("copies only the exact legacy profile, preserves originals, and keeps launch settings stable", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "work-work.json.enc"), "work login");
    writeFileSync(join(directory, "work-client-work-client.json.enc"), "client login");
    const before = agentBrowserIntegration({ binaryPath: "fixture-browser", session: "work", encryptionKey: "key", env: options.env });
    await prepareBrowserSessionState("fixture-browser", "work", options);
    expect(readFileSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`), "utf8")).toBe("work login");
    if (posix) expect(statSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, "work-work.json.enc"), "utf8")).toBe("work login");
    expect(readFileSync(join(directory, "work-client-work-client.json.enc"), "utf8")).toBe("client login");
    expect(agentBrowserIntegration({ binaryPath: "fixture-browser", session: "work", encryptionKey: "key", env: options.env })).toEqual(before);
    expect(vi.mocked(spawn).mock.calls[0][2]?.env?.AGENT_BROWSER_RESTORE).toBe("work");
  });

  it.skipIf(!posix)("frees a kept profile a lock from another computer holds before the browser starts on it", async () => {
    const { directory, options } = fixture();
    const kept = join(directory, "..", "kept-profile");
    mkdirSync(kept, { recursive: true });
    symlinkSync("another-host.example-12345", join(kept, "SingletonLock"));
    await prepareBrowserSessionState("fixture-browser", "work", { env: { ...options.env, AGENT_BROWSER_PROFILE: kept } });
    expect(() => lstatSync(join(kept, "SingletonLock"))).toThrow();
    expect(existsSync(kept)).toBe(true);
  });

  it("never imports a prefix match when the exact legacy profile is absent", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "work-client-work-client.json.enc"), "client login");
    await prepareBrowserSessionState("fixture-browser", "work", options);
    expect(existsSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`))).toBe(false);
    expect(readFileSync(join(directory, "work-client-work-client.json.enc"), "utf8")).toBe("client login");
  });

  it("prefers the latest exact state format but never overwrites current state", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "work-work.json"), "new plain state");
    writeFileSync(join(directory, "work-work.json.enc"), "old encrypted state");
    utimesSync(join(directory, "work-work.json.enc"), 1, 1);
    await prepareBrowserSessionState("fixture-browser", "work", options);
    expect(readFileSync(join(directory, `${browserRestoreKey("work")}-work.json`), "utf8")).toBe("new plain state");
    writeFileSync(join(directory, `${browserRestoreKey("client")}-client.json.enc`), "current state");
    writeFileSync(join(directory, "client-client.json.enc"), "old state");
    await prepareBrowserSessionState("fixture-browser", "client", options);
    expect(readFileSync(join(directory, `${browserRestoreKey("client")}-client.json.enc`), "utf8")).toBe("current state");
    expect(vi.mocked(spawn).mock.calls.map((call) => call[1])).toEqual([["session", "list", "--json"]]);
  });

  it("deduplicates preparations by home and session, and skips guest persistence", async () => {
    const a = fixture();
    const b = fixture();
    await Promise.all([prepareBrowserSessionState("fixture-browser", "work", a.options), prepareBrowserSessionState("fixture-browser", "work", a.options)]);
    await prepareBrowserSessionState("fixture-browser", "work", b.options);
    await prepareBrowserSessionState("fixture-browser", "guest", { ...a.options, persistent: false });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("flushes a running legacy daemon before copying its newly saved login", async () => {
    const { directory, options } = fixture();
    vi.mocked(spawn).mockImplementation(runningDaemons(new Set(["work"]), { onClose: () => { writeFileSync(join(directory, "work-work.json.enc"), "just-flushed login"); } }));
    await prepareBrowserSessionState("fixture-browser", "work", options);
    expect(readFileSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`), "utf8")).toBe("just-flushed login");
  });

  it("refuses changed access before closing and after flushing, without resurrecting deleted state", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "work-work.json.enc"), "old login");
    await expect(prepareBrowserSessionState("fixture-browser", "work", { ...options, isCurrent: () => false })).rejects.toThrow(/access changed/);
    expect(spawn).not.toHaveBeenCalled();
    let current = true;
    vi.mocked(spawn).mockImplementation(runningDaemons(new Set(["work"]), { onClose: () => { current = false; } }));
    await expect(prepareBrowserSessionState("fixture-browser", "work", { ...options, isCurrent: () => current })).rejects.toThrow(/access changed/);
    expect(existsSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`))).toBe(false);
  });

  it("does not migrate after a failed native close and allows a later retry", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "work-work.json.enc"), "saved login");
    const running = new Set(["work"]);
    vi.mocked(spawn).mockImplementation(runningDaemons(running, { code: 1 }));
    await expect(prepareBrowserSessionState("fixture-browser", "work", options)).rejects.toThrow(/safely prepare/);
    expect(existsSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`))).toBe(false);
    vi.mocked(spawn).mockImplementation(runningDaemons(running));
    await prepareBrowserSessionState("fixture-browser", "work", options);
    expect(readFileSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`), "utf8")).toBe("saved login");
  });

  it("does not overwrite an unexpected managed config or start a browser with it", async () => {
    const { directory, options } = fixture();
    const path = join(directory, "..", "omb-managed-config.json");
    writeFileSync(path, '{"profile":"/fixture/shared"}');
    await expect(prepareBrowserSessionState("fixture-browser", "work", options)).rejects.toThrow(/configuration was changed/);
    expect(readFileSync(path, "utf8")).toBe('{"profile":"/fixture/shared"}');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("finding the browser engine", () => {
  it("pins the native-verified Windows revision in both download and desktop manifests", () => {
    const asset = resolveAgentBrowserReleaseAsset("win32", "x64")!;
    expect(asset).toEqual({
      target: "win32-x64", version: "0.36.0-omb.1",
      asset: "agent-browser-win32-x64-0.36.0-omb.1.exe",
      url: "https://github.com/milind-soni/OpenMausBot/releases/download/browser-engine-v0.36.0-omb.1/agent-browser-win32-x64-0.36.0-omb.1.exe",
      bytes: 13806080, sha256: "33bee834f6a6072ec8688b0914726e0262874d758f69f27e8baf7eaac6b5ed15",
    });
    expect(agentBrowserReleaseVersion(asset)).toBe("0.36.0-omb.1");
    expect(browserBundleSpec("win32-x64").engine).toEqual({
      version: asset.version, asset: asset.asset, url: asset.url,
      bytes: asset.bytes, sha256: asset.sha256, executable: "agent-browser.exe",
    });
    for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"], ["linux", "x64"]] as const) {
      expect(agentBrowserReleaseVersion(resolveAgentBrowserReleaseAsset(platform, arch))).toBe("0.37.0");
    }
  });

  it("does not reuse a pre-fix Windows managed install for a revised release", () => {
    const dataDir = join(tmpdir(), "omb-versioned-browser-fixture");
    const old = join(dataDir, "tools", "agent-browser", "0.36.0", "agent-browser.exe");
    const revised = pinnedBinaryPath(dataDir, "win32", "x64");
    expect(revised).toBe(join(dataDir, "tools", "agent-browser", "0.36.0-omb.1", "agent-browser.exe"));
    const files = new Set([old]);
    const options = { dataDir, platform: "win32" as const, arch: "x64", env: { PATH: "" }, exists: (file: string) => files.has(file) };
    expect(resolveAgentBrowserBinary(options)).toBeNull();
    files.add(revised);
    expect(browserEngineStatus(options)).toMatchObject({ kind: "ready", binaryPath: revised, version: "0.36.0-omb.1" });
    expect(resolveAgentBrowserBinary({ ...options, env: { PATH: "", OMB_AGENT_BROWSER_PATH: old } })).toBe(old);
  });

  it("retains default upstream versions and permits a pinned platform-specific asset URL", () => {
    const official = resolveAgentBrowserReleaseAsset("linux", "x64")!;
    expect(agentBrowserReleaseVersion(official)).toBe(AGENT_BROWSER_VERSION);
    const revised = { ...official, version: "0.36.0-omb.1", url: "https://example.invalid/releases/download/fixed/fixture.exe" };
    expect(agentBrowserReleaseVersion(revised)).toBe("0.36.0-omb.1");
    expect(agentBrowserReleaseUrl(revised)).toBe(revised.url);
  });

  it.each(SUPPORTED_BROWSER_TARGETS)("uses the complete %s desktop bundle before old downloaded engines", (target) => {
    const [platform, arch] = target.split("-");
    const env = { OMB_RESOURCES_PATH: join(tmpdir(), "OMB resources"), PATH: "" };
    const bundle = browserBundlePaths(join(env.OMB_RESOURCES_PATH, "browser-engine"), target);
    const files = new Set([bundle.directory, bundle.engine, bundle.chrome, bundle.manifest, bundle.licenses]);
    const options = { env, platform: platform as NodeJS.Platform, arch, exists: (p: string) => files.has(p) };
    expect(resolveAgentBrowserBinary(options)).toBe(bundle.engine);
    expect(browserEngineStatus(options)).toMatchObject({ kind: "ready", binaryPath: bundle.engine });
    files.delete(bundle.chrome);
    expect(resolveAgentBrowserBinary(options)).toBeNull();
    expect(browserEngineStatus(options)).toMatchObject({ kind: "unavailable", installable: false, reason: expect.stringContaining("Reinstall") });
    files.add(bundle.chrome);
    files.delete(bundle.licenses);
    expect(resolveAgentBrowserBinary(options)).toBeNull();
    files.add(bundle.licenses);
    files.delete(bundle.manifest);
    expect(resolveAgentBrowserBinary(options)).toBeNull();
    const external = join(tmpdir(), "external-engine");
    files.add(external);
    expect(resolveAgentBrowserBinary({ ...options, env: { ...env, OMB_AGENT_BROWSER_PATH: external } })).toBe(external);
  });

  it("mounts the bundled browser with no download and keeps explicit Chrome overrides", async () => {
    const resources = mkdtempSync(join(tmpdir(), "omb-browser-resources-"));
    scratch.push(resources);
    const host = { platform: "linux" as const, arch: "x64" };
    const env = { OMB_RESOURCES_PATH: resources, PATH: "" };
    const bundle = browserBundlePaths(join(resources, "browser-engine"), "linux-x64");
    mkdirSync(bundle.licenses, { recursive: true });
    for (const file of [bundle.engine, bundle.chrome, bundle.manifest]) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "fixture, not executable");
    }
    expect(browserEngineStatus({ env, ...host })).toMatchObject({ kind: "ready", binaryPath: bundle.engine });
    const spec = agentBrowserIntegration({ binaryPath: bundle.engine, session: "isolated", encryptionKey: "key", env, ...host });
    expect(spec.env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(bundle.chrome);
    expect(spec.env.AGENT_BROWSER_SESSION).toBe("isolated");
    expect(spec.env.AGENT_BROWSER_NO_WEBMCP).toBe("1");
    expect(spec.env).not.toHaveProperty("OMB_RESOURCES_PATH");
    const override = agentBrowserIntegration({ binaryPath: bundle.engine, session: "isolated", encryptionKey: "key", env: { ...env, AGENT_BROWSER_EXECUTABLE_PATH: "/explicit/chrome" }, ...host });
    expect(override.env.AGENT_BROWSER_EXECUTABLE_PATH).toBe("/explicit/chrome");
    // A spawn would fail because the fixture engine is not executable.
    await expect(ensureChrome(bundle.engine, { env, ...host })).resolves.toBeUndefined();
  });

  it("prefers the explicit path, then the pinned download, then PATH, and reports why when nothing is there", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-"));
    scratch.push(dataDir);
    const pinned = pinnedBinaryPath(dataDir);
    const name = process.platform === "win32" ? "agent-browser.exe" : "agent-browser";
    const pathDir = join(dataDir, "bin");
    const pathBinary = join(pathDir, name);
    const override = join(dataDir, "override", name);
    const files = new Set<string>();
    const exists = (p: string) => files.has(p);
    const env = { PATH: [join(dataDir, "empty"), pathDir].join(delimiter) };

    expect(resolveAgentBrowserBinary({ dataDir, env, exists })).toBeNull();
    expect(browserEngineStatus({ dataDir, env, exists })).toMatchObject({ kind: "unavailable", installable: true });

    files.add(pathBinary);
    expect(resolveAgentBrowserBinary({ dataDir, env, exists })).toBe(pathBinary);
    files.add(pinned);
    expect(resolveAgentBrowserBinary({ dataDir, env, exists })).toBe(pinned);
    files.add(override);
    expect(resolveAgentBrowserBinary({ dataDir, env: { ...env, OMB_AGENT_BROWSER_PATH: override }, exists })).toBe(override);
    expect(resolveAgentBrowserBinary({ dataDir, env: { ...env, OMB_AGENT_BROWSER_PATH: join(dataDir, "missing", name) }, exists })).toBeNull();
    expect(browserEngineStatus({ dataDir, env, exists })).toMatchObject({ kind: "ready", binaryPath: pinned, version: agentBrowserReleaseVersion(resolveAgentBrowserReleaseAsset()), managed: true });
    expect(browserEngineStatus({ dataDir, env: { ...env, OMB_AGENT_BROWSER_PATH: override }, exists, versionOf: () => AGENT_BROWSER_VERSION })).toMatchObject({ kind: "ready", binaryPath: override, managed: false });
    files.delete(pinned);
    expect(browserEngineStatus({ dataDir, env, exists, versionOf: () => AGENT_BROWSER_VERSION })).toMatchObject({ kind: "ready", binaryPath: pathBinary, managed: false });
  });

  it("hands agent-browser the Chrome OMB prepared instead of the bundled shell, never when it attaches to the person's Chrome", () => {
    const resources = mkdtempSync(join(tmpdir(), "omb-browser-resources-"));
    scratch.push(resources);
    const host = { platform: "darwin" as const, arch: "arm64" };
    const env = { OMB_RESOURCES_PATH: resources, PATH: "" };
    const bundle = browserBundlePaths(join(resources, "browser-engine"), "darwin-arm64");
    mkdirSync(bundle.licenses, { recursive: true });
    for (const file of [bundle.engine, bundle.chrome, bundle.manifest]) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "fixture");
    }
    expect(browserEngineStatus({ env, ...host })).toMatchObject({ kind: "ready", binaryPath: bundle.engine, managed: true });
    const launcher = { AGENT_BROWSER_EXECUTABLE_PATH: "/data/browser/chrome-launcher.sh", AGENT_BROWSER_HIDE_SCROLLBARS: "0" };
    const spec = agentBrowserIntegration({ binaryPath: bundle.engine, session: "bot-1", encryptionKey: "key", env, launcher, ...host });
    expect(spec.env).toMatchObject(launcher);
    expect(agentBrowserIntegration({ binaryPath: bundle.engine, session: "bot-1", encryptionKey: "key", env, launcher: {}, ...host }).env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(bundle.chrome);
    const mine = agentBrowserIntegration({ binaryPath: bundle.engine, session: "mine", encryptionKey: "key", env, launcher, attach: {}, ...host });
    expect(mine.env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(bundle.chrome);
    expect(mine.env).not.toHaveProperty("AGENT_BROWSER_HIDE_SCROLLBARS");
  });

  it("names the browser the engine starts in its status line", () => {
    const ready = { kind: "ready" as const, binaryPath: "/e/agent-browser", version: AGENT_BROWSER_VERSION, managed: true };
    expect(describeBrowserEngine(ready, "Google Chrome 153 (installed)")).toBe(`browser engine: agent-browser ${AGENT_BROWSER_VERSION} at /e/agent-browser; browser: Google Chrome 153 (installed)`);
    expect(describeBrowserEngine(ready)).toBe(`browser engine: agent-browser ${AGENT_BROWSER_VERSION} at /e/agent-browser`);
  });

  it("reports an unmanaged agent-browser's real version and warns when it is not the pin", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-unmanaged-"));
    scratch.push(dataDir);
    const name = process.platform === "win32" ? "agent-browser.exe" : "agent-browser";
    const binary = resolve(join(dataDir, "bin"), name);
    const exists = (file: string) => file === binary;
    const env = { PATH: join(dataDir, "bin") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mismatched = browserEngineStatus({ dataDir, env, exists, versionOf: () => "0.38.1" });
      expect(mismatched).toMatchObject({
        kind: "ready",
        binaryPath: binary,
        version: "0.38.1",
        warning: expect.stringContaining(AGENT_BROWSER_VERSION),
      });
      expect(describeBrowserEngine(mismatched)).toContain("0.38.1");
      expect(describeBrowserEngine(mismatched)).toContain(AGENT_BROWSER_VERSION);
      expect(warn).toHaveBeenCalledOnce();
      warn.mockClear();
      const matched = browserEngineStatus({ dataDir, env, exists, versionOf: () => AGENT_BROWSER_VERSION });
      expect(matched).toEqual({ kind: "ready", binaryPath: binary, version: AGENT_BROWSER_VERSION, managed: false });
      expect(warn).not.toHaveBeenCalled();
      const unknown = browserEngineStatus({ dataDir, env, exists, versionOf: () => null });
      expect(unknown).toMatchObject({ kind: "ready", version: "unknown", warning: expect.stringContaining("unknown") });
      warn.mockClear();
      const probing = browserEngineStatus({ dataDir, env, exists, versionOf: () => undefined });
      expect(probing).toEqual({ kind: "ready", binaryPath: binary, version: "unknown", managed: false });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("probes an unmanaged binary's version in the background, once per mtime, without blocking on a stalled binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-engine-probe-"));
    scratch.push(dir);
    const binary = join(dir, "agent-browser");
    writeFileSync(binary, "fixture");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let answer: ((output: string) => void) | undefined;
      const run = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
      const started = Date.now();
      expect(cachedAgentBrowserVersion(binary, run)).toBeUndefined();
      expect(cachedAgentBrowserVersion(binary, run)).toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeLessThan(500);

      answer!("agent-browser 0.38.1\n");
      await expect(pendingAgentBrowserVersionProbe(binary)).resolves.toBe("0.38.1");
      expect(cachedAgentBrowserVersion(binary, run)).toBe("0.38.1");
      expect(run).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("0.38.1"));

      utimesSync(binary, new Date(), new Date(Date.now() + 5_000));
      const failing = vi.fn(async () => { throw new Error("timed out"); });
      expect(cachedAgentBrowserVersion(binary, failing)).toBeUndefined();
      await expect(pendingAgentBrowserVersionProbe(binary)).resolves.toBeNull();
      expect(cachedAgentBrowserVersion(binary, failing)).toBeNull();
      expect(failing).toHaveBeenCalledTimes(1);

      expect(cachedAgentBrowserVersion(join(dir, "missing"), run)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("knows every target Vercel publishes, and picks the musl build on Alpine", () => {
    for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]] as const) {
      const asset = resolveAgentBrowserReleaseAsset(platform, arch);
      expect(asset, `${platform}-${arch}`).not.toBeNull();
      expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/u);
      if (asset?.url) expect(agentBrowserReleaseUrl(asset)).toBe(asset.url);
      else expect(agentBrowserReleaseUrl(asset!)).toContain(`/v${AGENT_BROWSER_VERSION}/`);
    }
    expect(resolveAgentBrowserReleaseAsset("linux", "x64", true)?.target).toBe("linux-musl-x64");
    expect(resolveAgentBrowserReleaseAsset("freebsd", "x64")).toBeNull();
    expect(isMusl("linux", (p) => p === "/lib/ld-musl-x86_64.so.1")).toBe(true);
    expect(isMusl("linux", () => false)).toBe(false);
    expect(isMusl("darwin", () => true)).toBe(false);
  });
});

describe("installing the browser engine", () => {
  it("downloads the pinned asset, verifies size and digest, and only then names the file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-install-"));
    scratch.push(dataDir);
    const body = Buffer.from("#!/bin/sh\necho agent-browser\n");
    const asset = { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
    const fetched: string[] = [];
    const installed = await installAgentBrowserBinary({
      dataDir,
      platform: "linux",
      asset,
      fetchImpl: async (input) => {
        fetched.push(String(input));
        return new Response(body);
      },
    });
    expect(installed).toBe(pinnedBinaryPath(dataDir, "linux"));
    expect(fetched[0]).toBe(agentBrowserReleaseUrl(asset));
    expect(readFileSync(installed, "utf8")).toContain("agent-browser");
    if (posix) expect(statSync(installed).mode & 0o111).not.toBe(0);
  });

  it("refuses a download whose bytes do not match the pin, and leaves nothing behind", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-bad-"));
    scratch.push(dataDir);
    const asset = { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "a".repeat(64), bytes: 5 };
    await expect(installAgentBrowserBinary({ dataDir, platform: "linux", asset, fetchImpl: async () => new Response(Buffer.from("hello")) })).rejects.toThrow(/SHA-256/u);
    await expect(installAgentBrowserBinary({ dataDir, platform: "linux", asset, fetchImpl: async () => new Response(Buffer.from("hi")) })).rejects.toThrow(/pinned size/u);
    expect(() => statSync(pinnedBinaryPath(dataDir, "linux"))).toThrow();
  });
});

describe("what a bot gets", () => {
  // Without a gate the browser connects nowhere: Chrome fails every connection through port 0.
  const gateArgs = ["--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", ...credentialStoreFlags()];
  const cacheArg = `--disk-cache-size=${64 * 1024 * 1024}`;
  /** A saved session's browser: its own kept profile, behind no gate. */
  const keptNoGate = (session: string) => ({
    AGENT_BROWSER_PROXY: "socks5://127.0.0.1:0", AGENT_BROWSER_PROXY_BYPASS: "<-loopback>",
    AGENT_BROWSER_PROFILE: browserProfileDirectory(session), AGENT_BROWSER_ARGS: [cacheArg, ...gateArgs].join("\n"),
  });

  it("gives each saved session a profile of its own that outlives Chrome, and a temporary or My Chrome browser none", () => {
    const dataDir = join(tmpdir(), "omb-profile-fixture");
    const kept = (session: string, extra: Partial<Parameters<typeof agentBrowserIntegration>[0]> = {}) =>
      agentBrowserIntegration({ binaryPath: "/x", session, encryptionKey: "k", env: {}, dataDir, ...extra }).env;
    const work = kept("bot-1").AGENT_BROWSER_PROFILE!;
    expect(work).toBe(browserProfileDirectory("bot-1", dataDir));
    expect(resolve(work, "..")).toBe(browserProfilesRoot(dataDir));
    expect(kept("bot-1").AGENT_BROWSER_PROFILE).toBe(work);
    expect(kept("bot-2").AGENT_BROWSER_PROFILE).not.toBe(work);
    expect(kept("bot-1").AGENT_BROWSER_ARGS!.split("\n")).toContain(cacheArg);
    for (const env of [kept("guest-1", { persistent: false }), kept("work", { attach: {} })]) {
      expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
      expect(env.AGENT_BROWSER_ARGS ?? "").not.toContain(cacheArg);
    }
    expect(() => browserProfileDirectory("../escape", dataDir)).toThrow();
  });

  it("keeps a saved session's profile out of the new engine's folder, whose sweep stops every Chrome there it did not start", () => {
    const dataDir = join(tmpdir(), "omb-profile-fixture");
    const chrome = { pid: 4242, ppid: 4241, startTime: null, args: `/opt/chrome --remote-debugging-port=0 --user-data-dir=${browserProfileDirectory("bot-1", dataDir)} about:blank` };
    expect(strays({ processes: [chrome], registered: [], root: browserRoot(dataDir), alive: () => true })).toEqual([]);
  });

  it("counts a saved session's own Chrome among the DevTools ports no page may reach", () => {
    const temp = mkdtempSync(join(tmpdir(), "omb-devtools-"));
    scratch.push(temp);
    const profiles = join(temp, "profiles");
    mkdirSync(join(temp, "agent-browser-chrome-1"), { recursive: true });
    writeFileSync(join(temp, "agent-browser-chrome-1", "DevToolsActivePort"), "41001\n/devtools/browser/a");
    mkdirSync(join(profiles, "0123abcd"), { recursive: true });
    writeFileSync(join(profiles, "0123abcd", "DevToolsActivePort"), "41002\n/devtools/browser/b");
    expect(agentBrowserDevToolsPorts(temp, profiles).sort()).toEqual([41001, 41002]);
  });

  it("launches Chrome only behind its egress gate, off the person's keychain, and never for the person's own Chrome", () => {
    const gated = agentBrowserIntegration({ binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "k", env: { PATH: "/usr/bin" }, egressPort: 45123, platform: "darwin" });
    expect(gated.env).toMatchObject({ AGENT_BROWSER_PROXY: "socks5://127.0.0.1:45123", AGENT_BROWSER_PROXY_BYPASS: "<-loopback>" });
    expect(gated.env.AGENT_BROWSER_ARGS!.split("\n")).toEqual([cacheArg, "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--use-mock-keychain"]);
    expect(agentBrowserIntegration({ binaryPath: "/x", session: "bot-1", encryptionKey: "k", env: {}, egressPort: 45123, platform: "linux" }).env.AGENT_BROWSER_ARGS).toContain("--password-store=basic");
    expect(agentBrowserIntegration({ binaryPath: "/x", session: "bot-1", encryptionKey: "k", env: {} }).env.AGENT_BROWSER_PROXY).toBe("socks5://127.0.0.1:0");
    const mine = agentBrowserIntegration({ binaryPath: "/x", session: "work", encryptionKey: "k", env: {}, attach: {}, egressPort: 45123 });
    for (const key of ["AGENT_BROWSER_PROXY", "AGENT_BROWSER_PROXY_BYPASS", "AGENT_BROWSER_ARGS"]) expect(mine.env).not.toHaveProperty(key);
  });

  it("keeps the prepared Chrome launcher and the gate together, and no launcher setting routes Chrome around the gate", () => {
    const launcher = { AGENT_BROWSER_EXECUTABLE_PATH: "/d/chrome-launcher.sh", AGENT_BROWSER_HIDE_SCROLLBARS: "0" };
    const gate = { AGENT_BROWSER_PROXY: "socks5://127.0.0.1:45123", AGENT_BROWSER_PROXY_BYPASS: "<-loopback>" };
    const spec = agentBrowserIntegration({ binaryPath: "/x", session: "bot-1", encryptionKey: "k", env: {}, launcher, egressPort: 45123, platform: "darwin" });
    expect(spec.env).toMatchObject({ ...launcher, ...gate });
    const pushy = agentBrowserIntegration({
      binaryPath: "/x", session: "bot-1", encryptionKey: "k", env: {}, egressPort: 45123, platform: "darwin",
      launcher: { ...launcher, AGENT_BROWSER_PROXY: "direct://", AGENT_BROWSER_PROXY_BYPASS: "*", AGENT_BROWSER_ARGS: "--lang=en-IN" },
    });
    expect(pushy.env).toMatchObject({ AGENT_BROWSER_EXECUTABLE_PATH: "/d/chrome-launcher.sh", ...gate });
    expect(pushy.env.AGENT_BROWSER_ARGS!.split("\n")).toEqual(["--lang=en-IN", cacheArg, "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--use-mock-keychain"]);
  });

  it("forwards the explicit Chrome path without copying arbitrary environment or overriding session isolation", () => {
    vi.stubEnv("AGENT_BROWSER_EXECUTABLE_PATH", "/process/chrome");
    const spec = agentBrowserIntegration({
      binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "session-key",
      env: {
        PATH: "/usr/bin", AGENT_BROWSER_EXECUTABLE_PATH: "/opt/trusted chrome/chrome",
        PRIVATE_WORKSPACE_SECRET: "synthetic-secret",
        AGENT_BROWSER_SESSION: "wrong-session", AGENT_BROWSER_ENCRYPTION_KEY: "wrong-key",
        AGENT_BROWSER_ARGS: "--no-sandbox", AGENT_BROWSER_NO_WEBMCP: "0",
        AGENT_BROWSER_CONFIG: "/unsafe-native-config.json", AGENT_BROWSER_PROFILE: "/unsafe-shared-profile",
      },
    });
    expect(spec.env).toEqual({
      AGENT_BROWSER_SESSION: "bot-1", AGENT_BROWSER_NO_WEBMCP: "1", AGENT_BROWSER_RESTORE: browserRestoreKey("bot-1"),
      AGENT_BROWSER_RESTORE_SAVE: "auto", AGENT_BROWSER_ENCRYPTION_KEY: "session-key",
      AGENT_BROWSER_CONFIG: expect.stringContaining("omb-managed-config.json"),
      AGENT_BROWSER_HEADLESS: "1", AGENT_BROWSER_HEADED: "0", PATH: "/usr/bin",
      AGENT_BROWSER_EXECUTABLE_PATH: "/opt/trusted chrome/chrome", ...keptNoGate("bot-1"),
    });
  });

  it("reads the configured Chrome path from the process only when no explicit environment is supplied", () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("AGENT_BROWSER_EXECUTABLE_PATH", "/opt/process-chrome/chrome");
    vi.stubEnv("PRIVATE_WORKSPACE_SECRET", "synthetic-process-secret");
    const spec = agentBrowserIntegration({ binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "session-key" });
    expect(spec.env).toEqual({
      AGENT_BROWSER_SESSION: "bot-1", AGENT_BROWSER_NO_WEBMCP: "1", AGENT_BROWSER_RESTORE: browserRestoreKey("bot-1"),
      AGENT_BROWSER_RESTORE_SAVE: "auto", AGENT_BROWSER_ENCRYPTION_KEY: "session-key",
      AGENT_BROWSER_CONFIG: expect.stringContaining("omb-managed-config.json"),
      AGENT_BROWSER_HEADLESS: "1", AGENT_BROWSER_HEADED: "0", PATH: "/usr/bin",
      AGENT_BROWSER_EXECUTABLE_PATH: "/opt/process-chrome/chrome", ...keptNoGate("bot-1"),
    });
    for (const env of [{}, { AGENT_BROWSER_EXECUTABLE_PATH: "" }]) {
      const explicit = agentBrowserIntegration({ binaryPath: "/x", session: "s", encryptionKey: "k", env });
      expect(explicit.env.AGENT_BROWSER_EXECUTABLE_PATH).toBeUndefined();
      expect(explicit.env.PRIVATE_WORKSPACE_SECRET).toBeUndefined();
    }
  });

  it("attaches to Chrome only when the caller passes attach explicitly, never from the ambient process environment", () => {
    const withoutAttach = agentBrowserIntegration({ binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "session-key", env: { PATH: "/usr/bin" } });
    expect(withoutAttach.env).not.toHaveProperty("AGENT_BROWSER_CDP");
    expect(withoutAttach.env).not.toHaveProperty("AGENT_BROWSER_AUTO_CONNECT");
    const ambientAttempt = agentBrowserIntegration({
      binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "session-key",
      env: { PATH: "/usr/bin", AGENT_BROWSER_CDP: "https://unrelated-browser.invalid", AGENT_BROWSER_AUTO_CONNECT: "1" },
    });
    expect(ambientAttempt.env).not.toHaveProperty("AGENT_BROWSER_CDP");
    expect(ambientAttempt.env).not.toHaveProperty("AGENT_BROWSER_AUTO_CONNECT");
    const attached = agentBrowserIntegration({
      binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "session-key",
      env: { PATH: "/usr/bin" }, attach: { cdpUrl: "http://127.0.0.1:9333" },
    });
    expect(attached.env.AGENT_BROWSER_CDP).toBe("http://127.0.0.1:9333");
    expect(attached.env).not.toHaveProperty("AGENT_BROWSER_AUTO_CONNECT");
  });

  it("My Chrome finds the person's running Chrome, and never restores into it or saves its cookies", () => {
    const spec = agentBrowserIntegration({ binaryPath: "/x/agent-browser", session: "work", encryptionKey: "session-key", env: { PATH: "/usr/bin" }, attach: {} });
    expect(spec.args).toEqual(["mcp", "--tools", "core", "--no-webmcp"]);
    expect(spec.env).toMatchObject({ AGENT_BROWSER_SESSION: "work", AGENT_BROWSER_AUTO_CONNECT: "1", AGENT_BROWSER_RESTORE_SAVE: "never", AGENT_BROWSER_NO_WEBMCP: "1" });
    for (const name of ["AGENT_BROWSER_RESTORE", "AGENT_BROWSER_CDP", "AGENT_BROWSER_HEADLESS", "AGENT_BROWSER_HEADED"]) expect(spec.env).not.toHaveProperty(name);
    expect(agentBrowserIntegration({ binaryPath: "/x/agent-browser", session: "work", encryptionKey: "session-key", env: { PATH: "/usr/bin" } }).env)
      .toMatchObject({ AGENT_BROWSER_RESTORE: browserRestoreKey("work"), AGENT_BROWSER_RESTORE_SAVE: "auto", AGENT_BROWSER_HEADLESS: "1" });
  });

  it("mounts agent-browser's MCP server with the core tools, an isolated auto-restored session, and WebMCP off", () => {
    const spec = agentBrowserIntegration({ binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "k".repeat(64), env: { PATH: "/usr/bin" } });
    expect(spec.command).toBe("/x/agent-browser");
    expect(spec.args).toEqual(["mcp", "--tools", "core", "--no-webmcp"]);
    expect(spec.env).toMatchObject({ AGENT_BROWSER_SESSION: "bot-1", AGENT_BROWSER_RESTORE: browserRestoreKey("bot-1"), AGENT_BROWSER_RESTORE_SAVE: "auto", AGENT_BROWSER_HEADLESS: "1", AGENT_BROWSER_HEADED: "0", PATH: "/usr/bin" });
    expect(spec.env.AGENT_BROWSER_ENCRYPTION_KEY).toBe("k".repeat(64));
    expect(agentBrowserIntegration({ binaryPath: "/x", session: "s", encryptionKey: "k", headless: false, platform: "darwin" }).env.AGENT_BROWSER_HEADLESS).toBeUndefined();
  });

  it("pins headless on a displayless Linux host, even for a headed-capable caller (#1383)", () => {
    const linux = { binaryPath: "/x/agent-browser", session: "s", encryptionKey: "k", platform: "linux" as const, env: { PATH: "/usr/bin" } };
    expect(agentBrowserIntegration(linux).env).toMatchObject({ AGENT_BROWSER_HEADLESS: "1", AGENT_BROWSER_HEADED: "0" });
    expect(agentBrowserIntegration({ ...linux, headless: false }).env).toMatchObject({ AGENT_BROWSER_HEADLESS: "1", AGENT_BROWSER_HEADED: "0" });
    expect(agentBrowserIntegration({ ...linux, headless: false, env: { PATH: "/usr/bin", DISPLAY: ":0" } }).env.AGENT_BROWSER_HEADED).toBeUndefined();
    expect(agentBrowserIntegration({ ...linux, headless: false, env: { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0" } }).env.AGENT_BROWSER_HEADED).toBeUndefined();
    expect(agentBrowserIntegration({ ...linux, platform: "darwin", headless: false }).env.AGENT_BROWSER_HEADED).toBeUndefined();
  });

  it("keeps saved state separate for different bots and never saves guest state", () => {
    const spec = (session: string, persistent = true) => agentBrowserIntegration({ binaryPath: "/x", session, encryptionKey: "k", persistent });
    expect(spec("bot-a").env.AGENT_BROWSER_RESTORE).not.toBe(spec("bot-b").env.AGENT_BROWSER_RESTORE);
    const first = browserSessionId("bot-a", "guest");
    const second = browserSessionId("bot-a", "guest");
    expect(first).toMatch(/^guest-[a-f0-9-]+$/u);
    expect(first).not.toBe(second);
    expect(spec(first, false).env).toMatchObject({ AGENT_BROWSER_RESTORE: browserRestoreKey(first), AGENT_BROWSER_RESTORE_SAVE: "never" });
  });

  it("names a temporary browser after its data dir, so one a crash left behind is still recognisably its own", () => {
    const session = browserSessionId("bot-a", "guest", "/data/one");
    expect(session).toMatch(/^guest-[a-f0-9]{8}-[a-f0-9]{16}$/u);
    expect(isTemporaryBrowserSession(session, "/data/one")).toBe(true);
    expect(isTemporaryBrowserSession(session, "/data/two")).toBe(false);
    expect(isTemporaryBrowserSession(browserSessionId("bot-a", "", "/data/one"), "/data/one")).toBe(false);
    // No longer than the uuid form it replaced: agent-browser's socket path is capped.
    expect(session.length).toBeLessThanOrEqual(42);
  });

  it("names sessions after the shared profile, else the bot, in shell-safe form", () => {
    expect(browserSessionId("bot-a", "")).toBe("bot-bot-a");
    expect(browserSessionId("bot-a", "work partition/1")).toBe("work_partition_1");
    expect(browserSessionId("b", "x".repeat(200))).toHaveLength(96);
  });

  it("makes one encryption key per data dir, private, and reuses it", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-engine-key-"));
    scratch.push(dataDir);
    const key = browserEngineEncryptionKey(dataDir);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(browserEngineEncryptionKey(dataDir)).toBe(key);
    if (posix) expect(statSync(join(dataDir, "browser-engine-key")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dataDir, "browser-engine-key"), "garbage\n");
    const fresh = browserEngineEncryptionKey(dataDir);
    expect(fresh).toMatch(/^[0-9a-f]{64}$/u);
    expect(fresh).not.toBe(key);
    mkdirSync(join(dataDir, "unused"));
  });
});
