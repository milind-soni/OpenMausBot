// A local HTTP server stands in for the vendor's download host: the test fetch maps https://<host>/<path> onto it, so the
// installer's own HTTPS, host and redirect checks run unchanged. Nothing here reaches the internet.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as tar from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { StandaloneAsset, StandaloneRelease } from "./contracts.ts";
import {
  installStandaloneEngine,
  isAppStandaloneCopy,
  plainInstallError,
  STANDALONE_DOWNLOAD_TIMEOUT_MS,
  registerStandaloneBinDirs,
  resetStandaloneStateForTests,
  standaloneAssetFor,
  standaloneEngineDir,
  standalonePlatformKey,
  standaloneRunEnv,
  type CodesignRunner,
} from "./engine-standalone.ts";
import { augmentedPath, findCliCandidates, resetPathCache, resetPathCacheForTests } from "./env-path.ts";
import { INSTALL_TIMEOUT_MS } from "./headless/engine.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { buildZip } from "./testing/zip-fixture.ts";

const VERSION = "1.2.3";
const ENGINE = "fake-engine";
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const realDirectoryNow = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};
/** The error an install was refused with; an install that succeeds fails the test. */
const refusal = (run: Promise<unknown>): Promise<Error> => run.then(() => {
  throw new Error("expected the install to be refused");
}, (error: Error) => error);

it("lets the headless client wait out the server's whole download, so the server's own message arrives first", () => {
  expect(STANDALONE_DOWNLOAD_TIMEOUT_MS).toBe(20 * 60_000);
  expect(INSTALL_TIMEOUT_MS).toBeGreaterThan(STANDALONE_DOWNLOAD_TIMEOUT_MS);
});

describe("explaining a file-system failure", () => {
  const release = fixtureRelease({});
  const asset: StandaloneAsset = { url: "https://downloads.example.test/a", sha256: "0".repeat(64), executableSha256: "1".repeat(64), archive: "raw", executable: "x", approxBytes: 1 };
  const failure = (code: string, syscall: string) => Object.assign(new Error(`${code}: operation failed, ${syscall}`), { code, syscall });
  const inUse = "Fake Engine is open in another window. Close it, then try again.";
  const noPermission = "OpenMausBot can't write to its folder for Fake Engine. Check the folder's permissions, then try again.";

  it.each([
    ["EBUSY", "rmdir", inUse],
    ["EPERM", "rename", inUse],
    ["EPERM", "unlink", inUse],
    ["ENOTEMPTY", "rename", inUse],
    ["EACCES", "open", noPermission],
    ["EACCES", "rename", noPermission],
    ["EPERM", "mkdir", noPermission],
    ["EROFS", "open", noPermission],
  ])("says %s from %s in plain words", (code, syscall, message) => {
    expect(plainInstallError(release, asset, failure(code, syscall)).message).toBe(message);
  });
});

describe("which build this machine gets", () => {
  it("names the platform and architecture, with musl only on Linux without glibc", () => {
    expect(standalonePlatformKey("darwin", "arm64", false)).toBe("darwin-arm64");
    expect(standalonePlatformKey("darwin", "x64", true)).toBe("darwin-x64");
    expect(standalonePlatformKey("linux", "x64", false)).toBe("linux-x64");
    expect(standalonePlatformKey("linux", "arm64", true)).toBe("linux-arm64-musl");
    expect(standalonePlatformKey("win32", "arm64", false)).toBe("win32-arm64");
  });

  it("offers only a build made for this exact platform, never a glibc build to a musl machine", () => {
    const asset: StandaloneAsset = { url: "https://downloads.example.test/a", sha256: "0".repeat(64), executableSha256: "1".repeat(64), archive: "raw", executable: "x", approxBytes: 1 };
    const release = fixtureRelease({ "linux-x64": asset });
    expect(standaloneAssetFor(release, "linux-x64")).toBe(asset);
    expect(standaloneAssetFor(release, "linux-x64-musl")).toBeNull();
    expect(standaloneAssetFor(release, "freebsd-x64")).toBeNull();
  });
});

function fixtureRelease(assets: StandaloneRelease["assets"], extra: Partial<StandaloneRelease> = {}): StandaloneRelease {
  return {
    name: "Fake Engine",
    engine: ENGINE,
    version: VERSION,
    hosts: ["downloads.example.test", "assets.example.test"],
    runEnv: { FAKE_RUN_ENV: "app-copy" },
    assets,
    ...extra,
  };
}

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
  chunked?: boolean;
  /** Send this many bytes, then hold the connection open, or drop it. */
  stallAfter?: number;
  dropAfter?: number;
  /** Send the body a few bytes at a time. */
  trickle?: { bytes: number; everyMs: number };
}

