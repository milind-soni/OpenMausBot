import { STREAM_CLOSE } from "../browser/viewers/stream-v2.ts";
import { control, KEYCODES, textMessage, type VideoPacket } from "./scrcpy-wire.ts";
import { openPhoneSession, type PhoneSession, type PhoneSessionEnd } from "./session.ts";

type Frame = Exclude<VideoPacket, { kind: "session" }>;

export type PhoneViewer = {
  send(kind: Frame["kind"], data: Buffer): void;
  close(code: number, reason: string): void;
  /** Bytes sent to this viewer that have not left the server yet. */
  buffered(): number;
};

/** `x` and `y` are video pixels of a frame `w` by `h`: the one the person saw when they touched it. */
export type PhoneInput =
  | { type: "touch"; action: "down" | "move" | "up"; x: number; y: number; w: number; h: number }
  | { type: "key"; key: keyof typeof KEYCODES }
  | { type: "text"; text: string };

export type PhoneScreenHubDeps = {
  adbPath(): string | null;
  /** A verified scrcpy server file, as `ensureScrcpyServer` returns it. */
  serverFile(): Promise<string>;
};

export type PhoneScreenHub = {
  /** Shows the phone's screen to `viewer`; scrcpy runs on the phone from its first viewer until its last one leaves.
   * Returns how the viewer leaves. */
  watch(serial: string, viewer: PhoneViewer): () => void;
  videoSize(serial: string): { width: number; height: number } | undefined;
  /** Sends a watching viewer's input to the phone. The caller decides who may send it. */
  input(serial: string, viewer: PhoneViewer, input: PhoneInput): void;
  /** Lifts every finger a viewer has down on a phone. */
  liftAll(): void;
  /** Closes every viewer and settles once scrcpy has stopped on every phone. Nothing can be watched afterwards. */
  closeAll(): Promise<void>;
};

const VIEWERS_PER_PHONE = 4;
const MAX_GROUP_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_CATCH_UP_BYTES = MAX_GROUP_BYTES + MAX_BUFFERED_BYTES;
const STOPPING = "The server is stopping.";
export const ADB_MISSING = "adb was not found on the server.";

const SESSION_END: Record<PhoneSessionEnd, readonly [code: number, reason: string]> = {
  "device-gone": [STREAM_CLOSE.reconnect, "The phone was unplugged."],
  "server-exit": [STREAM_CLOSE.failed, "The phone stopped sending its screen."],
  protocol: [STREAM_CLOSE.failed, "The phone's video could not be read."],
  closed: [STREAM_CLOSE.failed, "The phone's screen closed."],
};

type Watching = {
  /** A delta means nothing to a viewer before a key frame. */
  hasKeyFrame: boolean;
  /** From joining, when the cached group is sent at once, until less than 1 MiB of what was sent is still unsent. */
  catchingUp: boolean;
  /** Where this viewer's finger is down. */
  pressed: { x: number; y: number } | undefined;
};

type Phone = {
  viewers: Map<PhoneViewer, Watching>;
  config: Buffer | undefined;
  /** The current group of pictures: a key frame and the deltas since. Empty before the first one, and from the delta
   * that took it over the cap until the next key frame. */
  group: Frame[];
  groupBytes: number;
  size: { width: number; height: number } | undefined;
  session: PhoneSession | undefined;
  ended: boolean;
};

const refuse = (viewer: PhoneViewer, code: number, reason: string) => {
  viewer.close(code, reason);
  return () => {};
};

