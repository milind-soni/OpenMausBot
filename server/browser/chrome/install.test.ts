import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { chromeForTestingDirectory, chromeForTestingExecutable, chromeForTestingPin, chromeForTestingUrl, downloadArchive, installChromeForTesting, type ChromeForTestingPin, type DownloadProgress, type Extract } from "./install.ts";

const ARCHIVE = Buffer.from("not a real zip, but the bytes the pin names ".repeat(4_000));
const SHA256 = createHash("sha256").update(ARCHIVE).digest("hex");
const RELATIVE = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

let server: Server;
let base = "";
let requests = 0;
/** path → how the server answers it. */
const routes = new Map<string, (response: import("node:http").ServerResponse) => void>();
const folders: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    requests++;
    const route = routes.get(request.url ?? "");
    if (route) return route(response);
    response.writeHead(200, { "content-length": ARCHIVE.length });
    response.end(ARCHIVE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const folder of folders) await removeTempDir(folder);
});
afterEach(() => { routes.clear(); requests = 0; });

const pin = (overrides: Partial<ChromeForTestingPin> = {}): ChromeForTestingPin => ({ version: "153.0.8010.47", platform: "mac-arm64", bytes: ARCHIVE.length, sha256: SHA256, ...overrides });
const dataDir = () => { const folder = mkdtempSync(join(tmpdir(), "omb-cft-")); folders.push(folder); return folder; };
/** Unpacks only after reading the whole archive, as unzip does. */
const extract: Extract = async (archive, directory) => {
  expect(readFileSync(archive).equals(ARCHIVE)).toBe(true);
  mkdirSync(dirname(join(directory, RELATIVE)), { recursive: true });
  writeFileSync(join(directory, RELATIVE), "#!/bin/sh\n", { mode: 0o755 });
};
const leftovers = (root: string) => readdirSync(join(root, "tools", "chrome", "153.0.8010.47")).filter((name) => name.endsWith(".part"));

