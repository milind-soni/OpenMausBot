// A computer's end of the link (server/bot-link/link.ts): one exchange after another with its Cloud, each held open
// there until it has something to say, so both directions travel over requests this computer makes. It runs in the
// server, so the link holds with the app's window closed for as long as the computer is awake.
//
// A request that fails starts a new session after a wait that doubles up to a minute: each side then sends again whatever
// the other has not acknowledged. The Cloud's answer that it sleeps stops the asking until this computer has work for it
// or the app says the Cloud is awake (`start`), since any request would start a sleeping Cloud; the app looks every
// minute and never asks the Cloud itself to find out.
import { createWriteStream, openAsBlob, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BotLink, EndedLink, FileTransfer } from "./link.ts";
import { FILE_PATH, HOLD_MS, LEVEL_HEADER, PROTOCOL_LEVEL, SYNC_PATH, levelOf, syncAnswer, type FileWay, type Frame } from "./protocol.ts";

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** What the Cloud marks a held answer with while it goes to sleep (server/cloud-power.ts). */
const POWER_HEADER = "x-omb-cloud-power";
const BACKGROUND_HEADER = "x-omb-background";
/** One file may take this long to cross. */
const FILE_MS = 10 * 60_000;

export interface DialerOptions {
  link: BotLink;
  fetch?: typeof fetch;
  log?(line: string): void;
  holdMs?: number;
  firstRetryMs?: number;
  /** What this computer says its version reads; a test stands in for an older app with it. */
  level?: number;
}

