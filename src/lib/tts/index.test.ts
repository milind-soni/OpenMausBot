import { beforeEach, describe, expect, it, vi } from "vitest";

import { Speaker } from "./index";

class FakeAudio {
  static latest: FakeAudio | null = null;

  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => {});

  constructor(src: string) {
    this.src = src;
    FakeAudio.latest = this;
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Speaker lifecycle", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("settles an in-progress speak when stop interrupts audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Hello there."] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(FakeAudio.latest!.pause).toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("aborts preparation when stopped instead of leaving a request alive", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("A long response");

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("passes a per-bot voice through preparation and synthesis", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Distinct voice."] })
          : new Response(new Blob(["mp3"]), { status: 200 });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Distinct voice.", { voiceId: "voice-bot" });
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    FakeAudio.latest!.onended?.();
    await speaking;

    expect(bodies).toEqual([
      { text: "Distinct voice.", voiceId: "voice-bot" },
      { text: "Distinct voice.", voiceId: "voice-bot" },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });

  // On a paired desktop the default provider is the device's own engine, and
  // that path never touches `/api/tts/prepare`. It is the one place the
  // spoken half has to be decided without the harness.
  it("gives the device's own engine the reply's lead, not the detail under it", async () => {
    const spoken: string[] = [];
    class FakeUtterance {
      voice: unknown = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal("window", {
      ogb: { platform: "win32", remoteClient: { active: true } },
      speechSynthesis: {
        speak: (utterance: FakeUtterance) => {
          spoken.push(utterance.text);
          utterance.onend?.();
        },
        cancel: vi.fn(),
      },
      SpeechSynthesisUtterance: FakeUtterance,
    });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the harness must not be called"); }));

    const speaker = new Speaker();
    await speaker.speak(
      "The redirect is fixed.\n\n## What changed\n\nI moved the query string.\n\n## Files\n\n- server/auth.ts",
      { botId: "bot" },
    );

    expect(spoken).toEqual(["The redirect is fixed."]);
  });

  // On a paired desktop the default provider is the device's own engine,
  // and that path takes the raw reply as-is from the caller — it is the
  // one place the spoken half has to be decided without the harness. A
  // reply that is nothing but a leaked tool payload is not prose: the
  // reader still sees it raw, so the voice stays silent.
  it("says nothing when a pure-leak reply reaches the device's own engine", async () => {
    const spoken: string[] = [];
    class FakeUtterance {
      voice: unknown = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal("window", {
      ogb: { platform: "win32", remoteClient: { active: true } },
      speechSynthesis: {
        speak: (utterance: FakeUtterance) => {
          spoken.push(utterance.text);
          utterance.onend?.();
        },
        cancel: vi.fn(),
      },
      SpeechSynthesisUtterance: FakeUtterance,
    });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the harness must not be called"); }));

    const speaker = new Speaker();
    await speaker.speak(
      'We need to output tool use calls.\n{ "action": "press", "keys": ["win", "r"] }',
      { botId: "bot" },
    );

    expect(spoken).toEqual([]);
  });

  it("speaks only the prose around a leaked payload on the device's own engine", async () => {
    const spoken: string[] = [];
    class FakeUtterance {
      voice: unknown = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal("window", {
      ogb: { platform: "win32", remoteClient: { active: true } },
      speechSynthesis: {
        speak: (utterance: FakeUtterance) => {
          spoken.push(utterance.text);
          utterance.onend?.();
        },
        cancel: vi.fn(),
      },
      SpeechSynthesisUtterance: FakeUtterance,
    });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the harness must not be called"); }));

    const speaker = new Speaker();
    await speaker.speak(
      "Opening the Run dialog.\n{ \"action\": \"press\", \"keys\": [\"win\", \"r\"] }",
      { botId: "bot" },
    );

    expect(spoken).toEqual(["Opening the Run dialog."]);
  });
});
