import { describe, expect, it, vi } from "vitest";
import type { execCli } from "../procs.ts";
import { createDynamicPlanSupport } from "./codex-provider-config.ts";

describe("Codex command authentication version probe", () => {
  it("checks again after an unsupported version, an update, and a downgrade", async () => {
    let version = "codex-cli 0.164.0";
    const exec = vi.fn((_cli, _args, _opts, callback) => callback(null, version, "")) as unknown as typeof execCli;
    const supports = createDynamicPlanSupport("codex", {}, exec);
    expect(await supports()).toBe(false);
    version = "codex-cli 0.165.0";
    expect(await supports()).toBe(true);
    version = "codex-cli 0.164.0";
    expect(await supports()).toBe(false);
  });

  it("retries a transient failure and shares an in-flight probe", async () => {
    let callback!: (error: Error | null, stdout: string, stderr: string) => void;
    const exec = vi.fn((_cli, _args, _opts, done) => { callback = done; }) as unknown as typeof execCli;
    const supports = createDynamicPlanSupport("codex", {}, exec);
    const first = supports(), concurrent = supports();
    expect(exec).toHaveBeenCalledTimes(1);
    callback(new Error("timeout"), "", "");
    expect(await Promise.all([first, concurrent])).toEqual([false, false]);
    const next = supports();
    expect(exec).toHaveBeenCalledTimes(2);
    callback(null, "codex-cli 0.166.0", "");
    expect(await next).toBe(true);
  });
});
