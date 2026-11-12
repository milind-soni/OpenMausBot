import { afterEach, describe, expect, it, vi } from "vitest";

const path = "./qwen-audio-output";
const output = await import(/* @vite-ignore */ path).catch(() => ({}));
const device = (deviceId: string, label: string) => ({ deviceId, label, kind: "audiooutput", groupId: "fixture" }) as MediaDeviceInfo;
const devices = [device("default", "System"), device("headset-fixture", "USB Headset"), device("speaker-fixture", "Desk speakers")];
function fixture(savedId = "") {
  const mediaDevices = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn(async () => devices),
    selectAudioOutput: vi.fn(async (_options?: { deviceId?: string }) => devices[1]),
  });
  const data = new Map<string, string>([["omb-qwen-audio-output", savedId]]);
  const storage = { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
  expect(output.createQwenAudioOutput).toBeTypeOf("function");
  const controller = output.createQwenAudioOutput({ mediaDevices: () => mediaDevices, storage: () => storage, supportsSinkId: () => true });
  const context = Object.assign(new EventTarget(), { sinkId: "", setSinkId: vi.fn(async (id: string) => { context.sinkId = id; }) });
  return { controller, context, mediaDevices, storage, data };
}
afterEach(() => vi.restoreAllMocks());

describe("Qwen browser-local output routing", () => {
  it("releases the permission microphone when output enumeration never settles", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const media = { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })), enumerateDevices: () => new Promise<MediaDeviceInfo[]>(() => {}) };
    const controller = output.createQwenAudioOutput({ mediaDevices: () => media, storage: () => undefined, supportsSinkId: () => true });
    try {
      const pending = controller.choose();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stop).toHaveBeenCalledOnce();
      await pending;
      expect(controller.getSnapshot()).toMatchObject({ busy: false, error: "unavailable" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("does not let an expired permission lookup invalidate a newer enumeration", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    let finishLatest!: (devices: MediaDeviceInfo[]) => void;
    const media = {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })),
      enumerateDevices: vi.fn(() => new Promise<MediaDeviceInfo[]>(resolve => { finishLatest = resolve; })),
    };
    const controller = output.createQwenAudioOutput({ mediaDevices: () => media, storage: () => undefined, supportsSinkId: () => true });
    try {
      const permission = controller.choose();
      await vi.advanceTimersByTimeAsync(0);
      const latest = controller.refresh();
      await vi.advanceTimersByTimeAsync(5_000);
      await permission;
      finishLatest([device("new-output", "New output")]);
      await latest;
      expect(controller.getSnapshot().devices).toEqual([{ deviceId: "new-output", label: "New output" }]);
      expect(stop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["before", "during"])("preserves a restore warning set %s playback resumes", async (timing) => {
    const { controller, context } = fixture("headset-fixture");
    let resume!: () => void;
    const playback = Object.assign(context, { state: "running", resume: vi.fn(() => new Promise<void>((done) => { resume = done; })) });
    const attached = controller.attach(playback);
    if (timing === "before") await attached.ready;
    const pending = controller.resumePlayback();
    await attached.ready;
    expect(controller.getSnapshot().error).toBe("restore");
    resume(); await pending;
    expect(controller.getSnapshot()).toMatchObject({ error: "restore", playbackPaused: false, selectedId: "" });
    attached.release();
  });
  it.each(["NotAllowedError", "NotFoundError"])("preserves a %s output selection error during playback resume", async (name) => {
    const { controller, context } = fixture();
    let resume!: () => void;
    const playback = Object.assign(context, { state: "running", resume: vi.fn(() => new Promise<void>((done) => { resume = done; })) });
    const attached = controller.attach(playback);
    await attached.ready;
    const pending = controller.resumePlayback();
    context.setSinkId.mockRejectedValueOnce(new DOMException("fixture", name));
    await controller.select("speaker-fixture");
    resume(); await pending;
    expect(controller.getSnapshot()).toMatchObject({ error: name === "NotAllowedError" ? "permission" : "missing", playbackPaused: false });
    attached.release();
  });
  it("keeps device recovery visible when playback remains paused or resume rejects", async () => {
    const { controller, context } = fixture("headset-fixture");
    const playback = Object.assign(context, { state: "running", resume: vi.fn(async () => {}) });
    const attached = controller.attach(playback);
    await attached.ready;
    playback.state = "suspended";
    playback.dispatchEvent(new Event("statechange"));
    expect(controller.getSnapshot()).toMatchObject({ error: "restore", playbackPaused: true });
    await controller.resumePlayback();
    expect(controller.getSnapshot()).toMatchObject({ error: "restore", playbackPaused: true });
    playback.resume.mockRejectedValueOnce(new DOMException("fixture autoplay", "NotAllowedError"));
    await controller.resumePlayback();
    expect(controller.getSnapshot()).toMatchObject({ error: "restore", playbackPaused: true });
    playback.state = "running";
    playback.dispatchEvent(new Event("statechange"));
    expect(controller.getSnapshot()).toMatchObject({ error: "restore", playbackPaused: false });
    attached.release();
  });
  it.each(["NotAllowedError", "NotFoundError", "InvalidAccessError"])("keeps the current route and preference when setSinkId rejects with %s", async (name) => {
    const { controller, context, storage } = fixture();
    const attached = controller.attach(context);
    await attached.ready;
    await controller.select("headset-fixture");
    context.setSinkId.mockRejectedValueOnce(new DOMException("fixture private detail must not be displayed", name));
    await expect(controller.select("speaker-fixture")).resolves.toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({ active: true, selectedId: "headset-fixture", preferredId: "headset-fixture", busy: false, error: name === "NotAllowedError" ? "permission" : name === "NotFoundError" ? "missing" : "unavailable" });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("private detail");
    attached.release();
  });
  it("does not pretend to route when the live AudioContext lacks setSinkId", async () => {
    const { controller, storage } = fixture();
    const attached = controller.attach(Object.assign(new EventTarget(), { sinkId: "" }));
    await attached.ready;
    await controller.select("headset-fixture");
    expect(controller.getSnapshot()).toMatchObject({ supported: false, active: true, selectedId: "", preferredId: "", error: "unsupported" });
    expect(storage.setItem).not.toHaveBeenCalled();
    attached.release();
  });
  it("enumerates real outputs on mount and devicechange, keeping one listener until the last subscriber/call releases", async () => {
    const { controller, context, mediaDevices } = fixture();
    const add = vi.spyOn(mediaDevices, "addEventListener");
    const remove = vi.spyOn(mediaDevices, "removeEventListener");
    mediaDevices.enumerateDevices.mockResolvedValueOnce([...devices, { ...devices[1], kind: "audioinput" } as MediaDeviceInfo]);
    const notify = vi.fn();
    const unsubscribe = controller.subscribe(notify);
    await vi.waitFor(() => expect(controller.getSnapshot().devices).toEqual(devices.slice(1).map(({ deviceId, label }) => ({ deviceId, label }))));
    expect(add.mock.calls.filter(([type]) => type === "devicechange")).toHaveLength(1);
    const attached = controller.attach(context);
    await attached.ready;
    unsubscribe();
    expect(remove).not.toHaveBeenCalled();
    mediaDevices.enumerateDevices.mockResolvedValue([devices[2]]);
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => expect(controller.getSnapshot().devices).toEqual([{ deviceId: "speaker-fixture", label: "Desk speakers" }]));
    attached.release(); attached.release();
    expect(remove.mock.calls.filter(([type]) => type === "devicechange")).toHaveLength(1);
    const calls = mediaDevices.enumerateDevices.mock.calls.length;
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await Promise.resolve();
    expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(calls);
  });
  it("runs the browser chooser from the user action then applies the selected real device", async () => {
    const { controller, context, mediaDevices } = fixture();
    const attached = controller.attach(context);
    await attached.ready;
    expect(controller.choose).toBeTypeOf("function");
    const pending = controller.choose();
    expect(mediaDevices.selectAudioOutput).toHaveBeenCalledExactlyOnceWith({});
    await pending;
    expect(context.setSinkId).toHaveBeenCalledExactlyOnceWith("headset-fixture");
    expect(controller.getSnapshot()).toMatchObject({ selectedId: "headset-fixture", preferredId: "headset-fixture", error: null, busy: false });
    attached.release();
  });
  it("keeps the current route when the browser chooser is cancelled or denied", async () => {
    const { controller, context, mediaDevices, storage } = fixture();
    const attached = controller.attach(context);
    await attached.ready;
    await controller.select("speaker-fixture");
    mediaDevices.selectAudioOutput.mockRejectedValueOnce(new DOMException("fixture denial", "NotAllowedError"));
    expect(controller.choose).toBeTypeOf("function");
    await controller.choose();
    expect(context.setSinkId).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ active: true, selectedId: "speaker-fixture", preferredId: "speaker-fixture", error: "permission", busy: false });
    attached.release();
  });
  it("revalidates a saved ID through the chooser without prompting automatically or treating storage as permission", async () => {
    const { controller, context, mediaDevices, storage } = fixture("headset-fixture");
    const attached = controller.attach(context);
    await attached.ready;
    expect(context.setSinkId).not.toHaveBeenCalled();
    expect(mediaDevices.selectAudioOutput).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ selectedId: "", preferredId: "headset-fixture", error: "restore" });
    mediaDevices.selectAudioOutput.mockResolvedValueOnce(device("rotated-headset", "USB Headset"));
    await controller.choose();
    expect(mediaDevices.selectAudioOutput).toHaveBeenCalledExactlyOnceWith({ deviceId: "headset-fixture" });
    expect(context.setSinkId).toHaveBeenCalledExactlyOnceWith("rotated-headset");
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith("omb-qwen-audio-output", "rotated-headset");
    attached.release();
  });
  it("uses a user-requested temporary microphone grant only to enumerate when there is no output chooser", async () => {
    const { controller, context, mediaDevices, storage } = fixture();
    Reflect.deleteProperty(mediaDevices, "selectAudioOutput");
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    Object.assign(mediaDevices, { getUserMedia });
    const attached = controller.attach(context);
    await attached.ready;
    expect(getUserMedia).not.toHaveBeenCalled();
    await controller.choose();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().devices).toHaveLength(2);
    expect(context.setSinkId).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    await controller.select("speaker-fixture");
    expect(context.setSinkId).toHaveBeenCalledExactlyOnceWith("speaker-fixture");
    attached.release();
  });
  it.each(["chooser", "sink"])("ignores a late %s result after the call context is released", async (pendingKind) => {
    const { controller, context, mediaDevices, storage } = fixture();
    const attached = controller.attach(context);
    await attached.ready;
    let resolve!: () => void;
    let pending: Promise<void>;
    if (pendingKind === "chooser") {
      mediaDevices.selectAudioOutput.mockImplementationOnce(() => new Promise<MediaDeviceInfo>((done) => { resolve = () => done(devices[1]); }));
      pending = controller.choose();
    } else {
      context.setSinkId.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
      pending = controller.select("headset-fixture");
    }
    attached.release();
    const next = Object.assign(new EventTarget(), { sinkId: "", setSinkId: vi.fn(async () => {}) });
    const nextAttached = controller.attach(next);
    await nextAttached.ready;
    resolve(); await pending;
    expect(next.setSinkId).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ active: true, selectedId: "", preferredId: "", busy: false });
    nextAttached.release();
  });
  it("reflects actual sinkchange events without treating them as saved preferences", async () => {
    const { controller, context, storage } = fixture();
    const remove = vi.spyOn(context, "removeEventListener");
    const attached = controller.attach(context);
    await attached.ready;
    context.sinkId = "speaker-fixture";
    context.dispatchEvent(new Event("sinkchange"));
    expect(controller.getSnapshot()).toMatchObject({ selectedId: "speaker-fixture", preferredId: "" });
    expect(storage.setItem).not.toHaveBeenCalled();
    attached.release();
    expect(remove.mock.calls.filter(([type]) => type === "sinkchange")).toHaveLength(1);
  });
  it("restores a confirmed next-call route even when optional enumeration stalls", async () => {
    const { controller, context, mediaDevices } = fixture();
    const first = controller.attach(context);
    await first.ready;
    await controller.select("headset-fixture");
    first.release();
    mediaDevices.enumerateDevices.mockImplementation(() => new Promise(() => {}));
    const next = Object.assign(new EventTarget(), { sinkId: "", setSinkId: vi.fn(async () => {}) });
    const attached = controller.attach(next);
    await vi.waitFor(() => expect(next.setSinkId).toHaveBeenCalledExactlyOnceWith("headset-fixture"));
    await attached.ready;
    attached.release();
  });
  it("resumes the active audio graph if a successful sink change suspends it", async () => {
    const { controller, context } = fixture();
    const playback = Object.assign(context, { state: "running", resume: vi.fn(async () => { playback.state = "running"; }) });
    const attached = controller.attach(playback);
    await attached.ready;
    context.setSinkId.mockImplementationOnce(async (id: string) => { context.sinkId = id; playback.state = "suspended"; });
    await controller.select("speaker-fixture");
    expect(playback.resume).toHaveBeenCalledOnce();
    expect(playback.state).toBe("running");
    expect(controller.getSnapshot()).toMatchObject({ selectedId: "speaker-fixture", error: null });
    attached.release();
  });
  it("reports the actual successful route and offers playback recovery if resume is blocked", async () => {
    const { controller, context } = fixture();
    const playback = Object.assign(context, { state: "suspended", resume: vi.fn(async () => {}) });
    playback.resume.mockRejectedValueOnce(new DOMException("fixture autoplay detail", "NotAllowedError"));
    const attached = controller.attach(playback);
    await attached.ready;
    await controller.select("headset-fixture");
    expect(controller.getSnapshot()).toMatchObject({ active: true, selectedId: "headset-fixture", preferredId: "headset-fixture", error: "playback" });
    expect(controller.resumePlayback).toBeTypeOf("function");
    playback.resume.mockImplementationOnce(async () => { playback.state = "running"; });
    await controller.resumePlayback();
    expect(controller.getSnapshot()).toMatchObject({ active: true, selectedId: "headset-fixture", error: null });
    expect(context.setSinkId).toHaveBeenCalledTimes(1);
    attached.release();
  });
  it("switches the active AudioContext and persists only the successful preference for the next call", async () => {
    const { controller, context, storage } = fixture();
    const attached = controller.attach(context);
    await attached.ready;
    await controller.select("headset-fixture");
    expect(context.setSinkId).toHaveBeenCalledExactlyOnceWith("headset-fixture");
    expect(controller.getSnapshot()).toMatchObject({ active: true, selectedId: "headset-fixture", preferredId: "headset-fixture", error: null });
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith("omb-qwen-audio-output", "headset-fixture");
    attached.release();
    const next = Object.assign(new EventTarget(), { sinkId: "", setSinkId: vi.fn(async () => {}) });
    const nextAttached = controller.attach(next);
    await nextAttached.ready;
    expect(next.setSinkId).toHaveBeenCalledExactlyOnceWith("headset-fixture");
    expect(controller.getSnapshot()).toMatchObject({ active: true, selectedId: "headset-fixture" });
    nextAttached.release();
    await controller.select("");
    expect(context.setSinkId).toHaveBeenCalledTimes(1);
    expect(next.setSinkId).toHaveBeenCalledTimes(1);
  });
});
