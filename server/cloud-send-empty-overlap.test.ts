import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

vi.mock("node:fs/promises", { spy: true });
vi.resetModules();
const { moveFilesRoute } = await import("./cloud-send-files.ts");
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

describe("overlapping empty bot file uploads", () => {
  const data = mkdtempSync(join(tmpdir(), "omb-empty-overlap-"));
  afterEach(async () => {
    vi.mocked(link).mockRestore();
    await removeTempDir(data);
  });

  it("keeps a verified empty upload available while another empty file finishes", async () => {
    const firstPath = "workspaces/b1/first.txt";
    const secondPath = "workspaces/b1/another/second.txt";
    const digest = createHash("sha256").update("").digest("hex");
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const allowed = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(link).mockImplementation(async (existing, target) => {
      if (target === join(data, firstPath)) { reached(); await allowed; }
      return realFs.link(existing, target);
    });
    const send = async (path: string) => {
      let answer: { status: number; body: unknown } | undefined;
      const url = new URL(`http://127.0.0.1/api/cloud-send/files?${new URLSearchParams({ path, size: "0", sha256: digest, offset: "0", mode: "new" })}`);
      await moveFilesRoute({ dataDir: data, bots: () => [{ id: "b1" }], owner: () => ({ person: "p_owner", name: "Owner" }) }, {
        path: "/api/cloud-send/files", method: "POST", url, auth: {} as never,
        req: Readable.from([Buffer.alloc(0)]) as never, res: { setHeader() {} } as never,
        json: ((_res: unknown, status: number, body: unknown) => { answer = { status, body }; }) as never,
        readBody: (async () => null) as never,
      });
      return answer;
    };
    const first = send(firstPath).catch((error: unknown) => ({ error }));
    try {
      await waiting;
      expect(await send(secondPath)).toEqual({ status: 201, body: { stored: true } });
    } finally {
      release();
    }
    expect(await first).toEqual({ status: 201, body: { stored: true } });
    expect(readFileSync(join(data, firstPath))).toHaveLength(0);
    expect(readFileSync(join(data, secondPath))).toHaveLength(0);
  });
});
