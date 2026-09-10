import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentBrowserFrame,
  agentBrowserIntegration,
  browserEngineEncryptionKey,
  browserEngineStatus,
  browserRestoreKey,
  browserSessionId,
  clearBrowserSessionState,
  closeBrowserSession,
  ensureChrome,
  installAgentBrowserBinary,
  isMusl,
  pinnedBinaryPath,
  prepareBrowserSessionState,
  resolveAgentBrowserBinary,
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

describe("deleting one browser session's saved logins", () => {
  function fixture(closeCode = 0) {
    const home = mkdtempSync(join(tmpdir(), "omb-browser-cleanup-"));
    scratch.push(home);
    const directory = join(home, ".agent-browser", "sessions");
    mkdirSync(join(directory, ".tmp"), { recursive: true });
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { code: closeCode }));
    return { home, directory, options: { env: { HOME: home, USERPROFILE: home, PATH: "" } } };
  }

  it("removes only exact state/backup/candidate files and never calls state clear", async () => {
    const { directory, options } = fixture();
    const removed = ["work-work.json", "work-work.json.enc", "work-work.json.previous", "work-work.json.enc.previous", ".tmp/work-work-candidate-123.json.enc", `${browserRestoreKey("work")}-work.json.enc`, `${browserRestoreKey("work")}-work.json.enc.previous`, `.tmp/${browserRestoreKey("work")}-work-candidate-123.json.enc`];
    const preserved = ["work-client-work-client.json.enc", "personal-personal.json", "work-another.json", "notes.json", ".tmp/work-client-work-client-candidate-123.json.enc", `${browserRestoreKey("work-client")}-work-client.json.enc`];
    for (const name of [...removed, ...preserved]) writeFileSync(join(directory, name), "fixture state");
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(true);
    for (const name of removed) expect(existsSync(join(directory, name)), name).toBe(false);
    for (const name of preserved) expect(readFileSync(join(directory, name), "utf8"), name).toBe("fixture state");
    expect(vi.mocked(spawn).mock.calls.map((call) => call[1])).toEqual([["close"], ["session", "list", "--json"]]);
  });

  it("cannot launch a browser from close through inherited launch flags or native user config", async () => {
    const { home, options } = fixture();
    options.env = {
      ...options.env, AGENT_BROWSER_EXECUTABLE_PATH: "/fixture/chrome", AGENT_BROWSER_NO_WEBMCP: "1",
      AGENT_BROWSER_PROFILE: "/fixture/shared", AGENT_BROWSER_CONFIG: "/fixture/unsafe-config.json",
      AGENT_BROWSER_SOCKET_DIR: "/fixture/sockets",
    } as typeof options.env;
    expect(await clearBrowserSessionState("fixture-browser", "work", options)).toBe(true);
    const env = vi.mocked(spawn).mock.calls[0][2]?.env;
    expect(env).not.toHaveProperty("AGENT_BROWSER_EXECUTABLE_PATH");
    expect(env).not.toHaveProperty("AGENT_BROWSER_NO_WEBMCP");
    expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(env?.AGENT_BROWSER_SOCKET_DIR).toBe("/fixture/sockets");
    expect(env?.AGENT_BROWSER_CONFIG).toBe(join(home, ".agent-browser", "omb-managed-config.json"));
    expect(readFileSync(env!.AGENT_BROWSER_CONFIG!, "utf8")).toBe("{}\n");
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
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { sessions: args?.[0] === "session" && ++polls === 1 ? ["work", "work-client"] : ["work-client"] }));
    expect(await closeBrowserSession("fixture-browser", { ...options.env, AGENT_BROWSER_SESSION: "work" })).toBe(true);
    expect(polls).toBe(2);
  });

  it("waits for inventory stdout to finish after the process exits", async () => {
    const { options } = fixture();
    vi.mocked(spawn).mockImplementation((_binary, args) => {
      if (args?.[0] !== "session") return lifecycleChild(args);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
      queueMicrotask(() => {
        child.emit("exit", 0);
        queueMicrotask(() => {
          child.stdout.emit("data", '{"success":true,"data":{"sessions":[]}}');
          child.emit("close", 0);
        });
      });
      return child as ReturnType<typeof spawn>;
    });
    expect(await closeBrowserSession("fixture-browser", { ...options.env, AGENT_BROWSER_SESSION: "work" })).toBe(true);
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

  it.each(["", "../personal", "work/client", "work.client", "work*", "x".repeat(97)])("rejects invalid session %j before invoking a process", async (session) => {
    const { options } = fixture();
    expect(await clearBrowserSessionState("fixture-browser", session, options)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
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
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates preparations by home and session, and skips guest persistence", async () => {
    const a = fixture();
    const b = fixture();
    await Promise.all([prepareBrowserSessionState("fixture-browser", "work", a.options), prepareBrowserSessionState("fixture-browser", "work", a.options)]);
    await prepareBrowserSessionState("fixture-browser", "work", b.options);
    await prepareBrowserSessionState("fixture-browser", "guest", { ...a.options, persistent: false });
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it("flushes a running legacy daemon before copying its newly saved login", async () => {
    const { directory, options } = fixture();
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { onClose: () => { writeFileSync(join(directory, "work-work.json.enc"), "just-flushed login"); } }));
    await prepareBrowserSessionState("fixture-browser", "work", options);
    expect(readFileSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`), "utf8")).toBe("just-flushed login");
  });

  it("refuses changed access before closing and after flushing, without resurrecting deleted state", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "work-work.json.enc"), "old login");
    await expect(prepareBrowserSessionState("fixture-browser", "work", { ...options, isCurrent: () => false })).rejects.toThrow(/access changed/);
    expect(spawn).not.toHaveBeenCalled();
    let current = true;
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { onClose: () => { current = false; } }));
    await expect(prepareBrowserSessionState("fixture-browser", "work", { ...options, isCurrent: () => current })).rejects.toThrow(/access changed/);
    expect(existsSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`))).toBe(false);
  });

  it("does not migrate after a failed native close and allows a later retry", async () => {
    const { directory, options } = fixture();
    writeFileSync(join(directory, "work-work.json.enc"), "saved login");
    let code = 1;
    vi.mocked(spawn).mockImplementation((_binary, args) => lifecycleChild(args, { code }));
    await expect(prepareBrowserSessionState("fixture-browser", "work", options)).rejects.toThrow(/safely prepare/);
    expect(existsSync(join(directory, `${browserRestoreKey("work")}-work.json.enc`))).toBe(false);
    code = 0;
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
    // A deliberately configured external runtime remains an explicit override.
    const external = join(tmpdir(), "external-engine");
    files.add(external);
    expect(resolveAgentBrowserBinary({ ...options, env: { ...env, OMB_AGENT_BROWSER_PATH: external } })).toBe(external);
  });

  it("mounts the bundled browser with no download and keeps explicit Chrome overrides", async () => {
    const resources = mkdtempSync(join(tmpdir(), "omb-browser-resources-"));
    scratch.push(resources);
    const env = { OMB_RESOURCES_PATH: resources, PATH: "" };
    const bundle = browserBundlePaths(join(resources, "browser-engine"), `${process.platform}-${process.arch}`);
    mkdirSync(bundle.licenses, { recursive: true });
    for (const file of [bundle.engine, bundle.chrome, bundle.manifest]) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "fixture, not executable");
    }
    expect(browserEngineStatus({ env })).toMatchObject({ kind: "ready", binaryPath: bundle.engine });
    const spec = agentBrowserIntegration({ binaryPath: bundle.engine, session: "isolated", encryptionKey: "key", env });
    expect(spec.env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(bundle.chrome);
    expect(spec.env.AGENT_BROWSER_SESSION).toBe("isolated");
    expect(spec.env.AGENT_BROWSER_NO_WEBMCP).toBe("1");
    expect(spec.env).not.toHaveProperty("OMB_RESOURCES_PATH");
    const override = agentBrowserIntegration({ binaryPath: bundle.engine, session: "isolated", encryptionKey: "key", env: { ...env, AGENT_BROWSER_EXECUTABLE_PATH: "/explicit/chrome" } });
    expect(override.env.AGENT_BROWSER_EXECUTABLE_PATH).toBe("/explicit/chrome");
    // A spawn would fail because the fixture engine is not executable.
    await expect(ensureChrome(bundle.engine, { env })).resolves.toBeUndefined();
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
    // an override that does not exist is an error, not a silent fallback
    expect(resolveAgentBrowserBinary({ dataDir, env: { ...env, OMB_AGENT_BROWSER_PATH: join(dataDir, "missing", name) }, exists })).toBeNull();
    expect(browserEngineStatus({ dataDir, env, exists })).toMatchObject({ kind: "ready", binaryPath: pinned, version: agentBrowserReleaseVersion(resolveAgentBrowserReleaseAsset()) });
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
      AGENT_BROWSER_HEADLESS: "1", PATH: "/usr/bin",
      AGENT_BROWSER_EXECUTABLE_PATH: "/opt/trusted chrome/chrome",
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
      AGENT_BROWSER_HEADLESS: "1", PATH: "/usr/bin",
      AGENT_BROWSER_EXECUTABLE_PATH: "/opt/process-chrome/chrome",
    });
    for (const env of [{}, { AGENT_BROWSER_EXECUTABLE_PATH: "" }]) {
      const explicit = agentBrowserIntegration({ binaryPath: "/x", session: "s", encryptionKey: "k", env });
      expect(explicit.env.AGENT_BROWSER_EXECUTABLE_PATH).toBeUndefined();
      expect(explicit.env.PRIVATE_WORKSPACE_SECRET).toBeUndefined();
    }
  });

  it("mounts agent-browser's MCP server with the core tools, an isolated auto-restored session, and WebMCP off", () => {
    const spec = agentBrowserIntegration({ binaryPath: "/x/agent-browser", session: "bot-1", encryptionKey: "k".repeat(64), env: { PATH: "/usr/bin" } });
    expect(spec.command).toBe("/x/agent-browser");
    expect(spec.args).toEqual(["mcp", "--tools", "core", "--no-webmcp"]);
    expect(spec.env).toMatchObject({ AGENT_BROWSER_SESSION: "bot-1", AGENT_BROWSER_RESTORE: browserRestoreKey("bot-1"), AGENT_BROWSER_RESTORE_SAVE: "auto", AGENT_BROWSER_HEADLESS: "1", PATH: "/usr/bin" });
    expect(spec.env.AGENT_BROWSER_ENCRYPTION_KEY).toBe("k".repeat(64));
    expect(agentBrowserIntegration({ binaryPath: "/x", session: "s", encryptionKey: "k", headless: false }).env.AGENT_BROWSER_HEADLESS).toBeUndefined();
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
    // a corrupted key file is replaced, never reused
    writeFileSync(join(dataDir, "browser-engine-key"), "garbage\n");
    const fresh = browserEngineEncryptionKey(dataDir);
    expect(fresh).toMatch(/^[0-9a-f]{64}$/u);
    expect(fresh).not.toBe(key);
    mkdirSync(join(dataDir, "unused"));
  });
});


