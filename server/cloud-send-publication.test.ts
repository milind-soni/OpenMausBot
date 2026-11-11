import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { link, lstat, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.resetModules();
const { moveFilesRoute } = await import("./cloud-send-files.ts");
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const realSyncFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

describe("publishing bot files during a move", () => {
  let data: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), "omb-file-publication-"));
    mkdirSync(join(data, "workspaces/b1"), { recursive: true });
  });
  afterEach(async () => {
    vi.mocked(link).mockRestore();
    vi.mocked(lstat).mockRestore();
    vi.mocked(rename).mockRestore();
    vi.mocked(stat).mockRestore();
    vi.mocked(createReadStream).mockRestore();
    await removeTempDir(data);
  });

  async function send(path: string, text: string, expected?: string) {
    let answer: { status: number; body: unknown } | undefined;
    const query = { path, size: String(Buffer.byteLength(text)), sha256: digest(text), offset: "0", mode: expected === undefined ? "new" : "replace",
      ...(expected === undefined ? {} : { expect: digest(expected) }) };
    const url = new URL(`http://127.0.0.1/api/cloud-send/files?${new URLSearchParams(query)}`);
    await moveFilesRoute({ dataDir: data, bots: () => [{ id: "b1" }], owner: () => ({ person: "p_owner", name: "Owner" }) }, {
      path: "/api/cloud-send/files", method: "POST", url, auth: {} as never,
      req: Readable.from([Buffer.from(text)]) as never, res: { setHeader() {} } as never,
      json: ((_res: unknown, status: number, body: unknown) => { answer = { status, body }; }) as never,
      readBody: (async () => null) as never,
    });
    return answer;
  }

  it("accepts an identical file that appears between the existence check and publication", async () => {
    const path = "workspaces/b1/empty.txt";
    vi.mocked(link).mockImplementation(async (source, target) => {
      if (target === join(data, path)) writeFileSync(target, "");
      return realFs.link(source, target);
    });
    expect(await send(path, "")).toEqual({ status: 201, body: { stored: false } });
    expect(readFileSync(join(data, path))).toHaveLength(0);
  });

  it.each(["different file", "directory", "symlink"])("keeps a concurrently created %s as a conflict", async (kind) => {
    const path = "workspaces/b1/occupied.txt";
    const outside = join(data, "outside.txt");
    writeFileSync(outside, "");
    vi.mocked(link).mockImplementation(async (source, target) => {
      if (target === join(data, path)) {
        if (kind === "directory") mkdirSync(target);
        else if (kind === "symlink") symlinkSync(outside, target);
        else writeFileSync(target, "keep this");
      }
      return realFs.link(source, target);
    });
    expect(await send(path, "")).toEqual({ status: 409, body: { conflict: true } });
  });

  it.each([["current.txt", false], ["CURRENT.txt", false], ["CURRENT.txt", true]] as const)("checks a queued replacement through %s with unavailable identity %s", async (secondName, unavailableIdentity) => {
    const path = "workspaces/b1/current.txt";
    writeFileSync(join(data, path), "original");
    const alias = join(data, "workspaces/b1/CURRENT.txt");
    const actual = join(data, path);
    vi.mocked(lstat).mockImplementation((file, ...options) => realFs.lstat(file === alias ? actual : file, ...options));
    vi.mocked(createReadStream).mockImplementation((file, options) => realSyncFs.createReadStream(file === alias ? actual : file, options));
    vi.mocked(stat).mockImplementation((file, options) => unavailableIdentity && options?.bigint
      ? Promise.reject(new Error("directory identity unavailable")) : realFs.stat(file, options));
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const allowed = new Promise<void>((resolve) => { release = resolve; });
    let firstRename = true;
    vi.mocked(rename).mockImplementation(async (source, target) => {
      if (target === join(data, path) && firstRename) {
        firstRename = false;
        reached();
        await allowed;
      }
      return realFs.rename(source, target === alias ? actual : target);
    });
    const first = send(path, "updated", "original");
    await waiting;
    const second = send(`workspaces/b1/${secondName}`, "", "original");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([second, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
    } finally {
      clearTimeout(timer);
      release();
    }
    expect(await first).toEqual({ status: 201, body: { stored: true } });
    expect(await second).toEqual({ status: 409, body: { conflict: true } });
    expect(readFileSync(join(data, path), "utf8")).toBe("updated");
  });

  it("releases a failed publication so a later retry can finish", async () => {
    const path = "workspaces/b1/retry.txt";
    vi.mocked(link).mockRejectedValueOnce(new Error("temporary publication failure"));
    await expect(send(path, "")).rejects.toThrow("temporary publication failure");
    expect(await send(path, "")).toEqual({ status: 201, body: { stored: true } });
    expect(readFileSync(join(data, path))).toHaveLength(0);
  });

  it("removes the placed link when replacement fails after staging succeeds", async () => {
    const path = "workspaces/b1/current.txt";
    writeFileSync(join(data, path), "original");
    vi.mocked(rename).mockRejectedValueOnce(new Error("temporary replacement failure"));
    await expect(send(path, "", "original")).rejects.toThrow("temporary replacement failure");
    expect(readdirSync(join(data, "tmp/move-files"))).toEqual([]);
    expect(readFileSync(join(data, path), "utf8")).toBe("original");
    expect(await send(path, "", "original")).toEqual({ status: 201, body: { stored: true } });
  });
});
