// A loopback Boat stands in for the provider, for the Cloud's relay and for the sandbox that serves transfer links; every
// folder is a fresh temporary one.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";

const BOX = "bx_23456789";
const OWN = "synthetic-own-key";
const INCLUDED = "synthetic-included-key";
const MiB = 1024 * 1024;
let server: Server;
let base: string;
let files: typeof import("./cloud-computer-files.ts");
let tools: typeof import("./cloud-computer-tools.ts");
let journal: typeof import("./boat-delete-journal.ts");
type Call = { method: string; path: string; body: any; authorization?: string; contentLength?: string };
const calls: Call[] = [];
/** What the computer holds, by path; `declared: false` streams it without a length, `lies` declares another one. */
const disk = new Map<string, { bytes: Buffer; declared?: boolean; lies?: number }>();
/** Every link minted, so a test can check none of them leaks. */
const minted: string[] = [];
/** Overrides the next mint's answer. */
let mintAnswer: ((kind: string) => { status: number; body: unknown }) | undefined;
/** Runs while the sandbox answers a download, before any byte is sent. */
let duringDownload: (() => void) | undefined;
/** Runs once the sandbox has sent the first half of a download. */
let midDownload: (() => Promise<void>) | undefined;
/** Runs when the sandbox gets an upload's first bytes. */
let onFirstUploadChunk: (() => void) | undefined;
/** Holds the sandbox's answer to a transfer until released. */
let stall: Promise<void> | undefined;
/** What the sandbox received for each upload, by path. */
const uploads = new Map<string, { bytes: number; chunks: number; tail: Buffer; head: Buffer }>();
/** The sandbox turns every link away, as it does an expired one. */
let expireLinks = false;
let dataDir: string;
let root: string;
let folder: string;
let outside: string;
const own: AppConfig = { box: { token: OWN } } as AppConfig;
const signal = () => new AbortController().signal;

