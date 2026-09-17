import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureManagedNode, managedNodePaths } from "./node-runtime.ts";
import * as releases from "./node-runtime-release.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe.skipIf(process.platform === "win32")("private runtime bootstrap", () => {
  let scratch: string;
  let archive: Buffer;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-node-test-"));
    const root = join(scratch, "fixture", "node-fixture");
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "lib", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "node"), "#!/bin/sh\necho v24.14.1\n", { mode: 0o755 });
    writeFileSync(join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "// fixture");
    execFileSync("/usr/bin/tar", ["-czf", join(scratch, "fixture.tgz"), "-C", join(scratch, "fixture"), "node-fixture"]);
    archive = readFileSync(join(scratch, "fixture.tgz"));
    vi.spyOn(releases, "nodeRuntimeRelease").mockReturnValue({ directory: "node-fixture", file: "node-fixture.tar.gz", sha256: createHash("sha256").update(archive).digest("hex") });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await removeTempDir(scratch);
  });

  it("verifies and installs once, coalesces clicks, and reuses the runtime after restart", async () => {
    const download = vi.fn<typeof fetch>(async () => new Response(archive));
    vi.stubGlobal("fetch", download);
    const base = join(scratch, "data");
    const [runtime, concurrent] = await Promise.all([ensureManagedNode(base), ensureManagedNode(base)]);
    expect(runtime).toEqual(concurrent);
    expect(existsSync(runtime.node)).toBe(true);
    expect(existsSync(runtime.npmCli)).toBe(true);
    expect(runtime.bin).toBe(join(base, "tools", "node", "node-fixture", "bin"));
    expect(await ensureManagedNode(base)).toEqual(runtime);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toBe("https://nodejs.org/dist/v24.14.1/node-fixture.tar.gz");
  });

  it("rejects corrupt downloads before extraction and allows a clean retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("corrupt")).mockImplementation(async () => new Response(archive)));
    const base = join(scratch, "data");
    await expect(ensureManagedNode(base)).rejects.toThrow(/verification/i);
    expect(existsSync(managedNodePaths(base)!.node)).toBe(false);
    expect(existsSync((await ensureManagedNode(base)).node)).toBe(true);
  });

  it("does not follow redirects or accept HTTP errors", async () => {
    const download = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.test/runtime" } }));
    vi.stubGlobal("fetch", download);
    await expect(ensureManagedNode(join(scratch, "data"))).rejects.toThrow(/download/i);
    expect(download.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects oversized responses without publishing a runtime", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "content-length": "999999999" } })));
    const base = join(scratch, "data");
    await expect(ensureManagedNode(base)).rejects.toThrow(/too large/i);
    expect(existsSync(managedNodePaths(base)!.node)).toBe(false);
  });
});
