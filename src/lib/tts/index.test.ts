import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceProbeSample } from "../../../shared/voice-latency-probe";

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
});

describe("external voice claims", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("a new claim pauses the previous holder, and a stale release cannot clear the newer claim", () => {
    const speaker = new Speaker();
    const first = vi.fn();
    const releaseFirst = speaker.claimExternalVoice(first);
    const second = vi.fn();

    speaker.claimExternalVoice(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    releaseFirst();
    speaker.stop();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a stale release cannot clear a newer claim that reuses the same callback", () => {
    const speaker = new Speaker();
    const pause = vi.fn();
    const releaseFirst = speaker.claimExternalVoice(pause);

    speaker.claimExternalVoice(pause);

    expect(pause).toHaveBeenCalledTimes(1);
    releaseFirst();
    speaker.stop();
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it("starting an utterance pauses the holder — call mode takes the voice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Incoming."] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const pause = vi.fn();
    speaker.claimExternalVoice(pause);

    const speaking = speaker.speak("Incoming.");

    expect(pause).toHaveBeenCalledTimes(1);
    speaker.stop();
    await speaking;
  });

  it("claiming during an utterance stops the utterance — a note takes the voice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Talking."] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Talking.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    speaker.claimExternalVoice(vi.fn());

    await expect(speaking).resolves.toBeUndefined();
    expect(FakeAudio.latest!.pause).toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("release clears the claim, and releasing twice is safe", () => {
    const speaker = new Speaker();
    const pause = vi.fn();
    const release = speaker.claimExternalVoice(pause);

    release();
    release();
    speaker.stop();

    expect(pause).not.toHaveBeenCalled();
  });
});

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

interface SynthGate {
  settled: boolean;
  signal: AbortSignal | undefined;
  respond: (response: Response) => void;
}

