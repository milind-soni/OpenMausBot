import { beforeEach, describe, expect, it, vi } from "vitest";

// The wake-word module imports browser engine packages at load time; the
// pure logic under test (session lifecycle + draft routing) must not need
// them, so both are stubbed out entirely (resolved via the vite test.alias
// to Node-resolvable stubs; vi.mock below swaps the specifiers wholesale).
vi.mock("@picovoice/porcupine-web", () => ({
  Porcupine: { trainWakeWordFromPhrase: vi.fn() },
  PorcupineWorker: { create: vi.fn() },
}));
vi.mock("@picovoice/web-voice-processor", () => ({
  WebVoiceProcessor: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

type SessionFactory = typeof import("./voice-dictation")["createVoiceDictationSession"];
type WakeModule = typeof import("./wake-word");

/** Harness over createWakeWordSession with a scripted dictation session:
 * tests drive it by pushing callbacks as the bridge would. */
function harness() {
  let callbacks: Parameters<SessionFactory>[0] | null = null;
  const dispose = vi.fn();
  const stop = vi.fn();
  const start = vi.fn();
  const session = { state: {}, setSuspended: vi.fn(), stop, start, dispose };
  const factory = vi.fn(((cb: Parameters<SessionFactory>[0]) => {
    callbacks = cb;
    return session as unknown as ReturnType<SessionFactory>;
  }) as SessionFactory);
  vi.doMock("./voice-dictation", () => ({
    createVoiceDictationSession: factory,
    mergeDictatedText: (base: string, dictated: string) => (base.trimEnd() ? `${base.trimEnd()} ${dictated.trim()}` : dictated.trim()),
  }));
  return { factory, callbacks: () => callbacks as Parameters<SessionFactory>[0], dispose, stop, start };
}

/** One fresh wake-word module per test: the draft target is module state,
 * so every test must bind the target and the session from the SAME
 * instance. */
function load(): Promise<WakeModule> {
  return import("./wake-word");
}

beforeEach(() => {
  vi.resetModules();
});

describe("createWakeWordSession", () => {
  it("starts one dictation session and reports active", async () => {
    const h = harness();
    const { createWakeWordSession: create } = await load();
    const onActiveChange = vi.fn();
    const wake = create({ onActiveChange, onError: vi.fn() });
    wake.start();
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenCalledWith(true);
    // a second "Astra" while live must not double-open the mic
    wake.start();
    expect(h.factory).toHaveBeenCalledTimes(1);
  });

  it("routes the transcript into the registered draft and tears down", async () => {
    const h = harness();
    const appendComposerDraft = vi.fn();
    vi.doMock("./drafts", () => ({ appendComposerDraft }));
    const { createWakeWordSession: create, setWakeDraftTarget } = await load();
    setWakeDraftTarget("thread-7");
    const onActiveChange = vi.fn();
    const wake = create({ onActiveChange, onError: vi.fn() });
    wake.start();
    h.callbacks().onResult("play something calm");
    expect(appendComposerDraft).toHaveBeenCalledWith("thread-7", "play something calm");
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    // after teardown a stale result must not write again
    h.callbacks().onResult("late arrival");
    expect(appendComposerDraft).toHaveBeenCalledTimes(1);
  });

  it("drops the transcript when no composer is mounted", async () => {
    const h = harness();
    const appendComposerDraft = vi.fn();
    vi.doMock("./drafts", () => ({ appendComposerDraft }));
    const { createWakeWordSession: create } = await load();
    const wake = create({ onError: vi.fn() });
    wake.start();
    h.callbacks().onResult("words nobody sees");
    expect(appendComposerDraft).not.toHaveBeenCalled();
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports errors and tears down instead of wedging the mic", async () => {
    const h = harness();
    const { createWakeWordSession: create } = await load();
    const onError = vi.fn();
    const onActiveChange = vi.fn();
    const wake = create({ onActiveChange, onError });
    wake.start();
    h.callbacks().onError("No Deepgram key");
    expect(onError).toHaveBeenCalledWith("No Deepgram key");
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("stop() ends the capture; dispose() is idempotent", async () => {
    const h = harness();
    const { createWakeWordSession: create } = await load();
    const wake = create({ onError: vi.fn() });
    wake.stop(); // nothing running: no throw, no calls
    expect(h.stop).not.toHaveBeenCalled();
    wake.start();
    wake.stop();
    expect(h.stop).toHaveBeenCalledTimes(1);
    wake.dispose();
    wake.dispose();
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it("always uses the Astra phrase", async () => {
    const { WAKE_PHRASE } = await load();
    expect(WAKE_PHRASE).toBe("Astra");
  });
});
