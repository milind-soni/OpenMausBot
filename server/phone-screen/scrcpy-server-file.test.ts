import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { ensureScrcpyServer } from "./scrcpy-server-file.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const SERVER_FILE = Buffer.from("the scrcpy server file");
const noNetwork: typeof fetch = async () => {
  throw new Error("no request was expected");
};

describe("ensureScrcpyServer", () => {
  let dataDir = "";
  let release: Server | undefined;

  afterEach(async () => {
    release?.closeAllConnections();
    release?.close();
    release = undefined;
    await removeTempDir(dataDir);
  });

  /** A release page that redirects /download to the file, as GitHub's does, and counts the downloads it served. */
  async function releaseOf(body: Buffer | { status: number }, digest = sha256(SERVER_FILE)) {
    dataDir = mkdtempSync(join(tmpdir(), "omb-scrcpy-file-"));
    const served = { downloads: 0 };
    release = createServer((request, response) => {
      if (request.url === "/download") {
        response.writeHead(302, { location: "/file" }).end();
        return;
      }
      served.downloads += 1;
      if (Buffer.isBuffer(body)) response.end(body);
      else response.writeHead(body.status).end();
    });
    await new Promise<void>((resolve) => release!.listen(0, "127.0.0.1", resolve));
    const { port } = release.address() as AddressInfo;
    const source = { version: "9.9.9", sha256: digest, url: `http://127.0.0.1:${port}/download` };
    return { served, source, file: join(dataDir, "scrcpy", "scrcpy-server-v9.9.9") };
  }

  const filesIn = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

  it("downloads the file once, verifies it and keeps it private", async () => {
    const { served, source, file } = await releaseOf(SERVER_FILE);

    await expect(ensureScrcpyServer(dataDir, { source })).resolves.toBe(file);
    expect(readFileSync(file)).toEqual(SERVER_FILE);
    expect(filesIn(dataDir)).toEqual(["scrcpy", join("scrcpy", "scrcpy-server-v9.9.9")]);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "scrcpy")).mode & 0o777).toBe(0o700);
    }

    await expect(ensureScrcpyServer(dataDir, { source, fetch: noNetwork })).resolves.toBe(file);
    expect(served.downloads).toBe(1);
  });

  it("shares one download between two first calls", async () => {
    const { served, source, file } = await releaseOf(SERVER_FILE);

    await expect(Promise.all([ensureScrcpyServer(dataDir, { source }), ensureScrcpyServer(dataDir, { source })])).resolves.toEqual([file, file]);
    expect(served.downloads).toBe(1);
  });

  it("replaces a file with the wrong digest once a verified download arrived", async () => {
    const { served, source, file } = await releaseOf(SERVER_FILE);
    mkdirSync(join(dataDir, "scrcpy"));
    writeFileSync(file, "another version", { mode: 0o644 });

    await expect(ensureScrcpyServer(dataDir, { source })).resolves.toBe(file);
    expect(readFileSync(file)).toEqual(SERVER_FILE);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(served.downloads).toBe(1);
  });

  it("removes a file with the wrong digest when no verified download replaces it", async () => {
    const { source, file } = await releaseOf({ status: 404 });
    mkdirSync(join(dataDir, "scrcpy"));
    writeFileSync(file, "another version");

    await expect(ensureScrcpyServer(dataDir, { source })).rejects.toThrow("HTTP 404");
    expect(filesIn(dataDir)).toEqual(["scrcpy"]);
  });

  it("leaves a saved file it cannot read where it is, and downloads nothing", async () => {
    const { served, source, file } = await releaseOf(SERVER_FILE);
    mkdirSync(file, { recursive: true });

    await expect(ensureScrcpyServer(dataDir, { source })).rejects.toThrow(`Could not read ${file}, so it was left as it is: EISDIR`);
    expect(filesIn(dataDir)).toEqual(["scrcpy", join("scrcpy", "scrcpy-server-v9.9.9")]);
    expect(served.downloads).toBe(0);
  });

  it("downloads again after a download failed", async () => {
    const { served, source } = await releaseOf({ status: 404 });

    await expect(ensureScrcpyServer(dataDir, { source })).rejects.toThrow("HTTP 404");
    await expect(ensureScrcpyServer(dataDir, { source })).rejects.toThrow("HTTP 404");
    expect(served.downloads).toBe(2);
  });

  it("accepts a file of exactly 4 MiB", async () => {
    const largest = Buffer.alloc(4 * 1024 * 1024);
    const { source, file } = await releaseOf(largest, sha256(largest));

    await expect(ensureScrcpyServer(dataDir, { source })).resolves.toBe(file);
  });

  it.each([
    ["has another digest than the pinned one", Buffer.from("tampered"), `has SHA-256 ${sha256(Buffer.from("tampered"))}, not the expected ${sha256(SERVER_FILE)}`],
    ["cannot be downloaded", { status: 404 }, "HTTP 404"],
    ["is larger than 4 MiB", Buffer.alloc(4 * 1024 * 1024 + 1), "the file is larger than 4 MiB"],
  ])("saves nothing when the file %s, and says where to put a copy by hand", async (_what, body, reason) => {
    const { source, file } = await releaseOf(body);

    const failure = await ensureScrcpyServer(dataDir, { source }).then(() => "", (error: Error) => error.message);
    expect(failure).toContain(reason);
    expect(failure).toContain(`save scrcpy-server 9.9.9 as ${file}`);
    expect(filesIn(dataDir)).toEqual([]);
  });
});
