export type OutputError = "unsupported" | "permission" | "missing" | "unavailable" | "restore" | "playback";
export interface OutputDevice { deviceId: string; label: string }
export interface OutputState {
  supported: boolean;
  pickerAvailable: boolean;
  devices: readonly OutputDevice[];
  selectedId: string;
  preferredId: string;
  active: boolean;
  playbackPaused: boolean;
  busy: boolean;
  error: OutputError | null;
}
type SinkContext = Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
  setSinkId?(id: string): Promise<void>;
  resume?(): Promise<void>;
  readonly state?: string;
  readonly sinkId?: unknown;
};
type OutputMediaDevices = Partial<MediaDevices> & { selectAudioOutput?(options?: { deviceId?: string }): Promise<MediaDeviceInfo> };
interface OutputEnvironment {
  mediaDevices(): OutputMediaDevices | undefined;
  storage(): Pick<Storage, "getItem" | "setItem"> | undefined;
  supportsSinkId(): boolean;
}
const STORAGE_KEY = "omb-qwen-audio-output";
const browser: OutputEnvironment = {
  mediaDevices: () => globalThis.navigator?.mediaDevices,
  storage: () => typeof window === "undefined" ? undefined : window.localStorage,
  supportsSinkId: () => typeof AudioContext !== "undefined" && typeof (AudioContext.prototype as SinkContext).setSinkId === "function",
};

