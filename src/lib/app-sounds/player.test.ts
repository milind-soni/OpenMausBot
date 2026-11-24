import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSoundPlayer, REPEAT_WINDOW_MS, type SoundOutput } from "./player";
import type { SoundChoice, SoundEvent } from "./render";

function fakeOutput(state = "running", resumes = true) {
  const started: Float32Array[] = [];
  const output = {
    sampleRate: 48_000,
    state,
    destination: {} as AudioNode,
    resume: vi.fn(async () => {
      if (!resumes) throw new Error("not allowed to start");
      output.state = "running";
    }),
    createBuffer: (_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { copyToChannel: (samples: Float32Array) => data.set(samples), data } as unknown as AudioBuffer;
    },
    createBufferSource: () => {
      const source = { buffer: null as unknown, connect: vi.fn(), start: () => started.push((source.buffer as { data: Float32Array }).data) };
      return source as unknown as AudioBufferSourceNode;
    },
  };
  return { output: output as SoundOutput & { resume: typeof output.resume }, started };
}

let clock = 0;
let choice: SoundChoice = "click";
let background = false;
let leader = true;
let made = 0;
let speaker = fakeOutput();

function player() {
  return createSoundPlayer({
    now: () => clock,
    choice: () => choice,
    background: () => background,
    leader: () => leader,
    createOutput: () => {
      made += 1;
      return speaker.output;
    },
  });
}

beforeEach(() => {
  clock = 1_000;
  choice = "click";
  background = false;
  leader = true;
  made = 0;
  speaker = fakeOutput();
});

describe("app sound player", () => {
  it("makes no audio context and no sound before the first click or key", () => {
    const sounds = player();
    expect(sounds.play("send")).toBe("unplayable");
    expect(made).toBe(0);
    sounds.unlock();
    sounds.unlock();
    expect(made).toBe(1);
    expect(sounds.play("send")).toBe("played");
    expect(speaker.started).toHaveLength(1);
    expect(Math.max(...speaker.started[0].map(Math.abs))).toBeGreaterThan(0);
  });

  it("wakes a suspended context from the gesture", () => {
    speaker = fakeOutput("suspended");
    player().unlock();
    expect(speaker.output.resume).toHaveBeenCalled();
  });

  it("counts a suspended context as playing only once its resume succeeds", async () => {
    speaker = fakeOutput("suspended", false);
    const failing = player();
    failing.unlock();
    await expect(failing.play("mention")).resolves.toBe("unplayable");
    expect(speaker.started).toHaveLength(0);
    speaker = fakeOutput("suspended");
    speaker.output.resume.mockImplementationOnce(async () => undefined);
    const waking = player();
    waking.unlock();
    await expect(waking.play("mention")).resolves.toBe("played");
    expect(speaker.started).toHaveLength(1);
  });

  it("plays nothing when sounds are off", () => {
    const sounds = player();
    sounds.unlock();
    choice = "off";
    expect(sounds.play("attention")).toBe("silenced");
    expect(speaker.started).toHaveLength(0);
  });

  it("counts the same sound twice within 150 ms as one, and never holds back a different one", () => {
    const sounds = player();
    sounds.unlock();
    expect(sounds.play("reply")).toBe("played");
    clock += REPEAT_WINDOW_MS - 1;
    expect(sounds.play("reply")).toBe("silenced");
    expect(sounds.play("done")).toBe("played");
    clock += 1;
    expect(sounds.play("reply")).toBe("played");
  });

  it("plays only what asks for the person while the window is in the background", () => {
    const sounds = player();
    sounds.unlock();
    background = true;
    const played = (["send", "reply", "done", "attention", "approved", "error", "stop", "mention", "discard", "record"] as SoundEvent[])
      .filter((event) => sounds.play(event) === "played");
    expect(played).toEqual(["done", "attention", "error", "mention"]);
  });

  it("leaves background sounds to the window used last", () => {
    const sounds = player();
    sounds.unlock();
    background = true;
    leader = false;
    expect(sounds.play("attention")).toBe("silenced");
    background = false;
    expect(sounds.play("attention")).toBe("played");
  });

  it("stays quiet while recording, except for the recording's own cues", () => {
    const sounds = player();
    sounds.unlock();
    const release = sounds.hold("recording");
    expect(sounds.play("reply")).toBe("silenced");
    expect(sounds.play("attention")).toBe("silenced");
    expect(sounds.play("discard")).toBe("played");
    expect(sounds.play("record")).toBe("played");
    release();
    expect(sounds.play("reply")).toBe("played");
  });

  it("stays fully quiet during a live call", () => {
    const sounds = player();
    sounds.unlock();
    const release = sounds.hold("call");
    for (const event of ["record", "discard", "attention"] as SoundEvent[]) expect(sounds.play(event)).toBe("silenced");
    release();
    expect(sounds.play("attention")).toBe("played");
  });

  it("plays a style's sample from the picker's own click, whatever the window", () => {
    const sounds = player();
    background = true;
    leader = false;
    expect(sounds.preview("retro")).toBe("played");
    expect(made).toBe(1);
    expect(speaker.started).toHaveLength(1);
  });

  it.each(["call", "recording"] as const)("plays no style sample during a %s", (reason) => {
    const sounds = player();
    sounds.unlock();
    const release = sounds.hold(reason);
    expect(sounds.preview("glass")).toBe("silenced");
    expect(speaker.started).toHaveLength(0);
    release();
    expect(sounds.preview("glass")).toBe("played");
    expect(speaker.started).toHaveLength(1);
  });
});
