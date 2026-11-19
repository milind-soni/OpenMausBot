import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./antigravity-release.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./antigravity-release.ts")>(),
  resolveAntigravityReleaseAsset: () => null,
}));

const { resolveAntigravityRuntime } = await import("./antigravity-runtime.ts");

describe("Antigravity on a platform Google publishes no runtime for", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  function dataDir() {
    const directory = mkdtempSync(join(tmpdir(), "omb-agy-unsupported-"));
    directories.push(directory);
    return directory;
  }

  it("tells a saved legacy agy path that agy is no longer used and names the runtime files to point at", async () => {
    const error = await resolveAntigravityRuntime("/usr/local/bin/agy", { PATH: "" }, dataDir()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409 });
    const message = (error as Error).message;
    expect(message).toMatch(/no longer runs the agy command/u);
    expect(message).toMatch(/agy_acp_server/u);
    expect(message).toMatch(/localharness_external/u);
  });

  it("keeps the plain message when no custom path was set", async () => {
    await expect(resolveAntigravityRuntime(undefined, { PATH: "" }, dataDir()))
      .rejects.toThrow(/Google does not publish an Antigravity runtime for .+\. Set a custom executable path\./u);
  });
});
