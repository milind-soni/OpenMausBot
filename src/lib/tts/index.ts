// Audio comes from the harness, which holds the voice keys: the renderer never sees them or calls a voice provider.

import { localSystemVoiceActive, remoteSystemVoice, resolveLocalSystemVoice } from "@/lib/local-voice";
import { recordBlockTiming, recordPrepared, recordSpeakEnter } from "../voice-latency-probe";
import { t } from "@/lib/i18n";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
}

interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

type TtsPrepareBody = { ready?: boolean; utterances?: string[]; error?: string };
type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };
const PREFETCH_WINDOW = 3;

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;
  private localUtterance: SpeechSynthesisUtterance | null = null;
  private settleLocalSpeech: ((finished: boolean) => void) | null = null;
  /** Identity is the claim object, not the callback, so an older release cannot clear a newer claim. */
  private externalClaim: { pause: () => void } | null = null;

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => this.watchers.delete(fn);
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next;
    for (const watcher of Array.from(this.watchers)) watcher(next);
  }

  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  stop() {
    this.token += 1;
    const external = this.externalClaim;
    this.externalClaim = null;
    external?.pause();
    this.request?.abort();
    this.request = null;
    this.settleLocalSpeech?.(false);
    this.settleLocalSpeech = null;
    this.localUtterance = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    // Pausing or removing an <audio> source does not reliably fire `ended` or `error`.
    if (this.settlePlayback) this.settlePlayback(false);
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  claimExternalVoice(pause: () => void): () => void {
    this.stop();
    const claim = { pause };
    this.externalClaim = claim;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.externalClaim === claim) this.externalClaim = null;
    };
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    recordSpeakEnter(opts.messageId);
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    if (localSystemVoiceActive()) {
      await this.speakWithLocalSystem(text, opts, live);
      if (this.request === controller) this.request = null;
      return;
    }
    let utterances: string[];
    try {
      utterances = await this.prepare(text, opts.voiceId, controller.signal);
      recordPrepared(opts.messageId, utterances.length);
    } catch (e) {
      if (live()) this.set({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
      if (this.request === controller) this.request = null;
      return;
    }
    if (!live()) return;
    if (!utterances.length) {
      this.set(IDLE);
      if (this.request === controller) this.request = null;
      return;
    }

    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string, block: number): Promise<Rendered> => {
      recordBlockTiming(opts.messageId, block, "renderStart");
      return this.render(utterance, opts.voiceId, controller.signal).then(
        (blob) => {
          recordBlockTiming(opts.messageId, block, "renderDone");
          return { blob };
        },
        (error: unknown) => ({ error }),
      );
    };
    const inFlight: Promise<Rendered>[] = [];
    for (let i = 0; i < utterances.length; i += 1) {
      while (inFlight.length < PREFETCH_WINDOW && i + inFlight.length < utterances.length) {
        const block = i + inFlight.length;
        inFlight.push(render(utterances[block], block));
      }
      const current = inFlight.shift();
      if (!current) break;
      const rendered = await current;
      if ("error" in rendered) {
        if (live()) {
          this.set({
            ...IDLE,
            error: rendered.error instanceof Error ? rendered.error.message : String(rendered.error),
          });
        }
        controller.abort();
        if (this.request === controller) this.request = null;
        return;
      }
      if (!live()) return;
      this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: utterances[i] });
      const finished = await this.play(rendered.blob, live, opts.messageId, i);
      if (!finished || !live()) {
        if (live()) this.set({ ...IDLE, error: t("voice.error.clip") });
        controller.abort();
        if (this.request === controller) this.request = null;
        return;
      }
    }
    if (live()) this.set(IDLE);
    if (this.request === controller) this.request = null;
  }

  private speakWithLocalSystem(
    text: string,
    opts: SpeakOptions,
    live: () => boolean,
  ): Promise<void> {
    const value = text.trim();
    if (!value) {
      this.set(IDLE);
      return Promise.resolve();
    }

    const synth = window.speechSynthesis;
    const utterance = new window.SpeechSynthesisUtterance(value);
    const selected = resolveLocalSystemVoice(remoteSystemVoice(opts.botId));
    if (selected) utterance.voice = selected;
    this.localUtterance = utterance;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (finished: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
        if (this.localUtterance === utterance) this.localUtterance = null;
        if (this.settleLocalSpeech === finish) this.settleLocalSpeech = null;
        if (live()) this.set(finished ? IDLE : { ...IDLE, ...(error ? { error } : {}) });
        resolve();
      };
      this.settleLocalSpeech = finish;
      utterance.onstart = () => {
        if (live()) {
          this.set({
            status: "speaking",
            botId: opts.botId,
            messageId: opts.messageId,
            caption: value,
          });
        }
      };
      utterance.onend = () => finish(true);
      utterance.onerror = (event) => {
        const interrupted = event.error === "canceled" || event.error === "interrupted";
        finish(false, interrupted ? undefined : t("voice.error.macPlay"));
      };
      try {
        synth.speak(utterance);
      } catch {
        finish(false, t("voice.error.macStart"));
      }
    });
  }

  private async prepare(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<string[]> {
    const res = await fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    const body: TtsPrepareBody = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? t("voice.error.service", { status: res.status }));
    if (!body.ready) {
      throw new Error(t("voice.error.notReady"));
    }
    return body.utterances ?? [];
  }

  private async render(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<Blob> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    if (!res.ok) {
      const body: TtsErrorBody = await res.json().catch(() => ({}));
      throw new Error(body.error ?? t("voice.error.service", { status: res.status }));
    }
    return res.blob();
  }

  private play(blob: Blob, live: () => boolean, probeMessageId?: string, probeBlock?: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      this.objectUrl = url;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        if (probeMessageId !== undefined && probeBlock !== undefined) {
          recordBlockTiming(probeMessageId, probeBlock, "audioEnd");
        }
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      audio.play().then(
        () => {
          if (probeMessageId !== undefined && probeBlock !== undefined) {
            recordBlockTiming(probeMessageId, probeBlock, "audioStart");
          }
        },
        () => done(false),
      );
    });
  }
}

export const speaker = new Speaker();
