import { afterEach, describe, expect, it, vi } from "vitest";

const refusal = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:child_process", async (actual) => {
  const real = await actual<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      // Node throws some refusals (ENOMEM) from spawn itself rather than reporting them on the child.
      if (refusal.code) throw Object.assign(new Error(`spawn ${refusal.code}`), { code: refusal.code, errno: -12, syscall: "spawn" });
      return real.spawn(...args);
    },
  };
});

const { engineMemory } = await import("./engine-memory.ts");
const { processBudget } = await import("./process-room.ts");
const { spawnCli } = await import("./procs.ts");

describe("a spawn Node refuses by throwing", () => {
  afterEach(() => { refusal.code = null; vi.restoreAllMocks(); });

  it("is counted as a refused spawn, by its code, and told to the turn's gate as its engine's, then thrown on", () => {
    const told = vi.spyOn(engineMemory, "spawnRefused");
    const before = processBudget.counts().spawnFailed.ENOMEM;
    refusal.code = "ENOMEM";
    expect(() => spawnCli(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] }, "bot")).toThrow(/ENOMEM/);
    expect(processBudget.counts().spawnFailed.ENOMEM).toBe(before + 1);
    expect(told).toHaveBeenCalledWith("ENOMEM", true);
    expect(() => spawnCli(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] })).toThrow(/ENOMEM/);
    expect(told).toHaveBeenLastCalledWith("ENOMEM", false);
  });

  it("counts nothing for a throw that is no shortage", () => {
    const before = processBudget.counts().spawnFailed;
    refusal.code = "ERR_INVALID_ARG_VALUE";
    expect(() => spawnCli(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] })).toThrow();
    expect(processBudget.counts().spawnFailed).toEqual(before);
  });
});
