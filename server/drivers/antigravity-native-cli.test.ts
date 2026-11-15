import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import {
  antigravityCliSessionMode,
  antigravityLaunchArgs,
  antigravityTokenPath,
  isValidAntigravityInitializeResult,
  prepareAntigravityProfile,
  validateAntigravityRuntime,
} from "./antigravity-acp.ts";
import { activeAntigravityCli, isAntigravityCliName } from "./antigravity-cli-install.ts";
import type { AntigravityCliReleaseAsset } from "./antigravity-cli-release.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";
import { antigravityCliUpdate, installAntigravityRuntime, resolveAntigravityRuntime } from "./antigravity-runtime.ts";
import { AntigravityDriver } from "./antigravity.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const WINDOWS = process.platform === "win32";
const NAME = WINDOWS ? "agy.exe" : "antigravity";
const ORIGIN = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-cli-"));
  scratch.push(directory);
  return directory;
}

/** A release as Google's channel names it, with the bytes its address serves. */
async function release(version: string, members: Record<string, string | { link: string }> = { [NAME]: `#!/bin/sh\necho ${version}\n` }) {
  let bytes: Buffer;
  if (WINDOWS) bytes = Buffer.from(String(Object.values(members)[0]));
  else {
    const source = folder();
    for (const [name, content] of Object.entries(members)) {
      if (typeof content === "string") writeFileSync(join(source, name), content, { mode: 0o755 });
      else symlinkSync(content.link, join(source, name));
    }
    const archive = join(folder(), "cli.tar.gz");
    await tar.c({ gzip: true, file: archive, cwd: source, portable: true }, Object.keys(members));
    bytes = readFileSync(archive);
  }
  const asset: AntigravityCliReleaseAsset = {
    version, url: `${ORIGIN}${version}-1/fixture`, sha512: createHash("sha512").update(bytes).digest("hex"),
    executable: { name: NAME }, format: WINDOWS ? "executable" : "tar.gz",
  };
  return { asset, bytes };
}