describe("prefetch window", () => {
  let gates: SynthGate[] = [];
  let synthOrder: string[] = [];
  let playedUrls: string[] = [];
  let peakSynthesis = 0;

  const clip = () => new Response(new Blob(["mp3"]), { status: 200 });

  beforeEach(() => {
    FakeAudio.latest = null;
    gates = [];
    synthOrder = [];
    playedUrls = [];
    peakSynthesis = 0;
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    let urlCount = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      urlCount += 1;
      const url = `blob:block-${urlCount}`;
      playedUrls.push(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  function installTts(utterances: string[]): void {
    let synthesizing = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/prepare")) {
          return Promise.resolve(json({ ready: true, utterances }));
        }
        // The Speaker serializes { text, voiceId } itself; the cast reads back what it sent.
        const body = JSON.parse(String(init?.body)) as { text: string };
        synthOrder.push(body.text);
        synthesizing += 1;
        peakSynthesis = Math.max(peakSynthesis, synthesizing);
        const deferred = deferredResponse();
        const gate: SynthGate = {
          settled: false,
          signal: init?.signal ?? undefined,
          respond: (response: Response) => {
            gate.settled = true;
            synthesizing -= 1;
            deferred.resolve(response);
          },
        };
        gates.push(gate);
        return deferred.promise;
      }),
    );
  }

  it("keeps at most three blocks in flight, starting block j+3 only after block j has played", async () => {
    installTts(["B0", "B1", "B2", "B3", "B4"]);
    const speaker = new Speaker();
    const speaking = speaker.speak("five blocks");
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2"]));

    gates[0]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1"]));
    expect(synthOrder).toEqual(["B0", "B1", "B2"]);

    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2", "B3"]));

    gates[1]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1", "blob:block-2"]));
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2", "B3", "B4"]));

    gates[2]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toHaveLength(3));
    FakeAudio.latest!.onended?.();
    gates[3]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toHaveLength(4));
    FakeAudio.latest!.onended?.();
    gates[4]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toHaveLength(5));
    FakeAudio.latest!.onended?.();
    await speaking;

    expect(peakSynthesis).toBe(3);
    expect(playedUrls).toEqual([
      "blob:block-1",
      "blob:block-2",
      "blob:block-3",
      "blob:block-4",
      "blob:block-5",
    ]);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("synthesizes blocks j+1 and j+2 while block j is still playing", async () => {
    installTts(["B0", "B1", "B2", "B3"]);
    const speaker = new Speaker();
    const speaking = speaker.speak("four blocks");
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2"]));

    gates[0]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1"]));
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2", "B3"]));
    gates[1]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1", "blob:block-2"]));

    expect(gates[2]!.settled).toBe(false);
    expect(gates[3]!.settled).toBe(false);

    gates[2]!.respond(clip());
    gates[3]!.respond(clip());
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(playedUrls).toHaveLength(3));
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(playedUrls).toHaveLength(4));
    FakeAudio.latest!.onended?.();
    await speaking;

    expect(speaker.state).toEqual({ status: "idle" });
    expect(playedUrls).toEqual(["blob:block-1", "blob:block-2", "blob:block-3", "blob:block-4"]);
  });

  it("plays prefetched blocks in order even when synthesis completes out of order", async () => {
    installTts(["B0", "B1", "B2"]);
    const speaker = new Speaker();
    const captions: string[] = [];
    speaker.subscribe((snapshot) => {
      if (snapshot.caption) captions.push(snapshot.caption);
    });
    const speaking = speaker.speak("three blocks");
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2"]));

    gates[2]!.respond(clip());
    gates[1]!.respond(clip());
    expect(playedUrls).toEqual([]);

    gates[0]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1"]));
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1", "blob:block-2"]));
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1", "blob:block-2", "blob:block-3"]));
    FakeAudio.latest!.onended?.();
    await speaking;

    expect(captions).toEqual(["B0", "B1", "B2"]);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("surfaces a prefetched block's error only after earlier blocks finish playing", async () => {
    installTts(["B0", "B1", "B2"]);
    const speaker = new Speaker();
    const speaking = speaker.speak("fails midway");
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2"]));

    gates[0]!.respond(clip());
    gates[1]!.respond(
      new Response(JSON.stringify({ error: "voice exploded" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    gates[2]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1"]));
    expect(speaker.state).toEqual({ status: "speaking", caption: "B0" });

    FakeAudio.latest!.onended?.();
    await expect(speaking).resolves.toBeUndefined();
    expect(speaker.state).toEqual({ status: "idle", error: "voice exploded" });
    expect(playedUrls).toEqual(["blob:block-1"]);
  });

  it("aborts the prefetched syntheses left in flight when a block fails to render", async () => {
    installTts(["B0", "B1", "B2"]);
    const speaker = new Speaker();
    const speaking = speaker.speak("fails on the first block");
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2"]));

    gates[0]!.respond(
      new Response(JSON.stringify({ error: "voice exploded" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(speaking).resolves.toBeUndefined();

    expect(speaker.state).toEqual({ status: "idle", error: "voice exploded" });
    expect(gates[1]!.signal?.aborted).toBe(true);
    expect(gates[2]!.signal?.aborted).toBe(true);
    expect(playedUrls).toEqual([]);
  });

  it("aborts the prefetched syntheses left in flight when playback fails", async () => {
    installTts(["B0", "B1", "B2"]);
    const speaker = new Speaker();
    const speaking = speaker.speak("fails to play");
    await vi.waitFor(() => expect(synthOrder).toEqual(["B0", "B1", "B2"]));

    gates[0]!.respond(clip());
    await vi.waitFor(() => expect(playedUrls).toEqual(["blob:block-1"]));
    FakeAudio.latest!.onerror?.();
    await expect(speaking).resolves.toBeUndefined();

    expect(speaker.state).toEqual({ status: "idle", error: "The generated voice clip couldn't be played." });
    expect(gates[1]!.signal?.aborted).toBe(true);
    expect(gates[2]!.signal?.aborted).toBe(true);
    expect(playedUrls).toEqual(["blob:block-1"]);
  });
});

describe("stream identification", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("adopts the completed message id into the snapshot and probe records", async () => {
    const probe: VoiceProbeSample[] = [];
    vi.stubGlobal("window", { __ombVoiceProbe: probe });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Hello.", "Bye."] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const captions: string[] = [];
    const speaker = new Speaker();
    const stream = speaker.begin({ botId: "bot" });
    expect(speaker.state).toEqual({ status: "preparing", botId: "bot" });
    expect(speaker.isSpeaking("m9")).toBe(false);
    speaker.subscribe((snapshot) => {
      if (snapshot.caption) captions.push(snapshot.caption);
    });
    stream.identify("m9");
    expect(speaker.state).toEqual({ status: "preparing", botId: "bot", messageId: "m9" });
    expect(speaker.isSpeaking("m9")).toBe(true);
    for (const block of await stream.prepare("Hello. Bye.")) stream.push(block);
    for (const caption of ["Hello.", "Bye."]) {
      await vi.waitFor(() => expect(captions).toContain(caption));
      FakeAudio.latest!.onended?.();
    }
    await stream.end();
    expect(speaker.state).toEqual({ status: "idle" });
    const sample = probe.find((entry) => entry.messageId === "m9");
    expect(sample?.blockCount).toBe(2);
    expect(sample?.blocks).toHaveLength(2);
    expect(sample?.blocks[0]?.renderStartAt).toBeDefined();
  });

  it("cancel tears down only the stream that is still current", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Old."] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const first = speaker.begin({});
    first.push("Old.");
    const second = speaker.begin({});

    first.cancel();
    expect(speaker.state).toEqual({ status: "preparing" });

    second.cancel();
    expect(speaker.state).toEqual({ status: "idle" });
  });
});

describe("local system voice stream", () => {
  const makeSynth = () => ({
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: (): SpeechSynthesisVoice[] => [],
  });
  let synth = makeSynth();
  let spoken: FakeUtterance[] = [];

  class FakeUtterance {
    text: string;
    voice: SpeechSynthesisVoice | null = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;

    constructor(text: string) {
      this.text = text;
      spoken.push(this);
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    synth = makeSynth();
    spoken = [];
    vi.stubGlobal("window", {
      ogb: { remoteClient: { active: true }, platform: "darwin" },
      speechSynthesis: synth,
      SpeechSynthesisUtterance: FakeUtterance,
    });
  });

  it("resets the preparing state when nothing was ever pushed", async () => {
    const speaker = new Speaker();
    const stream = speaker.begin({ botId: "bot" });
    expect(speaker.state).toEqual({ status: "preparing", botId: "bot" });
    expect(speaker.isSpeaking()).toBe(true);

    await stream.end();

    expect(speaker.state).toEqual({ status: "idle" });
    expect(speaker.isSpeaking()).toBe(false);
  });

  it("does not speak a block queued before a newer stream took over", async () => {
    const speaker = new Speaker();
    const first = speaker.begin({ botId: "bot" });
    first.push("Stale words.");
    const second = speaker.begin({ botId: "bot" });
    second.identify("m2");

    await first.end();
    expect(synth.speak).not.toHaveBeenCalled();

    second.push("Fresh words.");
    await vi.waitFor(() => expect(spoken.map((utterance) => utterance.text)).toEqual(["Fresh words."]));
    spoken[0]!.onstart?.();
    expect(speaker.state).toEqual({ status: "speaking", botId: "bot", messageId: "m2", caption: "Fresh words." });
    spoken[0]!.onend?.();
    await second.end();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("surfaces a failure and resets a live stream", () => {
    const speaker = new Speaker();
    const stream = speaker.begin({ botId: "bot" });

    stream.fail("splitter down");

    expect(speaker.state).toEqual({ status: "idle", error: "splitter down" });
  });

  it("cancel silences only a stream that is still current", () => {
    const speaker = new Speaker();
    const first = speaker.begin({ botId: "bot" });
    const second = speaker.begin({ botId: "bot" });
    const cancelsBefore = synth.cancel.mock.calls.length;

    first.cancel();
    expect(speaker.state).toEqual({ status: "preparing", botId: "bot" });
    expect(synth.cancel.mock.calls.length).toBe(cancelsBefore);

    second.cancel();
    expect(speaker.state).toEqual({ status: "idle" });
    expect(synth.cancel.mock.calls.length).toBe(cancelsBefore + 1);
  });
});
