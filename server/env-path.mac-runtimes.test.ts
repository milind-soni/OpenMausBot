import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Podman's official macOS pkg lives in /opt/podman/bin, which a test cannot create, so only that path is faked as present.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, existsSync: (path: Parameters<typeof fs.existsSync>[0]) => path === "/opt/podman/bin" || fs.existsSync(path) };
});

const { augmentedPath, resetPathCacheForTests } = await import("./env-path.ts");

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    resetPathCacheForTests();
    return run();
  } finally {
    Object.defineProperty(process, "platform", { value: real });
    resetPathCacheForTests();
  }
}

// A Finder-launched macOS app does not inherit the login-shell PATH.
describe("augmentedPath on macOS container runtimes", () => {
  const dockerBin = join(homedir(), ".docker", "bin");

  afterEach(() => rmSync(join(homedir(), ".docker"), { recursive: true, force: true }));

  it("finds Podman's official pkg dir and Docker Desktop's per-user bin dir", () => {
    mkdirSync(dockerBin, { recursive: true });
    const parts = withPlatform("darwin", () => augmentedPath().split(delimiter));
    expect(parts).toContain("/opt/podman/bin");
    expect(parts).toContain(dockerBin);
  });

  it("leaves Linux unchanged", () => {
    mkdirSync(dockerBin, { recursive: true });
    const parts = withPlatform("linux", () => augmentedPath().split(delimiter));
    expect(parts).not.toContain(dockerBin);
    if (!(process.env.PATH ?? "").split(delimiter).includes("/opt/podman/bin")) expect(parts).not.toContain("/opt/podman/bin");
  });
});