function serving(files: Array<{ asset: AntigravityCliReleaseAsset; bytes: Buffer }>, finalUrl?: string) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    asked.push(String(url));
    const file = files.find(({ asset }) => asset.url === String(url));
    if (!file) return new Response("missing", { status: 404 });
    const response = new Response(file.bytes);
    Object.defineProperty(response, "url", { value: finalUrl ?? String(url) });
    return response;
  }) as typeof fetch;
  return { fetchImpl, asked };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const instance of instances.splice(0)) await instance.dispose();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("installing the native CLI from Google's channel", () => {
  it("verifies, unpacks, checks and activates a release, then reuses it without another download", async () => {
    const baseDir = folder();
    const one = await release("1.5.7");
    const { fetchImpl, asked } = serving([one]);
    const validate = vi.fn(async () => {});
    const installed = await installAntigravityRuntime({ baseDir, fetchImpl, validate, native: true, cliRelease: one.asset });
    expect(installed).toMatchObject({ harnessPath: null, source: "managed", version: "1.5.7" });
    expect(installed.executablePath.endsWith(join(one.asset.sha512.slice(0, 64), NAME))).toBe(true);
    if (!WINDOWS) expect(readFileSync(installed.executablePath, "utf8")).toBe("#!/bin/sh\necho 1.5.7\n");
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ harnessPath: null, version: "1.5.7" }), "1.5.7");
    const root = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`);
    expect(await activeAntigravityCli(root)).toEqual(installed);
    expect(readdirSync(join(root, "versions")).filter((name) => name.startsWith(".install-"))).toEqual([]);

    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toEqual(installed);
    await expect(resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toEqual(installed);
    await expect(resolveAntigravityRuntime(undefined, { PATH: "" }, baseDir)).resolves.toEqual(installed);

    await installAntigravityRuntime({ baseDir, fetchImpl, validate, native: true, cliRelease: one.asset });
    expect(asked).toEqual([one.asset.url]);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("moves to a newer release and keeps the old one beside it, and never moves back to an older one", async () => {
    const baseDir = folder();
    const [older, newer] = [await release("1.5.6"), await release("1.5.8")];
    const { fetchImpl, asked } = serving([older, newer]);
    const first = await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: older.asset, native: true });
    const second = await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: newer.asset });
    expect(second.version).toBe("1.5.8");
    expect(existsSync(first.executablePath)).toBe(true);
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.8" });
    expect((await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: older.asset })).version).toBe("1.5.8");
    expect(asked).toEqual([older.asset.url, newer.asset.url]);
  });

  it("installs nothing when the bytes do not match the channel's checksum, or come from somewhere else", async () => {
    const baseDir = folder();
    const one = await release("1.5.7");
    const wrong = { asset: one.asset, bytes: Buffer.concat([one.bytes, Buffer.from("x")]) };
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([wrong]).fetchImpl, native: true, cliRelease: one.asset }))
      .rejects.toThrow("failed its size or checksum check. Nothing was installed.");
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([one], "https://storage.googleapis.com/another-bucket/cli").fetchImpl, native: true, cliRelease: one.asset }))
      .rejects.toThrow("redirected away from Google's release folder");
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([]).fetchImpl, native: true, cliRelease: one.asset })).rejects.toThrow("Google download failed (404).");
    await expect(installAntigravityRuntime({ baseDir, native: true, cliRelease: null })).rejects.toThrow("Could not find a native Antigravity CLI release.");
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).rejects.toThrow(/native CLI is not installed.*set the CLI path back to agy/u);
    const root = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`);
    expect(existsSync(join(root, "active.json"))).toBe(false);
    expect(readdirSync(join(root, "versions"))).toEqual([]);
  });

  it("leaves the release that was running in place when the new one does not start", async () => {
    const baseDir = folder();
    const [older, newer] = [await release("1.5.6"), await release("1.5.8")];
    const { fetchImpl } = serving([older, newer]);
    await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: older.asset, native: true });
    const validate = vi.fn(async () => { throw new Error("The download did not identify as the expected Google Antigravity ACP release."); });
    await expect(installAntigravityRuntime({ baseDir, fetchImpl, validate, cliRelease: newer.asset, native: true })).rejects.toThrow("did not identify");
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.6" });
  });

  it.skipIf(WINDOWS).each([
    ["a second file", { antigravity: "#!/bin/sh\n", extra: "more" }],
    ["another name", { "agy-other": "#!/bin/sh\n" }],
    ["a link", { antigravity: { link: "/bin/sh" } }],
  ] as Array<[string, Record<string, string | { link: string }>]>)("refuses an archive that holds %s", async (_name, members) => {
    const baseDir = folder();
    const bad = await release("1.5.7", members);
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([bad]).fetchImpl, native: true, cliRelease: bad.asset }))
      .rejects.toThrow("The Antigravity archive must contain one regular executable.");
  });

  it("keeps the pinned runtime on a computer that already has one of its releases", async () => {
    const pinned = resolveAntigravityReleaseAsset();
    if (!pinned) return;
    const baseDir = folder();
    const earlier = "f".repeat(64);
    const directory = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`, "versions", earlier);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".install-complete.json"), JSON.stringify({ sha256: earlier, version: "1.1.1" }));
    const one = await release("1.5.7");
    const { fetchImpl, asked } = serving([one]);
    await expect(installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: one.asset })).rejects.toThrow();
    expect(asked).toEqual([pinned.url]);
    expect(await antigravityCliUpdate({ baseDir, now: 1, latest: async () => one.asset })).toBeNull();
  });

  it("falls back to the pinned runtime when a new install cannot get the native CLI", async () => {
    const pinned = resolveAntigravityReleaseAsset();
    if (!pinned) return;
    const baseDir = folder();
    const one = await release("1.5.7");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl, asked } = serving([]);
    await expect(installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: one.asset })).rejects.toThrow("Google download failed (404).");
    expect(asked).toEqual([one.asset.url, pinned.url]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("installing the pinned runtime instead"));
    warn.mockRestore();
  });

  it("offers an update only when the CLI in use is older than the channel's, asking at most once an hour", async () => {
    const baseDir = folder();
    const [current, newer] = [await release("1.5.7"), await release("1.5.8")];
    await installAntigravityRuntime({ baseDir, fetchImpl: serving([current]).fetchImpl, cliRelease: current.asset, native: true });
    const latest = vi.fn(async () => newer.asset);
    const hour = 60 * 60 * 1000, start = Date.now() + 10 * hour;
    expect(await antigravityCliUpdate({ baseDir, now: start, latest, asset: null })).toBe("1.5.7");
    expect(await antigravityCliUpdate({ baseDir, now: start + hour - 1, latest, asset: null })).toBeNull();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(await antigravityCliUpdate({ baseDir, now: start + hour, latest: async () => current.asset, asset: null })).toBeNull();
    expect(await antigravityCliUpdate({ baseDir, now: start + 2 * hour, latest: async () => null, asset: null })).toBeNull();
    expect(await antigravityCliUpdate({ baseDir: folder(), now: start + 3 * hour, latest, asset: null })).toBeNull();
  });
});

describe("starting the native CLI", () => {
  it("launches through its acp subcommand with the profile folder, and without a harness", async () => {
    const directory = folder();
    expect(antigravityLaunchArgs({ harnessPath: null }, "/profile")).toEqual(["acp", "--gemini-dir", "/profile", "--app-data-dir", "antigravity-acp"]);
    expect(antigravityLaunchArgs({ harnessPath: "/runtime/localharness_external" }, "/profile", "linux")).toEqual(["--uid="]);
    expect(antigravityLaunchArgs({ harnessPath: "/runtime/localharness_external" }, "/profile", "darwin")).toEqual([]);
    const cli = await prepareAntigravityProfile({ instanceId: "cli", baseDir: directory, runtime: { executablePath: "/cli/antigravity", harnessPath: null, source: "managed", version: "1.5.7" } });
    expect("ANTIGRAVITY_HARNESS_PATH" in cli.environment).toBe(false);
    expect(cli.environment.GEMINI_HOME).toBe(cli.directory);
    const pair = await prepareAntigravityProfile({ instanceId: "pair", baseDir: directory, runtime: { executablePath: "/r/agy_acp_server.par", harnessPath: "/r/localharness_external", source: "managed", version: "1.4.3" } });
    expect(pair.environment.ANTIGRAVITY_HARNESS_PATH).toBe("/r/localharness_external");
  });

  it("knows the CLI by its names and by the name it gives itself", () => {
    for (const name of ["antigravity", "/usr/local/bin/antigravity", "C:\\Tools\\Antigravity.exe"]) expect(isAntigravityCliName(name)).toBe(true);
    for (const name of ["agy", "/opt/homebrew/bin/agy", "C:\\Tools\\agy.exe", "agy.cmd", "agy_acp_server.par", "antigravity-acp", "/antigravity/custom"]) expect(isAntigravityCliName(name)).toBe(false);
    const initialized = (name: string) => ({
      protocolVersion: 1, agentInfo: { name, version: "1.5.7" }, authMethods: [{ id: "oauth-personal" }],
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
    });
    expect(isValidAntigravityInitializeResult(initialized("Antigravity ACP Server"), "1.5.7", true)).toBe(true);
    expect(isValidAntigravityInitializeResult(initialized("antigravity-acp"), "1.5.7", true)).toBe(false);
    expect(isValidAntigravityInitializeResult(initialized("Antigravity ACP Server"), "1.5.7")).toBe(false);
    expect(isValidAntigravityInitializeResult(initialized("Antigravity ACP Server"), "1.5.8", true)).toBe(false);
  });

  it("stays in default where the pinned runtime would be in yolo or auto_edit", () => {
    expect(["yolo", "auto_edit", "default", "plan"].map(antigravityCliSessionMode)).toEqual(["default", "default", "default", "plan"]);
  });
});

describe.skipIf(WINDOWS)("a native CLI set as the engine's own path", () => {
  /** A program named `antigravity` that answers as the fake runtime does. */
  function cli(): { directory: string; executable: string; dump: string } {
    const directory = folder();
    const executable = join(directory, "antigravity");
    writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ACP)} "$@"\n`);
    chmodSync(executable, 0o755);
    return { directory, executable, dump: join(directory, "dump.json") };
  }

  async function create(instanceId: string, executable: string, environment: Record<string, string>) {
    ensureDirs();
    const token = antigravityTokenPath(instanceId);
    mkdirSync(dirname(token), { recursive: true });
    writeFileSync(token, "{}", { mode: 0o600 });
    const instance = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true, config: { cli: executable, fullAuto: false },
      environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_AGENT_NAME: "Antigravity ACP Server", FAKE_ACP_VERSION: "1.5.7", ...environment },
    });
    instances.push(instance);
    return instance;
  }

  it("is taken as the CLI only from 1.5.0 on, and a saved agy path is never started", async () => {
    const fake = cli();
    await expect(resolveAntigravityRuntime(fake.executable, { ...process.env, FAKE_ACP_VERSION: "1.5.7" }))
      .resolves.toEqual({ executablePath: fake.executable, harnessPath: null, source: "override", version: "1.5.7" });
    const old = cli();
    await expect(resolveAntigravityRuntime(old.executable, { ...process.env, FAKE_ACP_VERSION: "antigravity 1.4.9" }, folder()))
      .rejects.toThrow(/custom Antigravity ACP executable/u);
    const directory = folder(), started = join(directory, "started"), legacy = join(directory, "agy");
    writeFileSync(legacy, `#!/bin/sh\ntouch ${JSON.stringify(started)}\necho 1.5.7\n`);
    chmodSync(legacy, 0o755);
    await expect(resolveAntigravityRuntime(legacy, { PATH: "" }, folder())).rejects.toThrow();
    expect(existsSync(started)).toBe(false);
  });

  it("passes the check a download gets, by the name and version it reports", async () => {
    const fake = cli();
    vi.stubEnv("FAKE_ACP_AUTH_METHOD", "oauth-personal");
    vi.stubEnv("FAKE_ACP_AGENT_NAME", "Antigravity ACP Server");
    vi.stubEnv("FAKE_ACP_AGENT_VERSION", "1.5.7");
    const runtime = { executablePath: fake.executable, harnessPath: null, source: "managed" as const, version: "1.5.7" };
    await expect(validateAntigravityRuntime(runtime, "1.5.7")).resolves.toBeUndefined();
    await expect(validateAntigravityRuntime(runtime, "1.5.8")).rejects.toThrow("did not identify as the expected Google Antigravity ACP release");
  }, 60_000);

  it("runs a Full access turn in default mode, started through acp with our own client name", async () => {
    const fake = cli();
    const instance = await create("antigravity-cli-full", fake.executable, { FAKE_ACP_MODES: "default,plan", FAKE_ACP_DUMP: fake.dump });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "cli-full", text: "hello", approvalMode: "full", cwd: fake.directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
    const prompts = readFileSync(`${fake.dump}.prompts.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(prompts.at(-1)).toMatchObject({ mode: "default" });
    const launch = JSON.parse(readFileSync(fake.dump, "utf8"));
    expect(launch.argv.slice(0, 2)).toEqual(["acp", "--gemini-dir"]);
    expect(launch.argv.slice(3)).toEqual(["--app-data-dir", "antigravity-acp"]);
    expect(launch.env.ANTIGRAVITY_HARNESS_PATH).toBeUndefined();
    expect(JSON.parse(readFileSync(`${fake.dump}.initialize.json`, "utf8")).clientInfo).toEqual({ name: "openmausbot", version: "0.0.0" });
  }, 90_000);

  it("fails closed when the CLI does not confirm default mode", async () => {
    const fake = cli();
    const instance = await create("antigravity-cli-unconfirmed", fake.executable, { FAKE_ACP_MODES: "default,plan", FAKE_ACP_EMPTY_MODE_ACK: "1" });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "cli-unconfirmed", text: "hello", approvalMode: "full", cwd: fake.directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "runtime.error" && /did not apply default permission mode/u.test(event.message))).toBe(true);
  }, 90_000);

  it("answers an edit itself on Auto-accept edits, and still asks about a command", async () => {
    for (const [kind, asks] of [["edit", false], ["execute", true]] as const) {
      const fake = cli();
      const answer = join(fake.directory, "answer");
      const instance = await create(`antigravity-cli-edits-${kind}`, fake.executable, {
        FAKE_ACP_MODES: "default,plan", FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: answer,
        FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify(kind === "edit" ? { kind, title: "Edit notes.md" } : { kind, rawInput: { command: "echo hi" }, title: "echo hi" }),
      });
      const recorder = recordEvents(instance.adapter);
      const { turnId } = await instance.adapter.sendTurn({ threadId: `cli-edits-${kind}`, text: "hello", approvalMode: "edits", cwd: fake.directory });
      if (asks) {
        const opened = await recorder.until((event) => event.type === "request.opened" && event.turnId === turnId) as { requestId: string };
        await instance.adapter.respondToRequest("cli-edits-execute", opened.requestId, { behavior: "deny" });
      }
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(recorder.events.some((event) => event.type === "request.opened")).toBe(asks);
      expect(readFileSync(answer, "utf8")).toBe(asks ? "reject" : "allow-once");
    }
  }, 90_000);
});
