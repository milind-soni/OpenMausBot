// A computer's end of the link (server/bot-link/link.ts): one exchange after another with its Cloud, each held open
// there until it has something to say, so both directions travel over requests this computer makes. It runs in the
// server, so the link holds with the app's window closed for as long as the computer is awake.
//
// A request that fails starts a new session after a wait that doubles up to a minute: each side then sends again whatever
// the other has not acknowledged. The Cloud's answer that it sleeps stops the asking until this computer has work for it
// or the app says the Cloud is awake (`start`), since any request would start a sleeping Cloud; the app looks every
// minute and never asks the Cloud itself to find out.
import type { BotLink, EndedLink } from "./link.ts";
import { HOLD_MS, SYNC_PATH, syncAnswer, type Frame } from "./protocol.ts";

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** What the Cloud marks a held answer with while it goes to sleep (server/cloud-power.ts). */
const POWER_HEADER = "x-omb-cloud-power";
const BACKGROUND_HEADER = "x-omb-background";

export interface DialerOptions {
  link: BotLink;
  fetch?: typeof fetch;
  log?(line: string): void;
  holdMs?: number;
  firstRetryMs?: number;
}

export function createDialer({ link, fetch: fetchImpl = fetch, log = () => {}, holdMs = HOLD_MS, firstRetryMs = FIRST_RETRY_MS }: DialerOptions) {
  let running = false, stopped = true, asleep = false, needsPairing = false;
  let session = "", ack = 0, fresh = true, retryMs = firstRetryMs;
  let held: AbortController | null = null;
  let wakeUp: (() => void) | null = null;
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wakeUp = null; resolve(); }, ms);
    timer.unref?.();
    wakeUp = () => { clearTimeout(timer); wakeUp = null; resolve(); };
  });
  const carriesWork = (frames: readonly { frame: Frame }[]) => frames.some(({ frame }) => frame.t === "handoff" || frame.t === "result" || frame.t === "cancel");

  const stopListening = link.onOutgoing(() => { held?.abort(); });
  const stopWanted = link.onWanted(() => { if (stopped) return; asleep = false; retryMs = firstRetryMs; wakeUp?.(); });

  async function exchange(target: { origin: string; token: string }, peer: string): Promise<void> {
    if (fresh) link.sessionStarted(peer);
    const sending = link.outgoing(peer, 0);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), holdMs + 15_000);
    timeout.unref?.();
    const wait = sending.length > 0 || fresh ? 0 : holdMs;
    if (wait > 0) held = controller;
    let response: Response;
    try {
      response = await fetchImpl(`${target.origin}${SYNC_PATH}`, {
        method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${target.token}`, origin: target.origin,
          ...(carriesWork(sending) ? {} : { [BACKGROUND_HEADER]: "1" }) },
        body: JSON.stringify({ fresh, ack, frames: sending.map((entry) => entry.frame), wait }),
      });
    } catch (error) {
      if (held === controller && controller.signal.aborted && !stopped && !asleep && link.hasOutgoing(peer)) return;
      throw error;
    } finally {
      clearTimeout(timeout);
      if (held === controller) held = null;
    }
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
    const answer = syncAnswer.safeParse(await response.json());
    if (!answer.success) throw new Error("the Cloud's answer did not parse");
    link.outgoing(peer, sending.at(-1)?.seq ?? 0);
    if (answer.data.session !== session) {
      const restarted = session !== "";
      session = answer.data.session; ack = 0;
      if (restarted && !fresh) { fresh = true; return; }
    }
    fresh = false; retryMs = firstRetryMs;
    link.setOnline(peer, true);
    const news = answer.data.frames.filter((entry) => entry.seq > ack);
    link.receive(peer, news.map((entry) => entry.frame));
    ack = Math.max(ack, ...news.map((entry) => entry.seq));
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
    sleep(): void { if (!stopped) { link.setSleeps(true); asleep = true; fresh = true; const peer = link.cloudPeer(); if (peer) link.setOnline(peer, false); held?.abort(); } },
    /** Stops asking. `bye`: the link was turned off here, so the Cloud is told once, unless it sleeps. True when it knows. */
    async stop({ bye: tell = false }: { bye?: boolean } = {}): Promise<boolean> {
      const target = link.dial(), sleeping = asleep;
      stopped = true;
      held?.abort();
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
    close(): void { stopped = true; held?.abort(); wakeUp?.(); stopListening(); stopWanted(); },
  };
}