async function sandbox(req: IncomingMessage, res: ServerResponse, url: URL) {
  const [, , verb, token] = url.pathname.split("/");
  const path = Buffer.from(token ?? "", "base64url").toString("utf8").split("|")[0]!;
  if (expireLinks) {
    // A sandbox's refusal may name the link; the copy must never pass that on.
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, message: `link ${url.href} expired` }));
    req.resume();
    return;
  }
  await stall;
  if (verb === "get" && req.method === "GET") {
    duringDownload?.();
    const file = disk.get(path);
    if (!file) { res.writeHead(404); res.end(`no file behind ${url.href}`); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", ...(file.declared === false ? {} : { "content-length": String(file.lies ?? file.bytes.length) }) });
    for (let at = 0; at < file.bytes.length; at += MiB) {
      if (at === Math.floor(file.bytes.length / 2 / MiB) * MiB && at > 0) await midDownload?.();
      if (res.destroyed) return;
      if (!res.write(file.bytes.subarray(at, at + MiB))) await new Promise(resolve => { res.once("drain", resolve); res.once("close", resolve); });
    }
    res.end();
    return;
  }
  if (verb === "put" && req.method === "PUT") {
    let bytes = 0, chunks = 0, head = Buffer.alloc(0), tail = Buffer.alloc(0);
    for await (const part of req) {
      const chunk = part as Buffer;
      if (chunks++ === 0) onFirstUploadChunk?.();
      if (head.length < 64) head = Buffer.concat([head, chunk]).subarray(0, 64);
      tail = Buffer.concat([tail, chunk]).subarray(-64);
      bytes += chunk.length;
    }
    uploads.set(path, { bytes, chunks, head, tail });
    res.end();
    return;
  }
  res.writeHead(405); res.end();
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-computer-files-data-"));
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname.startsWith("/sandbox/")) {
      calls.push({ method: req.method ?? "", path: url.pathname.replace(/\/[^/]+$/, "/<token>"), body: null, authorization: req.headers.authorization, contentLength: req.headers["content-length"] });
      // A copy stopped mid-transfer closes its request; the sandbox just lets it go.
      await sandbox(req, res, url).catch(() => res.destroy());
      return;
    }
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    calls.push({ method: req.method ?? "", path: url.pathname, body: text ? JSON.parse(text) : null, authorization: req.headers.authorization });
    const kind = /\/(?:sandboxes|boxes)\/bx_[a-z0-9]+\/files\/(download-url|upload-url)$/.exec(url.pathname)?.[1];
    if (kind && req.method === "POST") {
      const answer = mintAnswer?.(kind);
      if (answer) { res.writeHead(answer.status, { "content-type": "application/json" }); res.end(JSON.stringify(answer.body)); return; }
      const body = JSON.parse(text);
      const path = body.path.startsWith("/") ? body.path : `/home/user/${body.path}`;
      const token = Buffer.from(`${path}|${randomBytes(12).toString("hex")}`).toString("base64url");
      const link = `${base}/sandbox/${kind === "download-url" ? "get" : "put"}/${token}`;
      minted.push(token);
      res.end(JSON.stringify({ ok: true, type: kind === "download-url" ? "file.download_url" : "file.upload_url", url: link, method: kind === "download-url" ? "GET" : "PUT", path, expiresAt: new Date(Date.now() + 300_000).toISOString() }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  base = `http://127.0.0.1:${address.port}`;
  files = await import("./cloud-computer-files.ts");
  tools = await import("./cloud-computer-tools.ts");
  journal = await import("./boat-delete-journal.ts");
});
beforeEach(() => {
  vi.stubEnv("OMB_BOAT_API", `${base}/boat/api/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_URL", `${base}/relay/api/box/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", INCLUDED);
  calls.length = 0;
  disk.clear();
  uploads.clear();
  expireLinks = false;
  mintAnswer = duringDownload = midDownload = onFirstUploadChunk = stall = undefined;
  root = mkdtempSync(join(tmpdir(), "omb-computer-files-"));
  folder = join(root, "folder");
  outside = join(root, "outside");
  mkdirSync(folder);
  mkdirSync(outside);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

const leftovers = (dir = folder) => readdirSync(dir, { recursive: true }).map(String).filter(name => name.endsWith(".part"));
const plenty = { freeBytes: () => 64 * 1024 * MiB };
const from = (path: string, to?: string, options: Parameters<typeof files.copyFromComputer>[5] = plenty, cfg = own) =>
  files.copyFromComputer(cfg, BOX, folder, { path, ...(to === undefined ? {} : { to }) }, signal(), options);
const to = (fromPath: string, path: string, cfg = own) => files.copyToComputer(cfg, BOX, folder, { from: fromPath, path }, signal());
const sandboxCalls = () => calls.filter(call => call.path.startsWith("/sandbox/"));
const boatCalls = () => calls.filter(call => !call.path.startsWith("/sandbox/"));

describe("copy_from_computer", () => {
  it("mints a short-lived link on the own key, then fetches it without that key", async () => {
    disk.set("/home/user/out/result.json", { bytes: Buffer.from('{"rows":3}') });
    await expect(from("/home/user/out/result.json")).resolves.toEqual({ path: "result.json", bytes: 10 });
    expect(readFileSync(join(folder, "result.json"), "utf8")).toBe('{"rows":3}');
    expect(calls).toEqual([
      { method: "POST", path: `/boat/api/v1/sandboxes/${BOX}/files/download-url`, body: { path: "/home/user/out/result.json", ttlSeconds: 300 }, authorization: `Bearer ${OWN}` },
      { method: "GET", path: "/sandbox/get/<token>", body: null, authorization: undefined, contentLength: undefined },
    ]);
    await expect(from("/home/user/out/result.json", "data/2026/rows.json")).resolves.toEqual({ path: join("data", "2026", "rows.json"), bytes: 10 });
    expect(readFileSync(join(folder, "data", "2026", "rows.json"), "utf8")).toBe('{"rows":3}');
  });

  it("writes a big file to disk as it arrives, never holding it whole", async () => {
    const size = 64 * MiB;
    disk.set("/tmp/big.bin", { bytes: Buffer.alloc(size, 7), declared: false });
    let onDisk = 0;
    // Half sent, the sandbox waits for that half to reach the disk before it sends the rest.
    midDownload = async () => {
      for (let tries = 0; tries < 300 && onDisk < size / 4; tries++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        onDisk = leftovers().reduce((most, name) => Math.max(most, statSync(join(folder, name)).size), 0);
      }
    };
    await expect(from("/tmp/big.bin")).resolves.toEqual({ path: "big.bin", bytes: size });
    expect(onDisk).toBeGreaterThanOrEqual(size / 4);
    expect(statSync(join(folder, "big.bin")).size).toBe(size);
  });

  it("replaces a file already there, and a link there is replaced rather than followed", async () => {
    disk.set("/tmp/a.csv", { bytes: Buffer.from("new") });
    writeFileSync(join(folder, "a.csv"), "old");
    symlinkSync(join(outside, "missing.csv"), join(folder, "dangling.csv"));
    await from("/tmp/a.csv");
    expect(readFileSync(join(folder, "a.csv"), "utf8")).toBe("new");
    await expect(from("/tmp/a.csv", "dangling.csv")).resolves.toMatchObject({ bytes: 3 });
    expect(existsSync(join(outside, "missing.csv"))).toBe(false);
    expect(readFileSync(join(folder, "dangling.csv"), "utf8")).toBe("new");
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ["a parent step", "../escaped.json", /without "\.\."/],
    ["a parent step further in", "data/../../escaped.json", /without "\.\."/],
    ["an absolute path", "/etc/escaped.json", /relative to your working folder/],
    ["a Windows absolute path", "C:\\escaped.json", /relative to your working folder/],
    ["the folder itself", ".", /not the folder itself/],
    ["the secret folder", ".openmausbot-secrets/token.txt", /holds a secret/],
  ])("refuses %s before asking the Boat", async (_label, place, message) => {
    disk.set("/tmp/x", { bytes: Buffer.from("x") });
    expect(await from("/tmp/x", place)).toEqual({ error: expect.stringMatching(message) });
    expect(calls).toEqual([]);
    expect(existsSync(join(root, "escaped.json"))).toBe(false);
  });

  it("refuses a link that leads out of the folder, to a folder or to a file", async () => {
    disk.set("/tmp/x", { bytes: Buffer.from("x") });
    symlinkSync(outside, join(folder, "linked"));
    writeFileSync(join(outside, "file.txt"), "untouched");
    symlinkSync(join(outside, "file.txt"), join(folder, "file.txt"));
    for (const place of ["linked/escaped.json", "linked/deeper/escaped.json", "file.txt"]) {
      expect(await from("/tmp/x", place)).toEqual({ error: `${place} leads outside your working folder.` });
    }
    expect(readdirSync(outside)).toEqual(["file.txt"]);
    expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("untouched");
    expect(calls).toEqual([]);
  });

  it("refuses a link made while the file was on its way, a dangling one, and a folder in the file's place", async () => {
    disk.set("/tmp/x", { bytes: Buffer.from("x") });
    duringDownload = () => symlinkSync(outside, join(folder, "late"));
    expect(await from("/tmp/x", "late/escaped.json")).toEqual({ error: "late/escaped.json leads outside your working folder." });
    duringDownload = undefined;
    symlinkSync(join(outside, "not-yet"), join(folder, "dangling"));
    expect(await from("/tmp/x", "dangling/escaped.json")).toEqual({ error: "dangling/escaped.json cannot be made in your working folder." });
    mkdirSync(join(folder, "taken"));
    expect(await from("/tmp/x", "taken")).toEqual({ error: "taken is a folder in your working folder; name a file instead." });
    expect(readdirSync(outside)).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a file that would not fit on the disk, or is over 2 GiB, saying how much is needed and free", async () => {
    disk.set("/tmp/declared.bin", { bytes: Buffer.alloc(2 * MiB) });
    disk.set("/tmp/streamed.bin", { bytes: Buffer.alloc(3 * MiB), declared: false });
    disk.set("/tmp/huge.bin", { bytes: Buffer.alloc(16), lies: 2 * 1024 * MiB + 1 });
    expect(await from("/tmp/declared.bin", undefined, { freeBytes: () => 200 * MiB })).toEqual({
      error: "Not enough space for /tmp/declared.bin: it needs 2.0 MiB with 256.0 MiB kept free, and the working folder's disk has 200.0 MiB free.",
    });
    expect(await from("/tmp/streamed.bin", undefined, { freeBytes: () => 258 * MiB })).toEqual({
      error: expect.stringMatching(/^Not enough space for \/tmp\/streamed\.bin: it needs more than 2\.\d MiB with 256\.0 MiB kept free, and the working folder's disk has 258\.0 MiB free\.$/),
    });
    expect(await from("/tmp/huge.bin")).toEqual({ error: expect.stringMatching(/^\/tmp\/huge\.bin is 2\.0 GiB; a copy moves at most 2 GiB\./) });
    expect(readdirSync(folder)).toEqual([]);
    await expect(from("/tmp/declared.bin", undefined, { freeBytes: () => 259 * MiB })).resolves.toEqual({ path: "declared.bin", bytes: 2 * MiB });
  });

  it("says what went wrong without ever passing on the link: a missing file, unusable links, an older relay, Boat's refusal", async () => {
    const spies = (["log", "warn", "error", "info"] as const).map(level => vi.spyOn(console, level));
    try {
      const results: unknown[] = [await from("/tmp/missing.txt")];
      expect(results.at(-1)).toEqual({ error: "/tmp/missing.txt is not on the cloud computer." });
      disk.set("/tmp/x", { bytes: Buffer.from("x") });
      const answer = (url: string, method = "GET") => ({ status: 200, body: { ok: true, url, method, path: "/tmp/x", expiresAt: "2026-01-01T00:00:00Z" } });
      for (const unusable of [answer("http://203.0.113.9/files/get?sig=offsite"), answer(`${base}/sandbox/get/x`, "PUT"), answer("not a link"), { status: 200, body: { ok: true } }]) {
        mintAnswer = () => unusable;
        results.push(await from("/tmp/x"));
        expect(results.at(-1)).toEqual({ error: "The cloud computer answered with a transfer link that can't be used. Try the copy again in a minute." });
      }
      mintAnswer = () => ({ status: 403, body: { ok: false, type: "sandbox.error", status: 403, code: "not_available", message: "This cloud computer action is not included.", error: { code: "not_available", message: "This cloud computer action is not included.", status: 403 } } });
      results.push(await from("/tmp/x", undefined, plenty, {} as AppConfig));
      expect(results.at(-1)).toEqual({ error: expect.stringMatching(/^This Cloud's computer service can't hand out file transfer links yet/) });
      mintAnswer = () => ({ status: 400, body: { ok: false, code: "invalid_path", message: "Path must be under /home/user or /tmp." } });
      results.push(await from("/etc/passwd"));
      expect(results.at(-1)).toEqual({ error: "Copying /etc/passwd from the cloud computer failed: Path must be under /home/user or /tmp." });
      expect(sandboxCalls()).toHaveLength(1);
      expect(readdirSync(folder)).toEqual([]);
      const said = JSON.stringify(results) + spies.flatMap(spy => spy.mock.calls.map(args => args.join(" "))).join("\n");
      expect(minted.length).toBeGreaterThan(0);
      for (const token of minted) expect(said).not.toContain(token);
      expect(said).not.toContain("/sandbox/");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("reports an expired or refused link as such, both ways, with no link in the words", async () => {
    disk.set("/tmp/x", { bytes: Buffer.from("x") });
    writeFileSync(join(folder, "up.txt"), "up");
    expireLinks = true;
    const refused = { error: "The cloud computer refused the transfer link, which may have expired. Try the copy again." };
    const results = [await from("/tmp/x"), await to("up.txt", "/tmp/up.txt")];
    expect(results).toEqual([refused, refused]);
    for (const token of minted) expect(JSON.stringify(results)).not.toContain(token);
    expect(leftovers()).toEqual([]);
    expect(existsSync(join(folder, "x"))).toBe(false);
  });
});

describe("copy_to_computer", () => {
  it("mints an upload link, then sends the file without the key, with its length", async () => {
    mkdirSync(join(folder, "in"));
    writeFileSync(join(folder, "in", "query.sql"), "select 1;\n");
    await expect(to("in/query.sql", "work/query.sql")).resolves.toEqual({ path: "/home/user/work/query.sql", bytes: 10 });
    expect(calls).toEqual([
      { method: "POST", path: `/boat/api/v1/sandboxes/${BOX}/files/upload-url`, body: { path: "work/query.sql", ttlSeconds: 300 }, authorization: `Bearer ${OWN}` },
      { method: "PUT", path: "/sandbox/put/<token>", body: null, authorization: undefined, contentLength: "10" },
    ]);
    expect(uploads.get("/home/user/work/query.sql")).toMatchObject({ bytes: 10, head: Buffer.from("select 1;\n") });
    writeFileSync(join(folder, "empty.txt"), "");
    await expect(to("empty.txt", "/tmp/empty.txt")).resolves.toEqual({ path: "/tmp/empty.txt", bytes: 0 });
  });

  it("reads a big file from disk as it is sent, never holding it whole", async () => {
    const size = 64 * MiB, file = join(folder, "big.bin");
    closeSync(openSync(file, "w"));
    truncateSync(file, size);
    // Once the sandbox has the first bytes, the file's last bytes change on disk: only a copy still reading the
    // file sends the new ones.
    onFirstUploadChunk = () => {
      const fd = openSync(file, "r+");
      writeSync(fd, Buffer.from("written-after-the-upload-began"), 0, 30, size - 30);
      closeSync(fd);
    };
    await expect(to("big.bin", "/tmp/big.bin")).resolves.toEqual({ path: "/tmp/big.bin", bytes: size });
    const got = uploads.get("/tmp/big.bin")!;
    expect(got.bytes).toBe(size);
    expect(got.chunks).toBeGreaterThan(1);
    expect(got.tail.subarray(-30).toString()).toBe("written-after-the-upload-began");
  });

  it("refuses a file over 2 GiB before the Boat, saying the limit", async () => {
    const file = join(folder, "huge.bin");
    closeSync(openSync(file, "w"));
    truncateSync(file, 2 * 1024 * MiB + 1);
    expect(await to("huge.bin", "/tmp/huge.bin")).toEqual({ error: expect.stringMatching(/^huge\.bin is 2\.0 GiB; a copy moves at most 2 GiB\./) });
    expect(calls).toEqual([]);
  });

  it("reads nothing outside the folder, under its secret folder, or that is not a file", async () => {
    writeFileSync(join(outside, "secret.txt"), "private");
    symlinkSync(join(outside, "secret.txt"), join(folder, "linked.txt"));
    symlinkSync(outside, join(folder, "linked"));
    mkdirSync(join(folder, ".openmausbot-secrets"));
    writeFileSync(join(folder, ".openmausbot-secrets", "token"), "secret");
    mkdirSync(join(folder, "dir"));
    for (const [source, message] of [
      ["../outside/secret.txt", /without "\.\."/],
      [join(outside, "secret.txt"), /relative to your working folder/],
      ["linked.txt", /leads outside/],
      ["linked/secret.txt", /leads outside/],
      [".openmausbot-secrets/token", /holds a secret/],
      ["dir", /is not a file/],
      ["missing.txt", /is not in your working folder/],
    ] as const) {
      expect(await to(source, "/tmp/x"), source).toEqual({ error: expect.stringMatching(message) });
    }
    expect(calls).toEqual([]);
  });
});

describe("through the Cloud's included Boat", () => {
  it("mints links on the relay's box paths with only the included token, and moves the bytes past it", async () => {
    disk.set("/home/user/report.csv", { bytes: Buffer.from("a,b\n1,2\n") });
    writeFileSync(join(folder, "seed.txt"), "seed");
    await expect(from("/home/user/report.csv", undefined, plenty, {} as AppConfig)).resolves.toEqual({ path: "report.csv", bytes: 8 });
    await expect(to("seed.txt", "/tmp/seed.txt", {} as AppConfig)).resolves.toEqual({ path: "/tmp/seed.txt", bytes: 4 });
    expect(boatCalls().map(call => [call.method, call.path, call.authorization])).toEqual([
      ["POST", `/relay/api/box/v1/boxes/${BOX}/files/download-url`, `Bearer ${INCLUDED}`],
      ["POST", `/relay/api/box/v1/boxes/${BOX}/files/upload-url`, `Bearer ${INCLUDED}`],
    ]);
    expect(sandboxCalls().map(call => [call.method, call.authorization])).toEqual([["GET", undefined], ["PUT", undefined]]);
  });
});

describe("as cloud computer tools", () => {
  const rpc = (name: string, args: unknown, options: { folderOf?: () => string | null | undefined; budgetMs?: number } = {}) => {
    let gated = 0;
    const done = tools.cloudComputerRpc({ method: "tools/call", params: { name, arguments: args } }, {
      cfg: own, boxId: () => BOX, folder: options.folderOf ?? (() => folder), signal: signal(), budgetMs: options.budgetMs, provider: "box",
      gate: async () => { gated++; return { held: false }; }, assertActive: () => {},
    }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    return { done, gated: () => gated };
  };

  it("lists both copies, and runs them after the control gate", async () => {
    const listed = await tools.cloudComputerRpc({ method: "tools/list" }, { cfg: own, boxId: () => BOX, signal: signal(), gate: async () => ({ held: false }), assertActive: () => {}, provider: "box" });
    expect(("tools" in listed ? listed.tools : []).map(tool => tool.name).slice(-2)).toEqual(["copy_from_computer", "copy_to_computer"]);
    disk.set("/tmp/a.txt", { bytes: Buffer.from("abc") });
    const call = rpc("copy_from_computer", { path: "/tmp/a.txt" });
    expect(await call.done).toEqual({ content: [{ type: "text", text: JSON.stringify({ path: "a.txt", bytes: 3 }) }] });
    expect(call.gated()).toBe(1);
  });

  it("stops a copy that outlasts its budget, says nothing changed, and leaves nothing behind", async () => {
    disk.set("/tmp/slow.bin", { bytes: Buffer.alloc(MiB) });
    writeFileSync(join(folder, "slow.txt"), "slow");
    let release!: () => void;
    stall = new Promise(resolve => { release = resolve; });
    for (const [name, args] of [["copy_from_computer", { path: "/tmp/slow.bin" }], ["copy_to_computer", { from: "slow.txt", path: "/tmp/slow.txt" }]] as const) {
      expect(await rpc(name, args, { budgetMs: 300 }).done).toEqual({ isError: true, content: [{ type: "text", text: tools.CLOUD_COMPUTER_COPY_LATE }] });
    }
    release();
    expect(leftovers()).toEqual([]);
    expect(existsSync(join(folder, "slow.bin"))).toBe(false);
  });

  it("gives copies nine minutes, and every other call two", async () => {
    const { COMPUTER_COPY_BUDGET_MS, COMPUTER_PROXY_TIMEOUT_MS, HARNESS_CALL_BUDGET_MS, HARNESS_PROXY_TIMEOUTS_MS } = await import("./harness-budget.ts");
    expect([COMPUTER_COPY_BUDGET_MS, HARNESS_CALL_BUDGET_MS]).toEqual([540_000, 120_000]);
    expect(["copy_from_computer", "copy_to_computer", "exec", "screenshot"].map(tools.cloudComputerCallBudgetMs)).toEqual([540_000, 540_000, 120_000, 120_000]);
    expect(HARNESS_PROXY_TIMEOUTS_MS.computer).toBe(COMPUTER_PROXY_TIMEOUT_MS);
    expect(COMPUTER_PROXY_TIMEOUT_MS).toBeGreaterThan(COMPUTER_COPY_BUDGET_MS);
  });

  it.each([
    ["no path", "copy_from_computer", {}],
    ["an extra field", "copy_from_computer", { path: "/tmp/a", overwrite: false }],
    ["no destination", "copy_to_computer", { from: "a.txt" }],
  ])("refuses %s before the gate", async (_label, name, args) => {
    const call = rpc(name, args);
    expect(await call.done).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("input schema") }] });
    expect(call.gated()).toBe(0);
    expect(calls).toEqual([]);
  });

  it("copies nothing when the turn has no working folder", async () => {
    expect(await rpc("copy_to_computer", { from: "a.txt", path: "/tmp/a" }, { folderOf: () => undefined }).done)
      .toEqual({ isError: true, content: [{ type: "text", text: "This turn has no working folder to copy into or out of." }] });
    expect(calls).toEqual([]);
  });

  it("touches no Boat that is being deleted", async () => {
    journal.prepareBoatDeletion({ boxId: "bx_3456789a", name: "ogb-bot-abc123", ownerBotId: "bot-1" });
    writeFileSync(join(folder, "a.txt"), "a");
    try {
      await expect(files.copyFromComputer(own, "bx_3456789a", folder, { path: "/tmp/a" }, signal())).rejects.toThrow(/being deleted/);
      await expect(files.copyToComputer(own, "bx_3456789a", folder, { from: "a.txt", path: "/tmp/a" }, signal())).rejects.toThrow(/being deleted/);
      expect(calls).toEqual([]);
    } finally {
      journal.retireBoatDeletion("bx_3456789a");
    }
  });
});
