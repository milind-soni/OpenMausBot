import { describe, expect, it, vi } from "vitest";
import { planTokenRenewal } from "./codex-plan-token.ts";

describe("Codex plan token renewal check", () => {
  it("reads the version once, and again only after a snapshot saw another one", async () => {
    const readVersion = vi.fn(async () => ({ version: "codex-cli 0.164.0" }));
    const renewal = planTokenRenewal(readVersion);
    expect(await renewal.supported()).toBe(false);
    expect(await renewal.supported()).toBe(false);
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(renewal.noteVersion("codex-cli 0.165.0")).toBe(true);
    expect(await renewal.supported()).toBe(true);
    expect(renewal.noteVersion("codex-cli 0.164.0")).toBe(false);
    expect(await renewal.supported()).toBe(false);
    expect(readVersion).toHaveBeenCalledTimes(1);
  });

  it("shares a read in flight and asks again after a failed one", async () => {
    let answer!: (probe: { version: string } | { reason: string }) => void;
    const readVersion = vi.fn(() => new Promise<{ version: string } | { reason: string }>((resolve) => { answer = resolve; }));
    const renewal = planTokenRenewal(readVersion);
    const first = renewal.supported(), concurrent = renewal.supported();
    expect(readVersion).toHaveBeenCalledTimes(1);
    answer({ reason: "timed out" });
    expect(await Promise.all([first, concurrent])).toEqual([false, false]);
    const next = renewal.supported();
    expect(readVersion).toHaveBeenCalledTimes(2);
    answer({ version: "codex-cli 1.0.0" });
    expect(await next).toBe(true);
    expect(await renewal.supported()).toBe(true);
    expect(readVersion).toHaveBeenCalledTimes(2);
  });
});