export function createQwenAudioOutput(env: OutputEnvironment = browser) {
  const listeners = new Set<() => void>();
  let context: SinkContext | null = null;
  let state: OutputState | undefined;
  let watchedMedia: OutputMediaDevices | null = null;
  let enumeration = 0;
  let lifecycle = 0;
  let detachSink: (() => void) | null = null;
  const confirmedIds = new Set<string>();
  const deviceChange = () => { void refresh(); };
  function watchDevices() {
    if (context || listeners.size) {
      const media = env.mediaDevices();
      if (media && watchedMedia !== media) {
        watchedMedia?.removeEventListener?.("devicechange", deviceChange);
        watchedMedia = media;
        media.addEventListener?.("devicechange", deviceChange);
        void refresh();
      }
    } else if (watchedMedia) {
      watchedMedia.removeEventListener?.("devicechange", deviceChange);
      watchedMedia = null;
      enumeration += 1;
    }
  }
  function errorCode(error: unknown): OutputError {
    const name = error instanceof Error ? error.name : "";
    return name === "NotAllowedError" ? "permission" : name === "NotFoundError" ? "missing" : "unavailable";
  }
  async function refresh() {
    const current = ++enumeration;
    try {
      const found = await env.mediaDevices()?.enumerateDevices?.() ?? [];
      if (current !== enumeration) return;
      const unique = new Map(found.filter((device) => device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default").map(({ deviceId, label }) => [deviceId, { deviceId, label }]));
      update({ devices: [...unique.values()], pickerAvailable: !!env.mediaDevices()?.selectAudioOutput });
    } catch (error) {
      if (current === enumeration) update({ error: errorCode(error) });
    }
  }
  function getSnapshot(): OutputState {
    if (!state) {
      let preferredId = "";
      try { preferredId = env.storage()?.getItem(STORAGE_KEY) || ""; } catch {}
      state = { supported: env.supportsSinkId(), pickerAvailable: !!env.mediaDevices()?.selectAudioOutput, devices: [], selectedId: preferredId, preferredId, active: false, playbackPaused: false, busy: false, error: null };
    }
    return state;
  }
  function update(patch: Partial<OutputState>) {
    state = { ...getSnapshot(), ...patch };
    for (const listener of listeners) listener();
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    watchDevices();
    return () => { listeners.delete(listener); watchDevices(); };
  }
  async function resumePlayback() {
    const target = context;
    const version = lifecycle;
    if (!target?.resume) return;
    try {
      await target.resume();
      if (version === lifecycle) update({ error: playbackError(paused(target)), playbackPaused: paused(target) });
    } catch { if (version === lifecycle) update({ error: playbackError(true), playbackPaused: paused(target) }); }
  }
  function playbackError(blocked: boolean): OutputError | null {
    const error = getSnapshot().error;
    return error && error !== "playback" ? error : blocked ? "playback" : null;
  }
  function paused(target: SinkContext): boolean { return target.state === "suspended" || target.state === "interrupted"; }
  async function route(id: string, target: SinkContext | null, version: number) {
    if (target) await target.setSinkId!(id);
    if (version !== lifecycle || context !== target) return;
    confirmedIds.add(id);
    try { env.storage()?.setItem(STORAGE_KEY, id); } catch {}
    update({ selectedId: id, preferredId: id });
    if (target && paused(target)) void resumePlayback();
  }
  async function choose() {
    if (getSnapshot().busy) return;
    if (!getSnapshot().supported) { update({ error: "unsupported" }); return; }
    const media = env.mediaDevices();
    const target = context;
    const version = lifecycle;
    const current = () => version === lifecycle && context === target;
    update({ busy: true, error: null });
    try {
      if (media?.selectAudioOutput) {
        const preferredId = getSnapshot().preferredId;
        const chosen = await media.selectAudioOutput(preferredId ? { deviceId: preferredId } : {});
        if (!current()) return;
        await route(chosen.deviceId === "default" ? "" : chosen.deviceId, target, version);
        if (current()) await refresh();
      } else if (media?.getUserMedia) {
        const permissionStream = await media.getUserMedia({ audio: true });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          if (current()) {
            const pending = refresh();
            const lookup = enumeration;
            await Promise.race([pending, new Promise<never>((_, reject) => {
              deadline = setTimeout(() => {
                if (enumeration === lookup) enumeration += 1;
                reject(new Error("Output enumeration timed out"));
              }, 5_000);
            })]);
          }
        } finally {
          if (deadline !== undefined) clearTimeout(deadline);
          for (const track of permissionStream.getTracks()) track.stop();
        }
      } else update({ error: "unavailable" });
    } catch (error) { if (current()) update({ error: errorCode(error) }); }
    finally { if (current()) update({ busy: false }); }
  }
  async function select(id: string) {
    if (getSnapshot().busy) return;
    if (!getSnapshot().supported) { update({ error: "unsupported" }); return; }
    const target = context;
    const version = lifecycle;
    update({ busy: true, error: null });
    try { await route(id, target, version); }
    catch (error) { if (version === lifecycle) update({ error: errorCode(error) }); }
    finally { if (version === lifecycle) update({ busy: false }); }
  }
  function attach(target: SinkContext) {
    detachSink?.();
    context = target;
    const version = ++lifecycle;
    const preferredId = getSnapshot().preferredId;
    const sinkChanged = () => { if (context === target) update({ selectedId: typeof target.sinkId === "string" ? target.sinkId : "" }); };
    const stateChanged = () => {
      if (context !== target) return;
      const playbackPaused = paused(target);
      update({ playbackPaused, error: playbackError(playbackPaused) });
    };
    target.addEventListener?.("sinkchange", sinkChanged);
    target.addEventListener?.("statechange", stateChanged);
    detachSink = () => { target.removeEventListener?.("sinkchange", sinkChanged); target.removeEventListener?.("statechange", stateChanged); };
    update({ active: true, playbackPaused: paused(target), busy: false, error: paused(target) ? "playback" : null, selectedId: typeof target.sinkId === "string" ? target.sinkId : "", supported: typeof target.setSinkId === "function" });
    watchDevices();
    const ready = (async () => {
      if (!preferredId) return;
      if (!confirmedIds.has(preferredId)) await refresh();
      if (version !== lifecycle || getSnapshot().busy || getSnapshot().preferredId !== preferredId) return;
      // Stored IDs are preferences, not permission; selectAudioOutput can return a rotated ID after a new page load.
      if (confirmedIds.has(preferredId) || (!getSnapshot().pickerAvailable && getSnapshot().devices.some((device) => device.deviceId === preferredId))) await select(preferredId);
      else update({ error: "restore" });
    })();
    return { ready, release() {
      if (context !== target) return;
      lifecycle += 1;
      detachSink?.();
      detachSink = null;
      context = null;
      update({ active: false, playbackPaused: false, busy: false, error: null, selectedId: getSnapshot().preferredId, supported: env.supportsSinkId() });
      watchDevices();
    } };
  }
  return { getSnapshot, subscribe, select, choose, refresh, resumePlayback, attach };
}

export const qwenAudioOutput = createQwenAudioOutput();