describe("downloading Chrome for Testing", () => {
  it("checks size and SHA-256 before unpacking, then moves the whole browser into place at once", async () => {
    const root = dataDir();
    const progress: DownloadProgress[] = [];
    const path = await installChromeForTesting({ dataDir: root, pin: pin(), url: `${base}/ok.zip`, extract, onProgress: (step) => progress.push(step) });
    expect(path).toBe(chromeForTestingExecutable(root, pin()));
    expect(existsSync(path)).toBe(true);
    expect(leftovers(root)).toEqual([]);
    expect(progress.at(-1)).toEqual({ received: ARCHIVE.length, total: ARCHIVE.length });
    expect(progress.every((step, index) => index === 0 || step.received >= progress[index - 1]!.received)).toBe(true);
    expect(await installChromeForTesting({ dataDir: root, pin: pin(), url: `${base}/again.zip`, extract })).toBe(path);
    expect(requests).toBe(1);
  });

  it("installs nothing when the bytes do not match the pinned SHA-256", async () => {
    const root = dataDir();
    await expect(installChromeForTesting({ dataDir: root, pin: pin({ sha256: "0".repeat(64) }), url: `${base}/ok.zip`, extract }))
      .rejects.toThrow(/SHA-256 check; nothing was installed/);
    expect(existsSync(chromeForTestingDirectory(root, pin()))).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  it("refuses a download whose size is not the pinned size, declared or streamed", async () => {
    const root = dataDir();
    await expect(installChromeForTesting({ dataDir: root, pin: pin({ bytes: ARCHIVE.length - 1 }), url: `${base}/ok.zip`, extract })).rejects.toThrow(/pinned size/);
    routes.set("/longer.zip", (response) => { response.writeHead(200); response.end(Buffer.concat([ARCHIVE, Buffer.from("tail")])); });
    await expect(installChromeForTesting({ dataDir: root, pin: pin(), url: `${base}/longer.zip`, extract })).rejects.toThrow(/larger than its pinned size/);
    routes.set("/shorter.zip", (response) => { response.writeHead(200); response.end(ARCHIVE.subarray(0, 100)); });
    await expect(installChromeForTesting({ dataDir: root, pin: pin(), url: `${base}/shorter.zip`, extract })).rejects.toThrow(/ended early/);
    routes.set("/missing.zip", (response) => { response.writeHead(404); response.end(); });
    await expect(installChromeForTesting({ dataDir: root, pin: pin(), url: `${base}/missing.zip`, extract })).rejects.toThrow(/HTTP 404/);
    expect(existsSync(chromeForTestingDirectory(root, pin()))).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  it("fails the download, without an unhandled rejection, when the archive cannot be written while the request is pending", async () => {
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", note);
    try {
      const signals: AbortSignal[] = [];
      const fetchImpl = ((_url: string, init: RequestInit) => new Promise<Response>((resolve) => {
        signals.push(init.signal!);
        setTimeout(() => resolve(new Response(ARCHIVE, { headers: { "content-length": String(ARCHIVE.length) } })), 50);
      })) as typeof fetch;
      const destination = join(dataDir(), "no-such-folder", "chrome.zip.part");
      await expect(downloadArchive(`${base}/ok.zip`, destination, ARCHIVE.length, { fetchImpl })).rejects.toMatchObject({ code: "ENOENT" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      process.off("unhandledRejection", note);
    }
  });

  it("fails at once, aborting the request, when the archive cannot be written while the body stalls", async () => {
    let aborted = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) { init.signal!.addEventListener("abort", () => { aborted = true; stream.error(init.signal!.reason); }); },
      });
      return new Response(body, { headers: { "content-length": String(ARCHIVE.length) } });
    }) as typeof fetch;
    const destination = join(dataDir(), "no-such-folder", "chrome.zip.part");
    const started = Date.now();
    await expect(downloadArchive(`${base}/ok.zip`, destination, ARCHIVE.length, { fetchImpl, timeoutMs: 5_000 })).rejects.toMatchObject({ code: "ENOENT" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
  });

  it("refuses an archive that does not hold the browser where its layout says", async () => {
    const root = dataDir();
    await expect(installChromeForTesting({ dataDir: root, pin: pin(), url: `${base}/ok.zip`, extract: async (_archive, directory) => { mkdirSync(directory, { recursive: true }); } }))
      .rejects.toThrow(/did not hold the browser/);
    expect(existsSync(chromeForTestingDirectory(root, pin()))).toBe(false);
  });

  it("shares one download between callers, and clears what an interrupted one left, never another's live download", async () => {
    const root = dataDir();
    const version = join(root, "tools", "chrome", "153.0.8010.47");
    mkdirSync(join(version, "mac-arm64.dead.part"), { recursive: true });
    writeFileSync(join(version, "mac-arm64.dead.zip.part"), "half");
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    for (const name of ["mac-arm64.dead.part", "mac-arm64.dead.zip.part"]) utimesSync(join(version, name), hourAgo, hourAgo);
    writeFileSync(join(version, "mac-arm64.live.zip.part"), "still arriving");
    const [first, second] = await Promise.all([
      installChromeForTesting({ dataDir: root, pin: pin(), url: `${base}/shared.zip`, extract }),
      installChromeForTesting({ dataDir: root, pin: pin(), url: `${base}/shared.zip`, extract }),
    ]);
    expect(first).toBe(second);
    expect(requests).toBe(1);
    expect(leftovers(root)).toEqual(["mac-arm64.live.zip.part"]);
  });

  it("downloads from Google's Chrome for Testing bucket, by pinned version and platform", () => {
    expect(chromeForTestingUrl(pin())).toBe("https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.47/mac-arm64/chrome-mac-arm64.zip");
    expect(chromeForTestingPin("darwin", "arm64")).toMatchObject({ platform: "mac-arm64", bytes: 190878359 });
    expect(chromeForTestingPin("linux", "x64")).toBeNull();
  });
});
