// A loopback Boat stands in for the provider and for the Cloud's relay; every folder is a fresh temporary one.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";

const BOX = "bx_23456789";
const OWN = "synthetic-own-key";
const INCLUDED = "synthetic-included-key";
const MAX_FROM = 50 * 1024 * 1024;
const MAX_TO = 5 * 1024 * 1024;
let server: Server;
let base: string;
let files: typeof import("./cloud-computer-files.ts");
let tools: typeof import("./cloud-computer-tools.ts");
let journal: typeof import("./boat-delete-journal.ts");
const calls: Array<{ method: string; path: string; body: any; authorization?: string }> = [];
/** What the computer holds, by path; `declared: false` streams it without a length. */
const disk = new Map<string, { bytes: Buffer; declared?: boolean; lies?: number }>();
/** Runs while the fixture answers a download, before any byte is sent. */
let duringDownload: (() => void) | undefined;
let dataDir: string;
let root: string;
let folder: string;
let outside: string;
const own: AppConfig = { box: { token: OWN } } as AppConfig;
const signal = () => new AbortController().signal;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-computer-files-data-"));
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const url = new URL(req.url ?? "/", "http://fixture");
    const text = Buffer.concat(chunks).toString("utf8");
    calls.push({ method: req.method ?? "", path: url.pathname, body: text ? JSON.parse(text) : null, authorization: req.headers.authorization });
    const action = /\/(?:sandboxes|boxes)\/bx_[a-z0-9]+\/(artifacts|files)$/.exec(url.pathname)?.[1];
    if (action === "artifacts" && req.method === "GET") {
      duringDownload?.();
      const file = disk.get(url.searchParams.get("path") ?? "");
      if (!file) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, message: "No such file." })); return; }
      res.writeHead(200, { "content-type": "application/octet-stream", ...(file.declared === false ? {} : { "content-length": String(file.lies ?? file.bytes.length) }) });
      for (let at = 0; at < file.bytes.length; at += 1 << 20) {
        if (!res.write(file.bytes.subarray(at, at + (1 << 20)))) await new Promise(resolve => res.once("drain", resolve));
      }
      res.end();
      return;
    }
    if (action === "files" && req.method === "PUT") {
      const body = JSON.parse(text);
      const bytes = Buffer.from(body.content, body.encoding);
      disk.set(body.path, { bytes });
      res.end(JSON.stringify({ ok: true, type: "file.written", path: body.path.startsWith("/") ? body.path : `/home/user/${body.path}`, encoding: body.encoding, size: bytes.length }));
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
  duringDownload = undefined;
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

describe("copy_from_computer", () => {
  it("brings a file into the working folder, under its own name or the one asked for", async () => {
    disk.set("/home/user/out/result.json", { bytes: Buffer.from('{"rows":3}') });
    await expect(files.copyFromComputer(own, BOX, folder, { path: "/home/user/out/result.json" }, signal())).resolves.toEqual({ path: "result.json", bytes: 10 });
    expect(readFileSync(join(folder, "result.json"), "utf8")).toBe('{"rows":3}');
    expect(calls).toEqual([{ method: "GET", path: `/boat/api/v1/sandboxes/${BOX}/artifacts`, body: null, authorization: `Bearer ${OWN}` }]);

    await expect(files.copyFromComputer(own, BOX, folder, { path: "/home/user/out/result.json", to: "data/2026/rows.json" }, signal()))
      .resolves.toEqual({ path: join("data", "2026", "rows.json"), bytes: 10 });
    expect(readFileSync(join(folder, "data", "2026", "rows.json"), "utf8")).toBe('{"rows":3}');
  });

  it("replaces a file already there, and a link there is replaced rather than followed", async () => {
    disk.set("/tmp/a.csv", { bytes: Buffer.from("new") });
    writeFileSync(join(folder, "a.csv"), "old");
    writeFileSync(join(outside, "target.csv"), "untouched");
    symlinkSync(join(outside, "missing.csv"), join(folder, "dangling.csv"));
    await files.copyFromComputer(own, BOX, folder, { path: "/tmp/a.csv" }, signal());
    expect(readFileSync(join(folder, "a.csv"), "utf8")).toBe("new");
    await expect(files.copyFromComputer(own, BOX, folder, { path: "/tmp/a.csv", to: "dangling.csv" }, signal())).resolves.toMatchObject({ bytes: 3 });
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
  ])("refuses %s before asking the Boat", async (_label, to, message) => {
    disk.set("/tmp/x", { bytes: Buffer.from("x") });
    const result = await files.copyFromComputer(own, BOX, folder, { path: "/tmp/x", to }, signal());
    expect(result).toEqual({ error: expect.stringMatching(message) });
    expect(calls).toEqual([]);
    expect(existsSync(join(root, "escaped.json"))).toBe(false);
  });

  it("refuses a link that leads out of the folder, to a folder or to a file", async () => {
    disk.set("/tmp/x", { bytes: Buffer.from("x") });
    symlinkSync(outside, join(folder, "linked"));
    writeFileSync(join(outside, "file.txt"), "untouched");
    symlinkSync(join(outside, "file.txt"), join(folder, "file.txt"));
    for (const to of ["linked/escaped.json", "linked/deeper/escaped.json", "file.txt"]) {
      expect(await files.copyFromComputer(own, BOX, folder, { path: "/tmp/x", to }, signal())).toEqual({ error: `${to} leads outside your working folder.` });
    }
    expect(readdirSync(outside)).toEqual(["file.txt"]);
    expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("untouched");
    expect(calls).toEqual([]);
  });

  it("refuses a link made while the file was being fetched, a dangling one, and a folder in the file's place", async () => {
    disk.set("/tmp/x", { bytes: Buffer.from("x") });
    duringDownload = () => symlinkSync(outside, join(folder, "late"));
    expect(await files.copyFromComputer(own, BOX, folder, { path: "/tmp/x", to: "late/escaped.json" }, signal()))
      .toEqual({ error: "late/escaped.json leads outside your working folder." });
    duringDownload = undefined;
    symlinkSync(join(outside, "not-yet"), join(folder, "dangling"));
    expect(await files.copyFromComputer(own, BOX, folder, { path: "/tmp/x", to: "dangling/escaped.json" }, signal()))
      .toEqual({ error: "dangling/escaped.json cannot be made in your working folder." });
    mkdirSync(join(folder, "taken"));
    expect(await files.copyFromComputer(own, BOX, folder, { path: "/tmp/x", to: "taken" }, signal()))
      .toEqual({ error: "taken is a folder in your working folder; name a file instead." });
    expect(readdirSync(outside)).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a file over 50 MiB, whether Boat declares its length or not, and leaves nothing behind", async () => {
    disk.set("/tmp/declared.bin", { bytes: Buffer.alloc(16), lies: MAX_FROM + 1 });
    disk.set("/tmp/streamed.bin", { bytes: Buffer.alloc(MAX_FROM + 1), declared: false });
    for (const path of ["/tmp/declared.bin", "/tmp/streamed.bin"]) {
      expect(await files.copyFromComputer(own, BOX, folder, { path }, signal())).toEqual({ error: expect.stringContaining("larger than 50 MiB") });
    }
    expect(readdirSync(folder)).toEqual([]);
  });

  it("brings back exactly 50 MiB", async () => {
    disk.set("/tmp/edge.bin", { bytes: Buffer.alloc(MAX_FROM, 1), declared: false });
    await expect(files.copyFromComputer(own, BOX, folder, { path: "/tmp/edge.bin" }, signal())).resolves.toEqual({ path: "edge.bin", bytes: MAX_FROM });
  });

  it("says what Boat said when the file cannot be read, and writes nothing", async () => {
    expect(await files.copyFromComputer(own, BOX, folder, { path: "/tmp/missing.txt" }, signal()))
      .toEqual({ error: "Copying /tmp/missing.txt from the cloud computer failed: No such file." });
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe("copy_to_computer", () => {
  it("sends a file from the working folder as base64", async () => {
    mkdirSync(join(folder, "in"));
    writeFileSync(join(folder, "in", "query.sql"), "select 1;\n");
    await expect(files.copyToComputer(own, BOX, folder, { from: "in/query.sql", path: "work/query.sql" }, signal()))
      .resolves.toEqual({ path: "/home/user/work/query.sql", bytes: 10 });
    expect(calls).toEqual([{ method: "PUT", path: `/boat/api/v1/sandboxes/${BOX}/files`, authorization: `Bearer ${OWN}`,
      body: { path: "work/query.sql", content: Buffer.from("select 1;\n").toString("base64"), encoding: "base64" } }]);
  });

  it("sends exactly 5 MiB and refuses one byte more, saying the limit, before the Boat", async () => {
    writeFileSync(join(folder, "edge.bin"), Buffer.alloc(MAX_TO, 2));
    writeFileSync(join(folder, "big.bin"), Buffer.alloc(MAX_TO + 1, 2));
    await expect(files.copyToComputer(own, BOX, folder, { from: "edge.bin", path: "/tmp/edge.bin" }, signal())).resolves.toMatchObject({ bytes: MAX_TO });
    expect(disk.get("/tmp/edge.bin")?.bytes.length).toBe(MAX_TO);
    calls.length = 0;
    expect(await files.copyToComputer(own, BOX, folder, { from: "big.bin", path: "/tmp/big.bin" }, signal()))
      .toEqual({ error: expect.stringMatching(/^big\.bin is 5\.0 MiB; copy_to_computer sends at most 5 MiB/) });
    expect(calls).toEqual([]);
  });

  it("reads nothing outside the folder, under its secret folder, or that is not a file", async () => {
    writeFileSync(join(outside, "secret.txt"), "private");
    symlinkSync(join(outside, "secret.txt"), join(folder, "linked.txt"));
    symlinkSync(outside, join(folder, "linked"));
    mkdirSync(join(folder, ".openmausbot-secrets"));
    writeFileSync(join(folder, ".openmausbot-secrets", "token"), "secret");
    mkdirSync(join(folder, "dir"));
    for (const [from, message] of [
      ["../outside/secret.txt", /without "\.\."/],
      [join(outside, "secret.txt"), /relative to your working folder/],
      ["linked.txt", /leads outside/],
      ["linked/secret.txt", /leads outside/],
      [".openmausbot-secrets/token", /holds a secret/],
      ["dir", /is not a file/],
      ["missing.txt", /is not in your working folder/],
    ] as const) {
      expect(await files.copyToComputer(own, BOX, folder, { from, path: "/tmp/x" }, signal()), from).toEqual({ error: expect.stringMatching(message) });
    }
    expect(calls).toEqual([]);
  });
});

describe("through the Cloud's included Boat", () => {
  it("copies both ways over the relay's box paths, with only the included token", async () => {
    disk.set("/home/user/report.csv", { bytes: Buffer.from("a,b\n1,2\n") });
    writeFileSync(join(folder, "seed.txt"), "seed");
    await expect(files.copyFromComputer({}, BOX, folder, { path: "/home/user/report.csv" }, signal())).resolves.toEqual({ path: "report.csv", bytes: 8 });
    await expect(files.copyToComputer({}, BOX, folder, { from: "seed.txt", path: "/tmp/seed.txt" }, signal())).resolves.toEqual({ path: "/tmp/seed.txt", bytes: 4 });
    expect(calls.map(call => [call.method, call.path, call.authorization])).toEqual([
      ["GET", `/relay/api/box/v1/boxes/${BOX}/artifacts`, `Bearer ${INCLUDED}`],
      ["PUT", `/relay/api/box/v1/boxes/${BOX}/files`, `Bearer ${INCLUDED}`],
    ]);
  });
});

describe("as cloud computer tools", () => {
  const rpc = (name: string, args: unknown, folderOf: () => string | null | undefined = () => folder) => {
    let gated = 0;
    const done = tools.cloudComputerRpc({ method: "tools/call", params: { name, arguments: args } }, {
      cfg: own, boxId: () => BOX, folder: folderOf, signal: signal(),
      gate: async () => { gated++; return { held: false }; }, assertActive: () => {},
    }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    return { done, gated: () => gated };
  };

  it("lists both copies, and runs them after the control gate", async () => {
    const listed = await tools.cloudComputerRpc({ method: "tools/list" }, { cfg: own, boxId: () => BOX, signal: signal(), gate: async () => ({ held: false }), assertActive: () => {} });
    expect(("tools" in listed ? listed.tools : []).map(tool => tool.name).slice(-2)).toEqual(["copy_from_computer", "copy_to_computer"]);
    disk.set("/tmp/a.txt", { bytes: Buffer.from("abc") });
    const call = rpc("copy_from_computer", { path: "/tmp/a.txt" });
    expect(await call.done).toEqual({ content: [{ type: "text", text: JSON.stringify({ path: "a.txt", bytes: 3 }) }] });
    expect(call.gated()).toBe(1);
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
    expect(await rpc("copy_to_computer", { from: "a.txt", path: "/tmp/a" }, () => undefined).done)
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