export function createDialer({ link, fetch: fetchImpl = fetch, log = () => {}, holdMs = HOLD_MS, firstRetryMs = FIRST_RETRY_MS, level = PROTOCOL_LEVEL }: DialerOptions) {
  let running = false, stopped = true, asleep = false, needsPairing = false;
  let session = "", ack = 0, fresh = true, retryMs = firstRetryMs;
  let active: AbortController | null = null, held: AbortController | null = null;
  let wakeUp: (() => void) | null = null;
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wakeUp = null; resolve(); }, ms);
    timer.unref?.();
    wakeUp = () => { clearTimeout(timer); wakeUp = null; resolve(); };
  });
  const carriesWork = (frames: readonly { frame: Frame }[]) => frames.some(({ frame }) => frame.t === "handoff" || frame.t === "result" || frame.t === "cancel");

  /** A file's bytes, over requests of this computer's: put before the frame that names it, got after one that does. An
   * answer in the 400s says the Cloud will not take or does not have it (`gone`); anything else is tried again. */
  const fileUrl = (origin: string, id: string, way: FileWay, index: number, name: string, more: Record<string, string> = {}) => `${origin}${FILE_PATH}?${new URLSearchParams({ id, way, index: String(index), name, ...more })}`;
  const refusedFile = async (response: Response) => {
    const told = await response.json().then((answer) => { const error = (answer as { error?: unknown } | null)?.error; return typeof error === "string" ? error : ""; }, () => "");
    return Object.assign(new Error(told || `the Cloud answered ${response.status}`), { gone: response.status >= 400 && response.status < 500 && ![401, 403, 408, 429].includes(response.status) });
  };
  const cloud = () => { const target = link.dial(); if (!target) throw new Error("not linked"); return { ...target, headers: { authorization: `Bearer ${target.token}`, origin: target.origin } }; };
  const transfer: FileTransfer = {
    async holds(id, way, index, file) {
      const target = cloud();
      const response = await fetchImpl(fileUrl(target.origin, id, way, index, file.name, { probe: "1", bytes: String(file.bytes) }), { redirect: "error", signal: AbortSignal.timeout(30_000), headers: target.headers });
      if (!response.ok) throw await refusedFile(response);
      return (await response.json() as { have?: unknown }).have === true;
    },
    async push(id, way, index, file) {
      const target = cloud();
      let body: Blob;
      try {
        // Node 24.0 openAsBlob() loses missing-file error codes.
        await stat(file.path);
        body = await openAsBlob(file.path);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) throw Object.assign(error, { gone: true });
        throw error;
      }
      const response = await fetchImpl(fileUrl(target.origin, id, way, index, file.name), { method: "PUT", redirect: "error", signal: AbortSignal.timeout(FILE_MS),
        headers: { ...target.headers, "content-type": "application/octet-stream" }, body });
      if (!response.ok) throw await refusedFile(response);
      await response.body?.cancel();
    },
    async pull(id, way, index, meta, to) {
      const target = cloud();
      const response = await fetchImpl(fileUrl(target.origin, id, way, index, meta.name), { redirect: "error", signal: AbortSignal.timeout(FILE_MS), headers: target.headers });
      if (!response.ok || !response.body) throw await refusedFile(response);
      // No more than the frame said: a file that turns out larger is not kept.
      let taken = 0, over = false;
      const capped = new Transform({ transform(chunk: Buffer, _encoding, done) { taken += chunk.length; over = taken > meta.bytes; done(over ? new Error("too large") : null, chunk); } });
      try {
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), capped, createWriteStream(to, { mode: 0o600 }));
      } catch (error) {
        rmSync(to, { force: true });
        throw over ? Object.assign(new Error(`${meta.name} is larger than it was said to be`), { gone: true }) : error;
      }
      if (taken !== meta.bytes) { rmSync(to, { force: true }); throw new Error(`${meta.name} did not arrive whole`); }
    },
  };
  link.setTransfer(transfer);
  const stopListening = link.onOutgoing(() => { held?.abort(); });
  const stopWanted = link.onWanted(() => { if (stopped) return; asleep = false; retryMs = firstRetryMs; wakeUp?.(); });

  async function exchange(target: { origin: string; token: string }, peer: string): Promise<void> {
    if (fresh) link.sessionStarted(peer);
    const sending = link.outgoing(peer, 0);
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(), holdMs + 15_000);
    timeout.unref?.();
    const wait = sending.length > 0 || fresh ? 0 : holdMs;
    if (wait > 0) held = controller;
    try {
      const response = await fetchImpl(`${target.origin}${SYNC_PATH}`, {
        method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${target.token}`, origin: target.origin, [LEVEL_HEADER]: String(level),
          ...(carriesWork(sending) ? {} : { [BACKGROUND_HEADER]: "1" }) },
        body: JSON.stringify({ fresh, ack, frames: sending.map((entry) => entry.frame), wait }),
      });
      controller.signal.throwIfAborted();
      if (response.status === 503 && response.headers.get(POWER_HEADER) === "asleep") {
        await response.body?.cancel();
        asleep = true; fresh = true;
        link.setSleeps(true);
        link.setOnline(peer, false);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        needsPairing = true;
        link.setOnline(peer, false);
        return;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`the Cloud answered ${response.status}`); }
      const data: unknown = await response.json();
      controller.signal.throwIfAborted();
      const answer = syncAnswer.safeParse(data);
      if (!answer.success) throw new Error("the Cloud's answer did not parse");
      link.outgoing(peer, sending.at(-1)?.seq ?? 0);
      if (answer.data.session !== session) {
        const restarted = session !== "";
        session = answer.data.session; ack = 0;
        if (restarted && !fresh) { fresh = true; return; }
      }
      fresh = false; retryMs = firstRetryMs;
      link.setOnline(peer, true);
      link.setLevel(peer, levelOf(response.headers.get(LEVEL_HEADER)));
      const news = answer.data.frames.filter((entry) => entry.seq > ack);
      link.receive(peer, news.map((entry) => entry.frame));
      ack = Math.max(ack, ...news.map((entry) => entry.seq));
    } catch (error) {
      if (held === controller && controller.signal.aborted && !stopped && !asleep && link.hasOutgoing(peer)) return;
      throw error;
    } finally {
      clearTimeout(timeout);
      if (active === controller) active = null;
      if (held === controller) held = null;
    }
  }

  async function loop(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (!stopped) {
        const target = link.dial(), peer = link.cloudPeer();
        if (!target || !peer || needsPairing) break;
        if (asleep) { await pause(24 * 60 * 60_000); continue; }
        try { await exchange(target, peer); } catch (error) {
          if (stopped) break;
          link.setOnline(peer, false);
          fresh = true;
          if (!asleep) log(`bot link: the Cloud could not be reached (${error instanceof Error ? error.message : String(error)}); trying again in ${Math.round(retryMs / 1000)} s`);
          await pause(retryMs * (0.75 + Math.random() / 2));
          retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        }
      }
    } finally { running = false; }
  }

  /** One request that says the link is over. True when the Cloud took it, or no longer knows the link. */
  async function bye(ended: Pick<EndedLink, "origin" | "token">): Promise<boolean> {
    try {
      const response = await fetchImpl(`${ended.origin}${SYNC_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${ended.token}`, origin: ended.origin, [BACKGROUND_HEADER]: "1" },
        body: JSON.stringify({ ack: 0, frames: [{ t: "bye" } satisfies Frame], wait: 0 }) });
      await response.body?.cancel();
      return response.ok || response.status === 401 || response.status === 403;
    } catch { return false; }
  }

  return {
    /** Starts asking, or asks again at once: after turning on, after pairing again, or when the app says the Cloud is
     * awake. `gentle`: this server just started, so a Cloud that sleeps is left alone until the app says it is awake or
     * there is work for it. */
    start({ gentle = false }: { gentle?: boolean } = {}): void {
      stopped = false; asleep = gentle && link.sleeps(); needsPairing = false; fresh = true; retryMs = firstRetryMs;
      wakeUp?.();
      void loop();
    },
    /** The app says the Cloud sleeps now: nothing asks it until there is work for it or it is awake again. */
    sleep(): void { if (!stopped) { link.setSleeps(true); asleep = true; fresh = true; const peer = link.cloudPeer(); if (peer) link.setOnline(peer, false); active?.abort(); } },
    /** Stops asking. `bye`: the link was turned off here, so the Cloud is told once, unless it sleeps. True when it knows. */
    async stop({ bye: tell = false }: { bye?: boolean } = {}): Promise<boolean> {
      const target = link.dial(), sleeping = asleep;
      stopped = true;
      active?.abort();
      wakeUp?.();
      return tell && target !== null && !sleeping ? bye(target) : false;
    },
    /** The app says this Cloud is awake: links to it that ended while it could not be told are ended there now. */
    async tellEnded(origin: string): Promise<void> {
      const told: string[] = [];
      for (const ended of link.ended()) if (ended.origin === origin && await bye(ended)) told.push(ended.token);
      if (told.length) link.forgetEnded(told);
    },
    state: () => ({ running: !stopped, asleep, needsPairing }),
    close(): void { stopped = true; active?.abort(); wakeUp?.(); stopListening(); stopWanted(); link.setTransfer(null); },
  };
}