function useAssetServer() {
  const routes = new Map<string, Route>();
  const hits = new Map<string, number>();
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const key = req.url!.slice(1);
      hits.set(key, (hits.get(key) ?? 0) + 1);
      const route = routes.get(key);
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      const body = route.body ?? Buffer.alloc(0);
      const partial = route.stallAfter ?? route.dropAfter;
      res.writeHead(route.status ?? 200, { ...(route.chunked || partial !== undefined ? {} : { "content-length": String(body.length) }), ...route.headers });
      if (route.trickle) {
        const { bytes, everyMs } = route.trickle;
        let sent = 0;
        const next = () => {
          res.write(body.subarray(sent, sent + bytes));
          sent += bytes;
          if (sent >= body.length) res.end();
          else setTimeout(next, everyMs);
        };
        next();
        return;
      }
      if (partial === undefined) {
        res.end(body);
        return;
      }
      res.write(body.subarray(0, partial));
      if (route.dropAfter !== undefined) setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  beforeEach(() => {
    routes.clear();
    hits.clear();
  });
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    return fetch(`http://127.0.0.1:${port}/${url.host}${url.pathname}`, init);
  }) as typeof fetch;
  return { routes, hits: (key: string) => hits.get(key) ?? 0, fetchImpl };
}

const DEVELOPER_ID = [
  "=anchor apple generic",
  "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
  "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
];

/** Like codesign: the requirement passes only for a Developer ID certificate Apple issued to the team that signed. */
const signedBy = (team: string): CodesignRunner => async (args) => {
  const requirement = args[args.indexOf("-R") + 1] ?? "";
  const clauses = requirement.split(" and ");
  const ok = DEVELOPER_ID.every((clause) => clauses.includes(clause)) && clauses.includes(`certificate leaf[subject.OU] = "${team}"`);
  return { code: ok ? 0 : 3, output: ok ? "" : "test-requirement: code failed to satisfy specified code requirement(s)" };
};