export function createPhoneScreenHub(deps: PhoneScreenHubDeps): PhoneScreenHub {
  const phones = new Map<string, Phone>();
  /** Per serial, its latest session from opening to the end of its cleanup. */
  const runs = new Map<string, Promise<void>>();
  let stopped = false;

  // scrcpy drops a touch whose size is not the video's, and a finger whose lift it dropped stays down on the phone:
  // a lift goes out with the size the phone last announced, whatever frame the person was looking at.
  const lift = (phone: Phone, watching: Watching) => {
    const { pressed } = watching;
    if (!pressed || !phone.size) return;
    watching.pressed = undefined;
    const { width, height } = phone.size;
    phone.session?.send(control.touch("up", Math.min(pressed.x, width - 1), Math.min(pressed.y, height - 1), width, height));
  };

  const end = (serial: string, phone: Phone, code: number = STREAM_CLOSE.reconnect, reason = "") => {
    if (phone.ended) return;
    phone.ended = true;
    phones.delete(serial);
    for (const watching of phone.viewers.values()) lift(phone, watching);
    for (const viewer of phone.viewers.keys()) viewer.close(code, reason);
    phone.viewers.clear();
    void phone.session?.close();
  };

  const leave = (serial: string, phone: Phone, viewer: PhoneViewer) => {
    const watching = phone.viewers.get(viewer);
    if (!watching) return;
    lift(phone, watching);
    phone.viewers.delete(viewer);
    if (phone.viewers.size === 0) end(serial, phone);
  };

  const remember = (phone: Phone, frame: Frame) => {
    if (frame.kind === "config") {
      phone.config = frame.data;
      phone.group = [];
    } else if (frame.kind === "key") {
      phone.group = [frame];
      phone.groupBytes = frame.data.length;
    } else if (phone.group.length > 0) {
      phone.group.push(frame);
      phone.groupBytes += frame.data.length;
      if (phone.groupBytes > MAX_GROUP_BYTES) phone.group = [];
    }
  };

  const receive = (serial: string, phone: Phone, packet: VideoPacket) => {
    if (packet.kind === "session") {
      const turned = phone.size && (phone.size.width !== packet.width || phone.size.height !== packet.height);
      phone.size = { width: packet.width, height: packet.height };
      if (turned) for (const watching of phone.viewers.values()) lift(phone, watching);
      return;
    }
    remember(phone, packet);
    for (const [viewer, watching] of phone.viewers) {
      if (packet.kind === "delta" && !watching.hasKeyFrame) continue;
      const buffered = viewer.buffered();
      if (buffered < MAX_BUFFERED_BYTES) watching.catchingUp = false;
      if (buffered > (watching.catchingUp ? MAX_CATCH_UP_BYTES : MAX_BUFFERED_BYTES)) {
        viewer.close(STREAM_CLOSE.reconnect, "This view fell behind the phone's screen.");
        leave(serial, phone, viewer);
        continue;
      }
      viewer.send(packet.kind, packet.data);
      if (packet.kind === "key") watching.hasKeyFrame = true;
    }
  };

  const run = async (serial: string, phone: Phone, previous: Promise<void> | undefined) => {
    await previous;
    if (phone.ended) return;
    let session: PhoneSession;
    try {
      const adbPath = deps.adbPath();
      if (!adbPath) throw new Error(ADB_MISSING);
      const serverFile = await deps.serverFile();
      if (phone.ended) return;
      session = await openPhoneSession({ adbPath, serverFile }, serial);
    } catch (error) {
      end(serial, phone, STREAM_CLOSE.failed, error instanceof Error ? error.message : String(error));
      return;
    }
    phone.session = session;
    if (phone.ended) void session.close();
    else session.onPacket((packet) => receive(serial, phone, packet));
    end(serial, phone, ...SESSION_END[await session.closed]);
  };

  return {
    watch(serial, viewer) {
      if (stopped) return refuse(viewer, STREAM_CLOSE.reconnect, STOPPING);
      let phone = phones.get(serial);
      if (!phone) {
        const started: Phone = { viewers: new Map(), config: undefined, group: [], groupBytes: 0, size: undefined, session: undefined, ended: false };
        phones.set(serial, phone = started);
        const running = run(serial, started, runs.get(serial)).finally(() => {
          if (runs.get(serial) === running) runs.delete(serial);
        });
        runs.set(serial, running);
      }
      if (phone.viewers.size >= VIEWERS_PER_PHONE) {
        return refuse(viewer, STREAM_CLOSE.busy, "Too many views of this phone are open. Close another one first.");
      }
      if (phone.config) viewer.send("config", phone.config);
      for (const frame of phone.group) viewer.send(frame.kind, frame.data);
      phone.viewers.set(viewer, { hasKeyFrame: phone.group.length > 0, catchingUp: true, pressed: undefined });
      const watched = phone;
      return () => leave(serial, watched, viewer);
    },
    videoSize: (serial) => phones.get(serial)?.size,
    input(serial, viewer, input) {
      const phone = phones.get(serial);
      const watching = phone?.viewers.get(viewer);
      if (!phone?.session || !phone.size || !watching) return;
      if (input.type === "key") phone.session.send(control.key(KEYCODES[input.key]));
      else if (input.type === "text") phone.session.send(textMessage(input.text));
      else if (input.action === "down") {
        watching.pressed = { x: input.x, y: input.y };
        phone.session.send(control.touch("down", input.x, input.y, input.w, input.h));
      } else if (watching.pressed) {
        watching.pressed = { x: input.x, y: input.y };
        if (input.action === "move") phone.session.send(control.touch("move", input.x, input.y, input.w, input.h));
        else lift(phone, watching);
      }
    },
    liftAll() {
      for (const phone of phones.values()) for (const watching of phone.viewers.values()) lift(phone, watching);
    },
    async closeAll() {
      stopped = true;
      for (const [serial, phone] of phones) end(serial, phone, STREAM_CLOSE.reconnect, STOPPING);
      await Promise.all(runs.values());
    },
  };
}