describe("agentBrowserFrame", () => {
  /** Use a real Node child on every OS, not an unlaunchable Windows shebang.
   * Only the executable is substituted; arguments, env and file IO are real. */
  async function fakeBinary(body: string): Promise<string> {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementationOnce((_binary, args, options) => {
      expect(_binary).toBe("fixture-agent-browser");
      expect(args?.[0]).toBe("screenshot");
      return actual.spawn(process.execPath, ["-e", body, ...args ?? []], options);
    });
    return "fixture-agent-browser";
  }

  it("returns the picture the browser wrote, base64 encoded", async () => {
    // `screenshot <path>` is argument 2; the CLI writes the file there.
    const binaryPath = await fakeBinary('require("node:fs").writeFileSync(process.argv[2], "PNGDATA")');
    const frame = await agentBrowserFrame({ binaryPath, env: { AGENT_BROWSER_SESSION: "bot-1" } });
    expect(frame.format).toBe("png");
    expect(Buffer.from(frame.png, "base64").toString()).toBe("PNGDATA");
    expect(existsSync(vi.mocked(spawn).mock.calls[0]![1]![1]!)).toBe(false);
  });

  it("carries the mount's session env, so it pictures the bot's own browser", async () => {
    const binaryPath = await fakeBinary('require("node:fs").writeFileSync(process.argv[2], process.env.AGENT_BROWSER_SESSION)');
    const frame = await agentBrowserFrame({ binaryPath, env: { AGENT_BROWSER_SESSION: "profile-x" } });
    expect(Buffer.from(frame.png, "base64").toString()).toBe("profile-x");
  });

  it("fails with the browser's own reason when the capture fails", async () => {
    const binaryPath = await fakeBinary('process.stderr.write("no open page"); process.exitCode = 3');
    await expect(agentBrowserFrame({ binaryPath, env: {} })).rejects.toThrow(/no open page/);
  });

  it("fails rather than inventing a picture the browser never wrote", async () => {
    const binaryPath = await fakeBinary("process.exitCode = 0");
    await expect(agentBrowserFrame({ binaryPath, env: {} })).rejects.toThrow(/did not write/);
  });

  it("gives up on a hung browser instead of holding the turn open", async () => {
    const binaryPath = await fakeBinary("setTimeout(() => {}, 5000)");
    await expect(agentBrowserFrame({ binaryPath, env: {}, timeoutMs: 150 })).rejects.toThrow(/in time/);
  });
});
