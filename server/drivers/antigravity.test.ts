import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import * as procs from "../procs.ts";
import * as envPath from "../env-path.ts";
import * as managedRuntime from "./antigravity-runtime.ts";
import {
  ANTIGRAVITY_AUTH_PREFIX,
  AntigravityAcpClient,
  AntigravityAuthController,
  antigravityProfileAuthenticated,
  antigravityProfileDirectory,
  authorizationUrlFromLine,
  catalogFromAntigravityConfigOptions,
  isValidAntigravityInitializeResult,
  parseAntigravityAuthorizationUrl,
  prepareAntigravityProfile,
  probeAntigravityModels,
  validateAntigravityCallbackUrl,
  validateAntigravityRuntime,
} from "./antigravity-acp.ts";
import {
  ANTIGRAVITY_RELEASE_VERSION,
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravity-release.ts";
import { installAntigravityRuntime, resolveAntigravityRuntime } from "./antigravity-runtime.ts";
import {
  AntigravityDriver,
  STATIC_ANTIGRAVITY_MODELS,
  antigravityModelsFromSession,
  antigravityPermissionMode,
} from "./antigravity.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const scratch: string[] = [];

function fakeRuntime(startupDelayMs = 0): { directory: string; executable: string; harness: string } {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-acp-"));
  scratch.push(directory);
  const executable = join(directory, "fake-antigravity.ts");
  const harness = join(directory, process.platform === "win32" ? "localharness_external.exe" : "localharness_external");
  copyFileSync(FAKE_ACP, executable);
  if (startupDelayMs) {
    writeFileSync(executable, `#!/usr/bin/env node\nsetTimeout(() => import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)}), ${startupDelayMs});\n`);
  }
  copyFileSync(FAKE_ACP, harness);
  if (process.platform !== "win32") {
    chmodSync(executable, 0o755);
    chmodSync(harness, 0o755);
  }
  return { directory, executable, harness };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.FAKE_ACP_AUTH_METHOD;
  delete process.env.FAKE_ACP_MODELS;
  delete process.env.FAKE_ACP_MODES;
  delete process.env.FAKE_ACP_DUMP;
  delete process.env.FAKE_ACP_PAD_QUESTION_OPTION;
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("official Antigravity catalog", () => {
  it("uses current Gemini 3.8 variants as the offline fallback", () => {
    expect(STATIC_ANTIGRAVITY_MODELS).toEqual({
      default: "gemini-3.8-flash-high",
      options: [
        { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
        { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
        { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
      ],
    });
  });

  it("reads the authenticated account catalog from ACP config options", () => {
    const options = [{
      id: "model",
      type: "select",
      currentValue: "account-low",
      options: [
        { value: "account-high", name: "Account High" },
        { group: "More", options: [{ value: "account-low", name: "Account Low" }] },
      ],
    }];
    expect(catalogFromAntigravityConfigOptions(options, "missing")).toEqual({
      default: "account-low",
      options: [
        { id: "account-high", label: "Account High" },
        { id: "account-low", label: "Account Low" },
      ],
    });
    expect(antigravityModelsFromSession(options)).toEqual({
      default: "account-low",
      options: [
        { id: "account-high", label: "Account High" },
        { id: "account-low", label: "Account Low" },
      ],
    });
  });
});

describe("Antigravity sign-in lifecycle", () => {
  it("preserves failed setup errors until retry or external recovery, without reviving stale errors", async () => {
    if (!resolveAntigravityReleaseAsset()) return;
    const fake = fakeRuntime();
    const custom = join(fake.directory, "not-installed");
    const install = vi.spyOn(managedRuntime, "installAntigravityRuntime")
      .mockRejectedValueOnce(new Error("Antigravity initialization timed out: fixture failure"));
    const instance = await AntigravityDriver.create({
      instanceId: "failed-antigravity-install",
      displayName: "Antigravity fixture", enabled: true,
      config: { cli: custom, fullAuto: false },
      environment: {},
    });
    try {
      await expect(instance.installRuntime!()).rejects.toThrow("fixture failure");
      expect(await instance.snapshot()).toEqual({ state: "unavailable", reason: "Antigravity initialization timed out: fixture failure" });
      // Independent refreshes (including reopening the card) keep the cause.
      expect((await instance.snapshot()).reason).toContain("fixture failure");
      // A manual/shared install can recover without this instance retrying.
      copyFileSync(fake.executable, custom);
      if (process.platform !== "win32") chmodSync(custom, 0o755);
      expect((await instance.snapshot()).state).toBe("available");
      unlinkSync(custom);
      const unavailable = await instance.snapshot();
      expect(unavailable.state).toBe("unavailable");
      expect(unavailable.reason).not.toContain("fixture failure");
      install.mockRejectedValueOnce(new Error("Antigravity initialization timed out: fixture failure"));
      await expect(instance.installRuntime!()).rejects.toThrow("fixture failure");
      install.mockResolvedValueOnce({ executablePath: fake.executable, harnessPath: fake.harness, source: "managed", version: "1.1.1" });
      await instance.installRuntime!();
      expect((await instance.snapshot()).reason).not.toContain("fixture failure");
    } finally {
      await instance.dispose();
    }
  });

  it("uses the same discovered PATH for readiness and Google sign-in", async () => {
    const fake = fakeRuntime();
    const executable = join(fake.directory, process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par");
    copyFileSync(fake.executable, executable);
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    vi.stubEnv("PATH", "");
    vi.spyOn(envPath, "augmentedPath").mockReturnValue(fake.directory);
    const authenticate = vi.spyOn(AntigravityAuthController.prototype, "start").mockResolvedValue({
      phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null,
    });
    const instance = await AntigravityDriver.create({
      instanceId: "path-only-antigravity",
      displayName: "Antigravity fixture",
      enabled: true,
      config: { cli: "agy_acp_server" + (process.platform === "win32" ? ".exe" : ".par"), fullAuto: false },
      environment: { PATH: "" },
    });
    try {
      expect((await instance.snapshot()).state).toBe("available");
      await expect(instance.startAuthentication!()).resolves.toMatchObject({ phase: "succeeded" });
      expect(authenticate).toHaveBeenCalledWith(
        expect.objectContaining({ executablePath: executable }),
        expect.objectContaining({ environment: expect.objectContaining({ PATH: fake.directory }) }),
      );
    } finally {
      await instance.dispose();
    }
  });

  // Google's server announces the link on stderr, never stdout — a fake that
  // prints to stdout passes against code that cannot sign in at all.
  it.each(["cancel", "provider failure"])("contains %s after handing the browser a sign-in URL", async (ending) => {
    const fake = fakeRuntime();
    const url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2F";
    writeFileSync(fake.executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'authenticate') {
    console.error(${JSON.stringify(ANTIGRAVITY_AUTH_PREFIX + url)});
    ${ending === "provider failure" ? `setTimeout(() => console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'Sign-in expired' } })), 100);` : ""}
  } else console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
});
`);
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({ instanceId: "auth-lifecycle", runtime, baseDir: fake.directory });
    const controller = new AntigravityAuthController();
    try {
      const flow = await controller.start(runtime, profile);
      expect(flow.phase).toBe("waiting");
      if (ending === "cancel") controller.cancel();
      // Let rejected pending RPCs settle: Vitest must see no unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(controller.complete(flow.flowId!, "http://127.0.0.1:54321/?code=test&state=fixture"))
        .rejects.toThrow(/no longer active/u);
    } finally {
      controller.cancel();
    }
  });
});

describe("stopping the runtime before touching its files", () => {
  it("validates a real fake runtime and waits for its process to close before returning", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    vi.stubEnv("FAKE_ACP_AGENT_NAME", "Google Antigravity");
    vi.stubEnv("FAKE_ACP_AGENT_VERSION", "1.1.1");
    vi.stubEnv("FAKE_ACP_AUTH_METHOD", "oauth-personal");
    let sawClose = false;
    const spawn = procs.spawnCli;
    const spawned = vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
      const child = spawn(...args);
      child.once("close", () => { sawClose = true; });
      return child;
    });
    await validateAntigravityRuntime(runtime, "agy_acp_server_1.1.1");
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(sawClose).toBe(true);
    const child = spawned.mock.results[0]!.value;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("closeAndWait resolves only once the process is gone, so a rename on Windows cannot hit a running executable", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({ instanceId: "close-and-wait", runtime, baseDir: fake.directory });
    const client = new AntigravityAcpClient(runtime, profile, fake.directory);
    await client.initialize();
    expect(client.child.exitCode).toBeNull();
    expect(await client.closeAndWait()).toBe(true);
    expect(client.child.exitCode !== null || client.child.signalCode !== null).toBe(true);
    // idempotent, and immediate the second time
    expect(await client.closeAndWait(100)).toBe(true);
  });
});

describe("official Antigravity runtime", () => {
  it("pins Google's release metadata for this supported host", () => {
    const asset = resolveAntigravityReleaseAsset();
    if (!asset) return;
    expect(ANTIGRAVITY_RELEASE_VERSION).toBe("agy_acp_server_1.1.1");
    expect(asset.version).toBe(ANTIGRAVITY_RELEASE_VERSION);
    expect(asset.url).toMatch(/^https:\/\/dl\.google\.com\/agy-extensions\/releases\//u);
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(asset.archiveBytes).toBeGreaterThan(100_000_000);
  });

  /**
   * Verifies that isValidAntigravityInitializeResult correctly validates initialization
   * responses from official Google Antigravity releases and rejects invalid responses.
   *
   * @returns {void}
   */
  function testValidatesAcpInitializeResults() {
    const basePayload = {
      protocolVersion: 1,
      agentInfo: { name: "antigravity-acp", version: "1.1.1" },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: true },
        auth: { logout: true },
      },
      authMethods: [{ id: "oauth-personal" }],
    };

    // Standard semver version from official agent.json manifest
    expect(isValidAntigravityInitializeResult(basePayload, "agy_acp_server_1.1.1")).toBe(true);
    expect(isValidAntigravityInitializeResult(basePayload, "1.1.1")).toBe(true);

    // With binary release tag as version
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.1.1" },
    }, "agy_acp_server_1.1.1")).toBe(true);

    // With official display name from manifest
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "Google Antigravity", version: "1.1.1" },
    }, "agy_acp_server_1.1.1")).toBe(true);

    // Rejects mismatched protocol version
    expect(isValidAntigravityInitializeResult({ ...basePayload, protocolVersion: 2 }, "1.1.1")).toBe(false);

    // Rejects unexpected agent name
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "rogue-agent", version: "1.1.1" },
    }, "1.1.1")).toBe(false);

    // Rejects mismatched version
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "antigravity-acp", version: "2.0.0" },
    }, "1.1.1")).toBe(false);

    // Rejects missing required capabilities
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentCapabilities: { loadSession: false, sessionCapabilities: { resume: true }, auth: { logout: true } },
    }, "1.1.1")).toBe(false);

    // Rejects missing oauth-personal auth method
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      authMethods: [{ id: "api-key" }],
    }, "1.1.1")).toBe(false);

    // Rejects non-string versions
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "antigravity-acp", version: 1 },
    }, "1.1.1")).toBe(false);
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "antigravity-acp", version: null },
    }, "1.1.1")).toBe(false);

    // Handles null / undefined gracefully
    expect(isValidAntigravityInitializeResult(null, "1.1.1")).toBe(false);
    expect(isValidAntigravityInitializeResult(undefined, "1.1.1")).toBe(false);
  }

  it("validates ACP initialize results from official Antigravity releases", testValidatesAcpInitializeResults);

  // Captured from the SHA-256-pinned Google 1.1.1 macOS arm64 binary in an
  // isolated, unauthenticated profile. Optional operations are objects, not true.
  const officialInitialize = {
    protocolVersion: 1,
    agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "agy_acp_server_1.1.1" },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {} },
      auth: { logout: {} },
    },
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  };

  it("accepts the official runtime's object-shaped capabilities", () => {
    expect(isValidAntigravityInitializeResult(officialInitialize, ANTIGRAVITY_RELEASE_VERSION)).toBe(true);
  });

  it.each([undefined, null, false, [], "true", 1])("rejects malformed operation capabilities: %j", (value) => {
    for (const capabilities of [
      { ...officialInitialize.agentCapabilities, sessionCapabilities: { resume: value } },
      { ...officialInitialize.agentCapabilities, auth: { logout: value } },
    ]) {
      expect(isValidAntigravityInitializeResult({ ...officialInitialize, agentCapabilities: capabilities }, ANTIGRAVITY_RELEASE_VERSION)).toBe(false);
    }
  });

  it("requires the official executable and harness as a pair", async () => {
    const fake = fakeRuntime();
    await expect(resolveAntigravityRuntime(fake.executable)).resolves.toMatchObject({
      executablePath: fake.executable,
      harnessPath: fake.harness,
      source: "override",
    });
    rmSync(fake.harness, { force: true });
    await expect(resolveAntigravityRuntime(fake.executable)).rejects.toMatchObject({
      message: expect.stringMatching(/localharness_external/u),
      status: 409,
    });
  });

  it.each([
    "agy.cmd",
    "C:\\Users\\Someone\\AppData\\Roaming\\npm\\agy.cmd",
    "C:\\Tools\\agy.exe",
    "C:\\Tools\\agy.bat",
    "C:\\Tools\\agy.ps1",
    "/opt/homebrew/bin/agy",
    "/Users/someone/.local/bin/agy",
  ])("migrates the saved legacy CLI path %s to the official runtime", async (legacyPath) => {
    const fake = fakeRuntime();
    const officialExecutable = join(fake.directory, process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par");
    copyFileSync(fake.executable, officialExecutable);
    if (process.platform !== "win32") chmodSync(officialExecutable, 0o755);
    const runtime = await resolveAntigravityRuntime(legacyPath, { PATH: fake.directory }, fake.directory);
    expect(runtime).toMatchObject({ executablePath: officialExecutable, source: "path" });
  });

  it("explains the official setup when a legacy CLI has no replacement installed", async () => {
    if (!resolveAntigravityReleaseAsset()) return;
    const fake = fakeRuntime();
    await expect(resolveAntigravityRuntime("/old/bin/agy", { PATH: "" }, fake.directory))
      .rejects.toThrow(/Install official Antigravity, then Sign in with Google/);
  });

  it("preserves a valid explicitly selected official runtime even if named agy", async () => {
    const fake = fakeRuntime();
    const custom = join(fake.directory, "agy");
    copyFileSync(fake.executable, custom);
    if (process.platform !== "win32") chmodSync(custom, 0o755);
    await expect(resolveAntigravityRuntime(custom, { PATH: "" }, fake.directory))
      .resolves.toMatchObject({ executablePath: custom, source: "override" });
  });

  it("does not silently replace an unrecognized custom executable", async () => {
    const fake = fakeRuntime();
    await expect(resolveAntigravityRuntime(join(fake.directory, "custom-acp"), { PATH: "" }, fake.directory))
      .rejects.toThrow(/custom Antigravity ACP executable/);
  });

  it("atomically prepares one complete profile for concurrent callers", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profileDirectory = join(fake.directory, "profile");
    await Promise.all(Array.from({ length: 8 }, () => prepareAntigravityProfile({
      instanceId: "shared",
      runtime,
      baseEnv: {},
      profileDirectory,
    })));
    const acpDirectory = join(profileDirectory, "antigravity-acp");
    expect(JSON.parse(readFileSync(join(acpDirectory, "settings.json"), "utf8"))).toEqual({
      auth: { type: "oauth-personal" },
    });
    expect(readdirSync(acpDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the existing Google sign-in when the runtime version changes", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const input = { instanceId: "persistent", runtime, baseEnv: {}, baseDir: fake.directory };
    const before = await prepareAntigravityProfile(input);
    writeFileSync(before.tokenPath, '{"fixture":"existing-login"}', { mode: 0o600 });
    const after = await prepareAntigravityProfile({ ...input, runtime: { ...runtime, version: "new-version" } });
    expect(after.tokenPath).toBe(before.tokenPath);
    expect(readFileSync(after.tokenPath, "utf8")).toBe('{"fixture":"existing-login"}');
    expect(await antigravityProfileAuthenticated(after)).toBe(true);
  });

  it("discovers account models when the packaged runtime takes over five seconds to start", async () => {
    const fake = fakeRuntime(5_500);
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({
      instanceId: "slow-start", runtime, baseDir: fake.directory,
      baseEnv: { PATH: process.env.PATH, FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "account-model" },
    });
    await expect(probeAntigravityModels({ runtime, profile, fallbackDefault: "account-model" }))
      .resolves.toMatchObject({ options: [{ id: "account-model" }] });
  }, 20_000);

  it("rejects a download redirected to insecure HTTP", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "omb-antigravity-insecure-"));
    scratch.push(baseDir);
    const asset: AntigravityReleaseAsset = {
      version: "insecure-test",
      url: "https://dl.google.com/test-antigravity.zip",
      sha256: "00".repeat(32),
      archiveBytes: 1,
      executable: { name: "agy_acp_server.par", bytes: 1 },
      harness: { name: "localharness_external", bytes: 1 },
    };
    const response = new Response(new Uint8Array([0]), { headers: { "content-length": "1" } });
    Object.defineProperty(response, "url", { value: "http://dl.google.com/test-antigravity.zip" });
    await expect(installAntigravityRuntime({
      baseDir,
      asset,
      fetchImpl: async () => response,
    })).rejects.toThrow(/redirected outside/u);
  });

  it("coalesces, verifies, extracts, and reuses a pinned download without touching another install", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "omb-antigravity-install-"));
    scratch.push(baseDir);
    const versions = join(baseDir, "tools", "antigravity-acp", `${process.platform}-${process.arch}`, "versions");
    const otherStaging = join(versions, ".install-other-active", "runtime");
    mkdirSync(otherStaging, { recursive: true });
    const otherFile = join(otherStaging, "agy_acp_server.exe");
    writeFileSync(otherFile, "another app process is still installing");
    const archive = Buffer.from(
      "UEsDBBQAAAAIAMaAI13ihkXDEwAAABEAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyU1bUT8rM0y/O4EqtyCxRMOACAFBLAwQUAAAACADGgCNd4oZFwxMAAAARAAAAFQAAAGxvY2FsaGFybmVzc19leHRlcm5hbFNW1E/KzNMvzuBKrcgsUTDgAgBQSwECFAMUAAAACADGgCNd4oZFwxMAAAARAAAAEgAAAAAAAAAAAAAAgAEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsBAhQDFAAAAAgAxoAjXeKGRcMTAAAAEQAAABUAAAAAAAAAAAAAAIABQwAAAGxvY2FsaGFybmVzc19leHRlcm5hbFBLBQYAAAAAAgACAIMAAACJAAAAAAA=",
      "base64",
    );
    const asset: AntigravityReleaseAsset = {
      version: "test-release",
      url: "https://dl.google.com/test-antigravity.zip",
      sha256: "ebefcc10b5101013da6d0cb2a101ca644015377ee0f9ec5cf4efec7d9dfb7442",
      archiveBytes: archive.length,
      executable: { name: "agy_acp_server.par", bytes: 17 },
      harness: { name: "localharness_external", bytes: 17 },
    };
    let fetches = 0;
    let validations = 0;
    const options = {
      baseDir,
      asset,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(archive, { headers: { "content-length": String(archive.length) } });
      },
      validate: async () => { validations += 1; },
    };
    const first = installAntigravityRuntime(options);
    expect(installAntigravityRuntime(options)).toBe(first);
    const installed = await first;
    expect(readFileSync(installed.executablePath, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(readFileSync(installed.harnessPath, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    await installAntigravityRuntime(options);
    expect(fetches).toBe(1);
    expect(validations).toBe(2);
    expect(readFileSync(otherFile, "utf8")).toBe("another app process is still installing");
    expect(readdirSync(versions).filter((name) => name.startsWith(".install-"))).toEqual([".install-other-active"]);
  });

  it("isolates profiles by instance and strips ambient Google credentials", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const first = await prepareAntigravityProfile({
      instanceId: "work",
      runtime,
      baseEnv: { HOME: "/tmp/home", GEMINI_API_KEY: "must-not-leak", GOOGLE_API_KEY: "also-no" },
    });
    const second = await prepareAntigravityProfile({ instanceId: "personal", runtime, baseEnv: {} });
    expect(first.directory).not.toBe(second.directory);
    expect(first.environment.GEMINI_API_KEY).toBeUndefined();
    expect(first.environment.GOOGLE_API_KEY).toBeUndefined();
    expect(first.environment.GEMINI_HOME).toBe(first.directory);
    expect(first.environment.ANTIGRAVITY_HARNESS_PATH).toBe(fake.harness);
  });

  it("bounds model discovery with one deadline", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({
      instanceId: "slow-models",
      runtime,
      baseEnv: { ...process.env, FAKE_ACP_MODE: "hang-initialize" },
    });
    const started = Date.now();
    await expect(probeAntigravityModels({
      runtime,
      profile,
      fallbackDefault: STATIC_ANTIGRAVITY_MODELS.default,
      timeoutMs: 100,
    })).rejects.toThrow(/timed out/u);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("Antigravity OAuth validation", () => {
  const state = "state-123";
  const redirectUri = "http://127.0.0.1:8765/";
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  it("accepts only Google's exact loopback authorization request", () => {
    expect(ANTIGRAVITY_AUTH_PREFIX).toContain("authenticate the ACP server");
    expect(parseAntigravityAuthorizationUrl(authorizationUrl)).toEqual({ authorizationUrl, redirectUri, state });
    expect(() => parseAntigravityAuthorizationUrl(authorizationUrl.replace("accounts.google.com", "example.com"))).toThrow(/invalid/u);
    expect(() => parseAntigravityAuthorizationUrl(authorizationUrl.replace("127.0.0.1", "localhost"))).toThrow(/invalid/u);
  });

  it("reads the sign-in link from either announcement Google makes", () => {
    // The $BROWSER helper re-emits the link JSON-encoded behind this marker;
    // the plain notice is what a terminal user would have read.
    expect(authorizationUrlFromLine(`__OPENMAUS_ANTIGRAVITY_AUTH_URL__${JSON.stringify(authorizationUrl)}`))
      .toBe(authorizationUrl);
    expect(authorizationUrlFromLine(`${ANTIGRAVITY_AUTH_PREFIX}${authorizationUrl}`)).toBe(authorizationUrl);
  });

  it("ignores ordinary server logs, including ones quoting a link", () => {
    expect(authorizationUrlFromLine("I0905 11:02:06.473720 8283299200 main.py:80] Starting AGY ACP Server...")).toBeNull();
    expect(authorizationUrlFromLine(`I0905 credential_manager.py:553] ${ANTIGRAVITY_AUTH_PREFIX}${authorizationUrl}`)).toBeNull();
    expect(authorizationUrlFromLine("__OPENMAUS_ANTIGRAVITY_AUTH_URL__not-json")).toBeNull();
    expect(authorizationUrlFromLine("")).toBeNull();
  });

  it("ties a pasted remote callback to the active state and loopback port", () => {
    expect(validateAntigravityCallbackUrl(
      { redirectUri, state },
      `${redirectUri}?code=secret&state=${state}&iss=${encodeURIComponent("https://accounts.google.com")}`,
    ).searchParams.get("code")).toBe("secret");
    expect(() => validateAntigravityCallbackUrl(
      { redirectUri, state },
      `${redirectUri}?code=secret&state=wrong`,
    )).toThrow(/does not belong/u);
  });
});

describe("Antigravity driver over shared ACP", () => {
  let instance: ProviderInstance | null = null;
  let recorder: EventRecorder | null = null;

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("uses managed setup and defaults to approval cards", () => {
    expect(AntigravityDriver.defaultConfig()).toEqual({ cli: "agy", fullAuto: false, workspace: undefined });
    expect(AntigravityDriver.install?.docsUrl).toContain("antigravity-acp");
    if (resolveAntigravityReleaseAsset()) expect(AntigravityDriver.install?.managed?.downloadBytes).toBeGreaterThan(0);
    expect(antigravityPermissionMode(false)).toBe("default");
    expect(antigravityPermissionMode(true)).toBe("yolo");
  });

  it.each(["ask", "auto", "full"] as const)("runs an authenticated %s turn with explicit mode and session-scoped MCP", async (approvalMode) => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const instanceId = "antigravity-work";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "acp_token.json"), "{}", { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity Work",
      environment: {
        GEMINI_API_KEY: "must-not-leak",
        GOOGLE_API_KEY: "also-must-not-leak",
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash-high,gemini-3.8-flash-low",
        FAKE_ACP_MODES: "default,yolo",
        FAKE_ACP_DUMP: dump,
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "thread-antigravity",
      text: "hello",
      approvalMode,
      resumeCursor: "fake-acp-session",
      model: "gemini-3.8-flash-low",
      integrations: {
        custom: { docs: { command: "docs-mcp", args: ["serve"], env: { TOKEN: "scoped" } } },
      },
      cwd: fake.directory,
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    expect(events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    const dumpState = JSON.parse(readFileSync(dump, "utf8"));
    expect(dumpState.argv).toEqual(process.platform === "linux" ? ["--uid="] : []);
    expect(dumpState.env.GEMINI_HOME).toBe(antigravityProfileDirectory(instanceId));
    expect(dumpState.env.GEMINI_API_KEY).toBeUndefined();
    expect(dumpState.env.GOOGLE_API_KEY).toBeUndefined();
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(calls).toEqual([
      { method: "session/set_config_option", params: { sessionId: "fake-acp-session", configId: "model", value: "gemini-3.8-flash-low" } },
      { method: "session/set_config_option", params: { sessionId: "fake-acp-session", configId: "mode", value: approvalMode === "full" ? "yolo" : "default" } },
    ]);
    const mcp = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"));
    expect(mcp).toEqual([{ name: "docs", command: "docs-mcp", args: ["serve"], env: [{ name: "TOKEN", value: "scoped" }] }]);
  });

  it("fails closed when Antigravity does not confirm its permission mode", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const instanceId = "antigravity-unconfirmed-mode";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "acp_token.json"), "{}", { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: undefined,
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash-high",
        FAKE_ACP_MODES: "default,yolo",
        FAKE_ACP_EMPTY_MODE_ACK: "1",
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "thread-unconfirmed-mode",
      text: "hello",
      cwd: fake.directory,
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({
      ok: false,
    });
    expect(recorder.events.some(
      (event) => event.type === "runtime.error" && /did not apply yolo permission mode/u.test(event.message),
    )).toBe(true);
  });

  it.each([
    ["question", undefined],
    ["question", "full"],
    ["permission", "full"],
  ] as const)("keeps Antigravity %s requests interactive with mode %s", async (requestKind, approvalMode) => {
    ensureDirs();
    const fake = fakeRuntime();
    const instanceId = "antigravity-question";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "acp_token.json"), "{}", { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: undefined,
      environment: {
        FAKE_ACP_MODE: requestKind,
        FAKE_ACP_PAD_QUESTION_OPTION: "1",
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash-high",
        FAKE_ACP_MODES: "default,yolo",
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "thread-question", text: "ask me", cwd: fake.directory, approvalMode });
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: requestKind });
    if (requestKind === "question") expect(opened).toMatchObject({ summary: "Which color?", choices: ["Blue", "Green"] });
    await instance.adapter.respondToRequest("thread-question", (opened as { requestId: string }).requestId, {
      behavior: requestKind === "question" ? "answer" : "allow",
      message: "Green",
    });
    expect(await recorder.until((event) => event.type === "request.resolved")).toMatchObject({
      behavior: requestKind === "question" ? "answer" : "allow",
      source: "user",
    });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
  });
});