describe.skipIf(process.platform === "win32")("installing a standalone engine", () => {
  const server = useAssetServer();
  let scratch = "";
  let base = "";
  let log = "";
  let failFlag = "";
  let originalPath: string | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-standalone-"));
    base = join(scratch, "data");
    log = join(scratch, "runs.log");
    failFlag = join(scratch, "fail-for-this-machine");
    originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    resetPathCacheForTests();
    resetStandaloneStateForTests();
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    resetPathCacheForTests();
    resetStandaloneStateForTests();
    await removeTempDir(scratch);
  });

  const engineDir = () => standaloneEngineDir(ENGINE, base);
  const binDir = () => join(engineDir(), "bin");
  const binPath = () => join(binDir(), "fake-engine");
  const leftovers = () => existsSync(engineDir()) ? readdirSync(engineDir()).sort() : [];
  const pathDirs = () => augmentedPath().split(delimiter);
  // The program records each run; it fails, as a broken machine would, while the flag file exists.
  const script = (printed = `fake-engine ${VERSION}`, exit = 0) =>
    `#!/bin/sh\n[ -f '${failFlag}' ] && { echo 'cannot open its data folder' >&2; exit 7; }\necho "$* $FAKE_RUN_ENV \${OPENAI_API_KEY:-nokey}" >> '${log}'\necho '${printed}'\nexit ${exit}\n`;

  async function tarGz(files: Record<string, { data: string; mode: number }>): Promise<Buffer> {
    const source = mkdtempSync(join(scratch, "tar-src-"));
    for (const [name, { data, mode }] of Object.entries(files)) {
      mkdirSync(dirname(join(source, name)), { recursive: true });
      writeFileSync(join(source, name), data);
      chmodSync(join(source, name), mode);
    }
    const file = join(scratch, `fixture-${Math.random().toString(36).slice(2)}.tar.gz`);
    await tar.c({ gzip: true, file, cwd: source, portable: true }, Object.keys(files));
    return readFileSync(file);
  }

  /** Serves `body` the way GitHub does: the release URL redirects to an asset host. */
  function serve(body: Buffer, archive: StandaloneAsset["archive"], executable: string, program: string, overrides: Partial<StandaloneAsset> = {}): StandaloneAsset {
    server.routes.set("downloads.example.test/releases/fake", { status: 302, headers: { location: "https://assets.example.test/blob/fake" } });
    server.routes.set("assets.example.test/blob/fake", { body });
    return { url: "https://downloads.example.test/releases/fake", sha256: sha256(body), executableSha256: sha256(program), archive, executable, approxBytes: body.length, ...overrides };
  }

  async function build(kind: StandaloneAsset["archive"], program = script()): Promise<{ data: Buffer; executable: string; program: string }> {
    if (kind === "zip") return { data: buildZip([{ name: "fake-engine", data: program, mode: 0o100755 }]), executable: "fake-engine", program };
    if (kind === "tar.gz") return { data: await tarGz({ "bin/fake-engine": { data: program, mode: 0o755 } }), executable: "bin/fake-engine", program };
    return { data: Buffer.from(program), executable: "fake-engine", program };
  }

  async function served(kind: StandaloneAsset["archive"] = "raw", overrides: Partial<StandaloneAsset> = {}, program = script()): Promise<StandaloneRelease> {
    const { data, executable } = await build(kind, program);
    return fixtureRelease({ [standalonePlatformKey()]: serve(data, kind, executable, program, overrides) });
  }

  const install = (release: StandaloneRelease, extra: Parameters<typeof installStandaloneEngine>[1] = {}) =>
    installStandaloneEngine(release, { baseDir: base, fetchImpl: server.fetchImpl, ...extra });
  const downloads = () => server.hits("assets.example.test/blob/fake");

  it.each(["zip", "tar.gz", "raw"] as const)("installs a verified %s build behind a stable bin folder at the end of PATH", async (kind) => {
    const { data, executable, program } = await build(kind);
    const asset = serve(data, kind, executable, program);
    const installed = await install(fixtureRelease({ [standalonePlatformKey()]: asset }));

    expect(installed).toEqual({ version: VERSION, executablePath: binPath(), binDir: binDir() });
    expect(readFileSync(binPath(), "utf8")).toBe(program);
    expect(readFileSync(join(engineDir(), VERSION, ...executable.split("/")), "utf8")).toBe(program);
    expect(readdirSync(binDir())).toEqual(["fake-engine"]);
    expect(JSON.parse(readFileSync(join(engineDir(), "current.json"), "utf8"))).toMatchObject({
      version: VERSION, executable, sha256: asset.sha256, executableSha256: sha256(program),
    });
    expect(pathDirs().at(-1)).toBe(binDir());
    expect(findCliCandidates("fake-engine")).toEqual([binPath()]);
    // The version check ran once, with the app copy's run settings.
    expect(readFileSync(log, "utf8")).toBe("--version app-copy nokey\n");
    expect(leftovers()).toEqual([VERSION, "bin", "current.json"]);
  });

  it("clears anything else out of bin/ when it installs, so only the program is on PATH", async () => {
    mkdirSync(binDir(), { recursive: true });
    writeFileSync(join(binDir(), "codex"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
    await install(await served("raw"));
    expect(readdirSync(binDir())).toEqual(["fake-engine"]);
  });

  it("refuses a release that does not pin the program's own hash", async () => {
    const release = await served("raw");
    const { executableSha256: _pin, ...asset } = standaloneAssetFor(release)!;
    await expect(install(fixtureRelease({ [standalonePlatformKey()]: asset as StandaloneAsset }))).rejects.toThrow(/invalid/);
    expect(downloads()).toBe(0);
  });

  it("refuses a download that fails its SHA-256 check and leaves nothing behind", async () => {
    await expect(install(await served("zip", { sha256: "0".repeat(64) }))).rejects.toThrow(/safety check/);
    expect(leftovers()).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });

  it("refuses an archive whose program is not the pinned one, and never runs it", async () => {
    await expect(install(await served("tar.gz", { executableSha256: "0".repeat(64) }))).rejects.toThrow(/safety check/);
    expect(leftovers()).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });

  it.each([["without", true], ["with", false]] as const)("stops a download over twice its expected size, %s a Content-Length", async (_label, chunked) => {
    const body = Buffer.alloc(4096, 1);
    const asset = serve(body, "raw", "fake-engine", script(), { approxBytes: 1000 });
    server.routes.set("assets.example.test/blob/fake", { body, chunked });
    await expect(install(fixtureRelease({ [standalonePlatformKey()]: asset }))).rejects.toThrow(/larger than expected/);
    expect(leftovers()).toEqual([]);
  });

  it("stops a download that stalls, without waiting for the overall time limit", async () => {
    const release = await served("raw");
    server.routes.set("assets.example.test/blob/fake", { body: Buffer.from(script()), stallAfter: 10 });
    await expect(install(release, { stallMs: 300 })).rejects.toThrow(/stopped partway/);
    expect(leftovers()).toEqual([]);
  });

  it("lets a slow download finish while bytes keep arriving", async () => {
    const release = await served("raw");
    server.routes.set("assets.example.test/blob/fake", { body: Buffer.from(script()), trickle: { bytes: 16, everyMs: 120 } });
    await expect(install(release, { stallMs: 400 })).resolves.toMatchObject({ version: VERSION });
  });

  it("refuses a redirect to a host it does not trust, without contacting that host", async () => {
    const release = await served("raw");
    server.routes.set("downloads.example.test/releases/fake", { status: 302, headers: { location: "https://mirror.evil.test/blob/fake" } });
    server.routes.set("mirror.evil.test/blob/fake", { body: Buffer.from(script()) });
    await expect(install(release)).rejects.toThrow(/official site/);
    expect(server.hits("mirror.evil.test/blob/fake")).toBe(0);
    expect(leftovers()).toEqual([]);
  });

  it("refuses plain HTTP, for the first request and for a redirect", async () => {
    const release = await served("raw");
    const asset = standaloneAssetFor(release)!;
    await expect(install(fixtureRelease({ [standalonePlatformKey()]: { ...asset, url: "http://downloads.example.test/releases/fake" } }))).rejects.toThrow(/official site/);
    expect(server.hits("downloads.example.test/releases/fake")).toBe(0);
    server.routes.set("downloads.example.test/releases/fake", { status: 302, headers: { location: "http://assets.example.test/blob/fake" } });
    await expect(install(release)).rejects.toThrow(/official site/);
    expect(downloads()).toBe(0);
  });

  it.each([
    [404, /no longer available to download/],
    [429, /limiting downloads/],
    [503, /isn't answering/],
  ])("explains an HTTP %i answer in plain words", async (status, message) => {
    const release = await served("raw");
    server.routes.set("assets.example.test/blob/fake", { status });
    const error = await refusal(install(release));
    expect(error.message).toMatch(message);
    expect(error.message).not.toMatch(/HTTP|\d{3}/);
    expect(leftovers()).toEqual([]);
  });

  it("explains a dropped connection in plain words", async () => {
    const release = await served("raw");
    server.routes.set("assets.example.test/blob/fake", { body: Buffer.from(script()), dropAfter: 10 });
    const error = await refusal(install(release));
    expect(error.message).toBe("Fake Engine couldn't be downloaded. Check the internet connection and try again.");
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("explains a folder it cannot write to in plain words", async () => {
    const release = await served("raw");
    mkdirSync(engineDir(), { recursive: true });
    chmodSync(engineDir(), 0o500);
    try {
      const error = await refusal(install(release));
      expect(error.message).toBe("OpenMausBot can't write to its folder for Fake Engine. Check the folder's permissions, then try again.");
    } finally {
      chmodSync(engineDir(), 0o700);
    }
  });

  it("shares one download between installs that start together, and reuses the verified copy later", async () => {
    const release = await served("tar.gz");
    const [first, second] = await Promise.all([install(release), install(release)]);
    expect(second).toEqual(first);
    expect(downloads()).toBe(1);
    await install(release);
    expect(downloads()).toBe(1);
  });

  it("reports a copy whose files are intact but that no longer starts, and changes nothing", async () => {
    const release = await served("raw");
    await install(release);
    const pointer = readFileSync(join(engineDir(), "current.json"), "utf8");
    writeFileSync(failFlag, "");
    await expect(install(release)).rejects.toThrow(/doesn't start on this computer \(cannot open its data folder\)/);
    expect(downloads()).toBe(1);
    expect(readFileSync(binPath(), "utf8")).toBe(script());
    expect(readFileSync(join(engineDir(), "current.json"), "utf8")).toBe(pointer);
    expect(leftovers()).toEqual([VERSION, "bin", "current.json"]);
  });

  it("never runs or keeps a swapped program, even one that prints the right version", async () => {
    const release = await served("raw");
    await install(release);
    // The bin entry and the version folder share one file, so this swaps both.
    writeFileSync(binPath(), `#!/bin/sh\necho TAMPERED >> '${log}'\necho 'fake-engine ${VERSION}'\n`);
    await install(release);
    expect(downloads()).toBe(2);
    expect(readFileSync(log, "utf8")).not.toContain("TAMPERED");
    expect(readFileSync(binPath(), "utf8")).toBe(script());
  });

  it("keeps the installed copy when its replacement fails too", async () => {
    const release = await served("raw");
    await install(release);
    writeFileSync(binPath(), "#!/bin/sh\necho changed\n");
    writeFileSync(failFlag, "");
    await expect(install(release)).rejects.toThrow(/doesn't start on this computer/);
    expect(downloads()).toBe(2);
    expect(readFileSync(binPath(), "utf8")).toBe("#!/bin/sh\necho changed\n");
    expect(existsSync(join(engineDir(), VERSION, "fake-engine"))).toBe(true);
    expect(leftovers()).toEqual([VERSION, "bin", "current.json"]);
  });

  it("checks a macOS build's Developer ID signer at install and again before reusing it", async () => {
    const { data, executable, program } = await build("zip");
    const release = fixtureRelease({ "darwin-arm64": serve(data, "zip", executable, program) }, { macTeamId: "PINNED0001" });
    const mac = { platformKey: "darwin-arm64" };
    await expect(install(release, { ...mac, codesign: signedBy("OTHER00001") })).rejects.toThrow(/not signed by its maker/);
    expect(leftovers()).toEqual([]);
    await expect(install(release, { ...mac, codesign: signedBy("PINNED0001") })).resolves.toMatchObject({ version: VERSION });
    // The installed copy no longer passes: it is downloaded again, and the new one fails the same check, so the old stays.
    await expect(install(release, { ...mac, codesign: signedBy("OTHER00001") })).rejects.toThrow(/not signed by its maker/);
    expect(downloads()).toBe(3);
    expect(readFileSync(binPath(), "utf8")).toBe(script());
  });

  it.each([["exits with an error", script(`fake-engine ${VERSION}`, 1)], ["reports another version", script("fake-engine 9.9.9")]])("refuses a build that %s, and keeps none of it", async (_label, program) => {
    await expect(install(await served("raw", {}, program))).rejects.toThrow(/doesn't start on this computer/);
    expect(leftovers()).toEqual([]);
  });

  it("never hands provider keys to the version check", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-must-not-leak";
    try {
      await install(await served("raw"));
      expect(readFileSync(log, "utf8")).toBe("--version app-copy nokey\n");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it("gives every file from a tar.gz plain permissions, whatever the archive says", async () => {
    const program = script();
    const data = await tarGz({
      "bin/fake-engine": { data: program, mode: 0o4777 },
      "bin/helper": { data: "#!/bin/sh\n", mode: 0o700 },
      "share/notes": { data: "x", mode: 0o600 },
    });
    await install(fixtureRelease({ [standalonePlatformKey()]: serve(data, "tar.gz", "bin/fake-engine", program) }));
    expect(statSync(join(engineDir(), VERSION, "bin", "fake-engine")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(engineDir(), VERSION, "bin", "helper")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(engineDir(), VERSION, "share", "notes")).mode & 0o7777).toBe(0o644);
  });

  it("refuses a release whose version or executable could leave its folder", async () => {
    const release = await served("raw");
    const asset = standaloneAssetFor(release)!;
    await expect(install({ ...release, version: "../1.2.3" })).rejects.toThrow(/invalid/);
    await expect(install(fixtureRelease({ [standalonePlatformKey()]: { ...asset, executable: "../fake-engine" } }))).rejects.toThrow(/invalid/);
    expect(server.hits("downloads.example.test/releases/fake")).toBe(0);
  });

  it("refuses a tar.gz holding a link, and keeps none of it", async () => {
    const source = mkdtempSync(join(scratch, "tar-link-"));
    writeFileSync(join(source, "fake-engine"), script(), { mode: 0o755 });
    symlinkSync("/etc/hosts", join(source, "hosts"));
    const file = join(scratch, "link.tar.gz");
    await tar.c({ gzip: true, file, cwd: source, portable: true }, ["fake-engine", "hosts"]);
    await expect(install(fixtureRelease({ [standalonePlatformKey()]: serve(readFileSync(file), "tar.gz", "fake-engine", script()) }))).rejects.toThrow(/unsafe/);
    expect(leftovers()).toEqual([]);
  });

  it("clears what an interrupted install left before it starts", async () => {
    mkdirSync(join(engineDir(), ".staging-old", "deep"), { recursive: true });
    mkdirSync(binDir(), { recursive: true });
    for (const leftover of [join(engineDir(), ".download-old.part"), join(engineDir(), "current.json.123.abc.tmp"), join(binDir(), ".new-old")]) writeFileSync(leftover, "");
    await expect(install(await served("raw", { sha256: "0".repeat(64) }))).rejects.toThrow(/safety check/);
    expect(leftovers()).toEqual(["bin"]);
    expect(readdirSync(binDir())).toEqual([]);
  });

  describe("whose copy runs", () => {
    it("lets a copy the person installed win, and gives run settings to the app's copy only", async () => {
      const installed = await install(await served("raw"));
      const own = join(scratch, "own-bin");
      mkdirSync(own);
      writeFileSync(join(own, "fake-engine"), script(), { mode: 0o755 });
      process.env.PATH = `${own}${delimiter}/usr/bin`;
      resetPathCache();
      expect(findCliCandidates("fake-engine")).toEqual([join(own, "fake-engine"), installed.executablePath]);
      const release = fixtureRelease({});
      expect(standaloneRunEnv(release, "fake-engine", base)).toEqual({});
      expect(standaloneRunEnv(release, join(own, "fake-engine"), base)).toEqual({});
      expect(standaloneRunEnv(release, installed.executablePath, base)).toEqual({ FAKE_RUN_ENV: "app-copy" });
      expect(isAppStandaloneCopy("fake-engine", base)).toBe(false);
      expect(isAppStandaloneCopy(installed.executablePath, base)).toBe(true);
    });

    it("recognises the app's copy however its folder is spelled", async () => {
      const installed = await install(await served("raw"));
      const linked = join(scratch, "linked-data");
      symlinkSync(base, linked);
      const release = fixtureRelease({});
      expect(standaloneRunEnv(release, realpathSync(installed.executablePath), base)).toEqual({ FAKE_RUN_ENV: "app-copy" });
      expect(standaloneRunEnv(release, installed.executablePath, linked)).toEqual({ FAKE_RUN_ENV: "app-copy" });
      expect(standaloneRunEnv(release, join(linked, "tools", "standalone", ENGINE, "bin", "fake-engine"), base)).toEqual({ FAKE_RUN_ENV: "app-copy" });
    });
  });

  describe("a person's files behind a link", () => {
    /** A folder of the person's own, which no install may touch. */
    function personsFolder(): string {
      const folder = join(scratch, "person");
      mkdirSync(join(folder, "projects", "alpha"), { recursive: true });
      mkdirSync(join(folder, "beta"), { recursive: true });
      writeFileSync(join(folder, "notes.txt"), "mine");
      writeFileSync(join(folder, "projects", "alpha", "plan.md"), "mine");
      writeFileSync(join(folder, ".old-notes"), "mine");
      writeFileSync(join(folder, ".new-draft"), "mine");
      writeFileSync(join(folder, ".download-list.part"), "mine");
      mkdirSync(join(folder, ".staging-area"));
      return folder;
    }
    const untouched = (folder: string) => {
      for (const file of ["notes.txt", "projects/alpha/plan.md", ".old-notes", ".new-draft", ".download-list.part"]) {
        expect(readFileSync(join(folder, ...file.split("/")), "utf8"), file).toBe("mine");
      }
      expect(existsSync(join(folder, "beta"))).toBe(true);
      expect(existsSync(join(folder, ".staging-area"))).toBe(true);
    };

    it("refuses to install when bin/ is a link, and deletes nothing it points to", async () => {
      const release = await served("raw");
      const folder = personsFolder();
      mkdirSync(engineDir(), { recursive: true });
      symlinkSync(folder, binDir());
      await expect(install(release)).rejects.toThrow(/not a plain folder/);
      untouched(folder);
    });

    it("refuses to install when the engine's folder is a link, and deletes nothing it points to", async () => {
      const release = await served("raw");
      const folder = personsFolder();
      mkdirSync(dirname(engineDir()), { recursive: true });
      symlinkSync(folder, engineDir());
      await expect(install(release)).rejects.toThrow(/not a plain folder/);
      untouched(folder);
    });

    it("refuses to install when the standalone folder itself is a link", async () => {
      const release = await served("raw");
      const folder = personsFolder();
      mkdirSync(dirname(dirname(engineDir())), { recursive: true });
      symlinkSync(folder, dirname(engineDir()));
      await expect(install(release)).rejects.toThrow(/not a plain folder/);
      untouched(folder);
    });

    it("sweeps nothing through a linked folder at start-up", async () => {
      const release = await served("raw");
      await install(release);
      const folder = personsFolder();
      rmSync(binDir(), { recursive: true });
      symlinkSync(folder, binDir());
      registerStandaloneBinDirs(base, [release]);
      untouched(folder);
      rmSync(folder, { recursive: true });
      const engineFolder = personsFolder();
      rmSync(engineDir(), { recursive: true });
      symlinkSync(engineFolder, engineDir());
      registerStandaloneBinDirs(base, [release]);
      untouched(engineFolder);
    });

    it("refuses when bin/ becomes a link while the download runs, and deletes nothing it points to", async () => {
      const release = await served("raw");
      await install(release);
      // A changed program makes the next install download again, which is when bin/ is swapped.
      writeFileSync(binPath(), "#!/bin/sh\necho changed\n");
      const folder = personsFolder();
      const swapping = ((input: string | URL, init?: RequestInit) => {
        if (realDirectoryNow(binDir())) {
          rmSync(binDir(), { recursive: true });
          symlinkSync(folder, binDir());
        }
        return server.fetchImpl(input, init);
      }) as typeof fetch;
      await expect(install(release, { fetchImpl: swapping })).rejects.toThrow(/not a plain folder/);
      untouched(folder);
    });

    it("sweeps nothing at start-up when the standalone folder itself is a link", () => {
      const folder = personsFolder();
      mkdirSync(join(folder, ENGINE, "bin"), { recursive: true });
      writeFileSync(join(folder, ENGINE, ".download-mine.part"), "mine");
      writeFileSync(join(folder, ENGINE, "bin", ".old-mine"), "mine");
      mkdirSync(dirname(dirname(engineDir())), { recursive: true });
      symlinkSync(folder, dirname(engineDir()));
      registerStandaloneBinDirs(base, [fixtureRelease({})]);
      expect(readFileSync(join(folder, ENGINE, ".download-mine.part"), "utf8")).toBe("mine");
      expect(readFileSync(join(folder, ENGINE, "bin", ".old-mine"), "utf8")).toBe("mine");
    });

    it.skipIf(process.getuid?.() === 0)("leaves a copy whose bin/ it can't read off PATH at start-up, and never stops the server", async () => {
      const release = await served("raw");
      await install(release);
      chmodSync(binDir(), 0o000);
      try {
        expect(() => registerStandaloneBinDirs(base, [release])).not.toThrow();
      } finally {
        chmodSync(binDir(), 0o755);
      }
    });

    it("never removes a folder from bin/, only plain files", async () => {
      mkdirSync(join(binDir(), "projects"), { recursive: true });
      writeFileSync(join(binDir(), "projects", "plan.md"), "mine");
      await expect(install(await served("raw"))).rejects.toThrow(/holds something/);
      expect(readFileSync(join(binDir(), "projects", "plan.md"), "utf8")).toBe("mine");
    });

    it("prunes only folders whose own install record names this engine and version", async () => {
      mkdirSync(join(engineDir(), "alpha"), { recursive: true });
      writeFileSync(join(engineDir(), "alpha", "plan.md"), "mine");
      mkdirSync(join(engineDir(), "0.9.0"), { recursive: true });
      writeFileSync(join(engineDir(), "0.9.0", ".standalone-install.json"), JSON.stringify({ engine: "another-engine", version: "0.9.0", sha256: "a".repeat(64), executable: "fake-engine", executableSha256: "b".repeat(64), installedAt: 1 }));
      mkdirSync(join(engineDir(), "0.8.0"), { recursive: true });
      writeFileSync(join(engineDir(), "0.8.0", ".standalone-install.json"), JSON.stringify({ engine: ENGINE, version: "0.7.0", sha256: "a".repeat(64), executable: "fake-engine", executableSha256: "b".repeat(64), installedAt: 1 }));
      await install(await served("raw"));
      expect(readFileSync(join(engineDir(), "alpha", "plan.md"), "utf8")).toBe("mine");
      expect(existsSync(join(engineDir(), "0.9.0"))).toBe(true);
      expect(existsSync(join(engineDir(), "0.8.0"))).toBe(true);
    });
  });

  describe("old versions", () => {
    function seedVersion(version: string, installedAt: number): string {
      const directory = join(engineDir(), version);
      const program = script(`fake-engine ${version}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "fake-engine"), program, { mode: 0o755 });
      writeFileSync(join(directory, ".standalone-install.json"), JSON.stringify({
        engine: ENGINE, version, sha256: "a".repeat(64), executable: "fake-engine", executableSha256: sha256(program), installedAt,
      }));
      return program;
    }
    function makeCurrent(version: string, program: string): void {
      mkdirSync(binDir(), { recursive: true });
      linkSync(join(engineDir(), version, "fake-engine"), binPath());
      writeFileSync(join(engineDir(), "current.json"), JSON.stringify({ version, executable: "fake-engine", sha256: "a".repeat(64), executableSha256: sha256(program) }));
    }

    it("keeps the new version and the one before it, and deletes older ones", async () => {
      seedVersion("1.0.0", 1);
      makeCurrent("1.1.0", seedVersion("1.1.0", 2));
      await install(await served("raw"));
      expect(leftovers()).toEqual(["1.1.0", VERSION, "bin", "current.json"]);
    });

    it("never deletes a version this server started with, since its processes may still be running", async () => {
      const older = seedVersion("1.0.0", 1);
      makeCurrent("1.0.0", older);
      seedVersion("1.1.0", 2);
      const release = { ...(await served("raw")), previousPrograms: { [standalonePlatformKey()]: [sha256(older)] } };
      registerStandaloneBinDirs(base, [release]);
      await install(release);
      expect(leftovers()).toEqual(["1.0.0", "1.1.0", VERSION, "bin", "current.json"]);
      // After a restart nothing runs 1.0.0 any more.
      resetStandaloneStateForTests();
      await install(release);
      expect(leftovers()).toEqual(["1.1.0", VERSION, "bin", "current.json"]);
    });

    it("keeps a copy from an earlier pin on PATH only while the code lists its program", async () => {
      const older = seedVersion("1.0.0", 1);
      makeCurrent("1.0.0", older);
      const release = await served("raw");
      // Its own record vouches for itself, which is not enough.
      registerStandaloneBinDirs(base, [release]);
      expect(pathDirs()).not.toContain(binDir());
      const listed = { ...release, previousPrograms: { [standalonePlatformKey()]: [sha256(older)] } };
      resetPathCacheForTests();
      registerStandaloneBinDirs(base, [listed]);
      expect(pathDirs().at(-1)).toBe(binDir());
      writeFileSync(binPath(), "#!/bin/sh\necho changed\n");
      resetPathCacheForTests();
      registerStandaloneBinDirs(base, [listed]);
      expect(pathDirs()).not.toContain(binDir());
    });
  });

  describe("at start-up", () => {
    const boot = (releases: StandaloneRelease[]) => {
      resetPathCacheForTests();
      resetStandaloneStateForTests();
      registerStandaloneBinDirs(base, releases);
    };

    it("puts a known engine's verified bin folder at the end of PATH", async () => {
      const release = await served("tar.gz");
      const installed = await install(release);
      boot([release]);
      expect(pathDirs().at(-1)).toBe(installed.binDir);
    });

    it("ignores an engine this app does not pin, such as a planted git", async () => {
      const release = await served("raw");
      await install(release);
      const planted = standaloneEngineDir("git", base);
      const program = "#!/bin/sh\necho planted\n";
      mkdirSync(join(planted, "1"), { recursive: true });
      mkdirSync(join(planted, "bin"), { recursive: true });
      writeFileSync(join(planted, "1", "git"), program, { mode: 0o755 });
      linkSync(join(planted, "1", "git"), join(planted, "bin", "git"));
      writeFileSync(join(planted, "1", ".standalone-install.json"), JSON.stringify({ engine: "git", version: "1", sha256: "a".repeat(64), executable: "git", executableSha256: sha256(program), installedAt: 1 }));
      writeFileSync(join(planted, "current.json"), JSON.stringify({ version: "1", executable: "git", sha256: "a".repeat(64), executableSha256: sha256(program) }));
      boot([release]);
      expect(pathDirs()).not.toContain(join(planted, "bin"));
      expect(findCliCandidates("git")).not.toContain(join(planted, "bin", "git"));
    });

    it.each([["unlisted", false], ["listed", true]])("ignores a planted record that names another program, even with its hash %s", async (_label, listed) => {
      const release = await served("raw");
      const program = "#!/bin/sh\necho planted codex\n";
      mkdirSync(join(engineDir(), "0.0.1"), { recursive: true });
      mkdirSync(binDir(), { recursive: true });
      writeFileSync(join(engineDir(), "0.0.1", "codex"), program, { mode: 0o755 });
      linkSync(join(engineDir(), "0.0.1", "codex"), join(binDir(), "codex"));
      writeFileSync(join(engineDir(), "0.0.1", ".standalone-install.json"), JSON.stringify({ engine: ENGINE, version: "0.0.1", sha256: "a".repeat(64), executable: "codex", executableSha256: sha256(program), installedAt: 1 }));
      writeFileSync(join(engineDir(), "current.json"), JSON.stringify({ version: "0.0.1", executable: "codex", sha256: "a".repeat(64), executableSha256: sha256(program) }));
      boot([listed ? { ...release, previousPrograms: { [standalonePlatformKey()]: [sha256(program)] } } : release]);
      expect(pathDirs()).not.toContain(binDir());
      expect(findCliCandidates("codex")).not.toContain(join(binDir(), "codex"));
    });

    it("ignores a record whose program sits elsewhere in its folder than the pin says, even with the same name", async () => {
      const release = await served("raw");
      const program = "#!/bin/sh\necho elsewhere\n";
      mkdirSync(join(engineDir(), "0.0.1", "other"), { recursive: true });
      mkdirSync(binDir(), { recursive: true });
      writeFileSync(join(engineDir(), "0.0.1", "other", "fake-engine"), program, { mode: 0o755 });
      linkSync(join(engineDir(), "0.0.1", "other", "fake-engine"), binPath());
      writeFileSync(join(engineDir(), "0.0.1", ".standalone-install.json"), JSON.stringify({ engine: ENGINE, version: "0.0.1", sha256: "a".repeat(64), executable: "other/fake-engine", executableSha256: sha256(program), installedAt: 1 }));
      writeFileSync(join(engineDir(), "current.json"), JSON.stringify({ version: "0.0.1", executable: "other/fake-engine", sha256: "a".repeat(64), executableSha256: sha256(program) }));
      boot([{ ...release, previousPrograms: { [standalonePlatformKey()]: [sha256(program)] } }]);
      expect(pathDirs()).not.toContain(binDir());
    });

    it.each(["current.json", "bin"])("never puts a leftover back under the reserved name %s", async (reserved) => {
      const release = await served("raw");
      await install(release);
      rmSync(join(engineDir(), reserved), { recursive: true, force: true });
      const aside = join(engineDir(), ".old-planted");
      mkdirSync(aside);
      writeFileSync(join(aside, ".standalone-install.json"), JSON.stringify({ engine: ENGINE, version: reserved, sha256: "a".repeat(64), executable: "fake-engine", executableSha256: "b".repeat(64), installedAt: 1 }));
      boot([release]);
      expect(existsSync(aside)).toBe(false);
      expect(existsSync(join(engineDir(), reserved))).toBe(false);
    });

    it.each([
      ["its program was changed", () => writeFileSync(binPath(), "#!/bin/sh\necho changed\n")],
      ["its bin folder holds anything else", () => writeFileSync(join(binDir(), "git"), "#!/bin/sh\n", { mode: 0o755 })],
      ["its current.json is a link", () => {
        const real = join(scratch, "elsewhere.json");
        renameSync(join(engineDir(), "current.json"), real);
        symlinkSync(real, join(engineDir(), "current.json"));
      }],
      ["its program is a link", () => {
        renameSync(binPath(), join(scratch, "moved"));
        symlinkSync(join(scratch, "moved"), binPath());
      }],
    ])("keeps the app's copy off PATH when %s", async (_label, change) => {
      const release = await served("raw");
      await install(release);
      change();
      boot([release]);
      expect(pathDirs()).not.toContain(binDir());
    });

    it("finishes an interrupted swap and clears the other leftovers", async () => {
      const release = await served("raw");
      await install(release);
      // Stopped between moving the old folder aside and moving the new one in.
      renameSync(join(engineDir(), VERSION), join(engineDir(), ".old-interrupted"));
      mkdirSync(join(engineDir(), ".staging-old"));
      for (const leftover of [join(engineDir(), ".download-old.part"), join(engineDir(), "current.json.1.x.tmp"), join(binDir(), ".old-x")]) writeFileSync(leftover, "");
      boot([release]);
      expect(leftovers()).toEqual([VERSION, "bin", "current.json"]);
      expect(readdirSync(binDir())).toEqual(["fake-engine"]);
      expect(pathDirs().at(-1)).toBe(binDir());
    });
  });
});
