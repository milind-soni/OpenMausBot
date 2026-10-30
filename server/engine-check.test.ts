import { describe, expect, it, vi } from "vitest";
import { checkEngine, engineCheckError } from "./engine-check.ts";

const engine = (generateText?: (prompt: string) => Promise<string>, instanceId = "claude") =>
  ({ instanceId, displayName: "Claude", driverKind: "claudeAgent", generateText: generateText && vi.fn(generateText) });

describe("checking a just-connected engine with one tiny real message", () => {
  it("is working when it answers anything, and sends only the short check prompt", async () => {
    const instance = engine(async () => "OK");
    expect(await checkEngine(instance)).toEqual({ ok: true });
    expect(instance.generateText).toHaveBeenCalledOnce();
    expect(instance.generateText!.mock.calls[0]![0]).toMatch(/connection check.*single word OK/);
  });

  it("names the exact fix: sign in again, the provider's own refusal in plain words, or what it said", async () => {
    expect(await checkEngine(engine(async () => { throw new Error("Not logged in · Please run /login"); })))
      .toEqual({ ok: false, error: "Claude isn't signed in on this computer anymore. Sign in again, then check again." });
    expect((await checkEngine(engine(async () => { throw new Error("API Error: 402 {\"error\":{\"message\":\"Your credit balance is too low\"}}"); }))))
      .toMatchObject({ ok: false, error: expect.stringContaining("Your Claude account is out of credits") });
    expect(await checkEngine(engine(async () => ""))).toEqual({ ok: false, error: "Claude answered with nothing. Check again in a minute." });
    expect(engineCheckError("ChatGPT", "spawn codex ENOENT with key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("sk-proj-abcdefghijklmnop");
  });

  it("can't check an engine without a one-shot call, and runs one check per engine at a time", async () => {
    expect(await checkEngine(engine(undefined))).toEqual({ ok: null });
    let answer!: (text: string) => void;
    const instance = engine(() => new Promise<string>(resolve => { answer = resolve; }), "codex");
    const first = checkEngine(instance), second = checkEngine(instance);
    answer("OK");
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(instance.generateText).toHaveBeenCalledOnce();
    const again = checkEngine(instance);
    answer("OK");
    expect(await again).toEqual({ ok: true });
    expect(instance.generateText).toHaveBeenCalledTimes(2);
  });

  it("checks an engine whose only one-off call is the background one, as Codex and the ACP engines have", async () => {
    const generateMemoryText = vi.fn(async (_prompt: string) => "OK");
    expect(await checkEngine({ instanceId: "opencodeGo", displayName: "OpenCode", driverKind: "opencodeGo", generateMemoryText })).toEqual({ ok: true });
    expect(generateMemoryText.mock.calls[0]![0]).toMatch(/single word OK/);
  });

  it("fails a check that hangs past its time, tells the engine to stop, and holds nothing open", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const generateText = vi.fn((_prompt: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<string>(() => {});
      });
      const hanging = { instanceId: "hanging", displayName: "Grok", driverKind: "grokAgent", generateText };
      const pending = checkEngine(hanging, { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ ok: false, error: "Grok didn't answer within 5 seconds." });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // The engine is free for the next check.
      void checkEngine(hanging, { timeoutMs: 5_000 });
      expect(generateText).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
