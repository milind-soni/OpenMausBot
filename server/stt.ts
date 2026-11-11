import type { AppConfig } from "./config.ts";
import { sttStatus, usableSttKey } from "./stt-config.ts";
import * as fish from "./tts/fish.ts";

class SttHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function sttFetch<T>(cfg: AppConfig, path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const key = usableSttKey(cfg.stt);
  const res = await fetch(`${sttStatus(cfg).baseUrl}${path}`, {
    ...init,
    redirect: "error",
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...init.headers },
    signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
  });
  if (!res.ok) throw new SttHttpError(res.status);
  return await res.json() as T;
}

export async function listSpeechModels(cfg: AppConfig, signal?: AbortSignal): Promise<string[]> {
  try {
    const page = await sttFetch<{ data?: { id?: unknown }[] }>(cfg, "/models", {}, signal);
    if (!Array.isArray(page.data)) throw new Error("invalid model catalog");
    return [...new Set(page.data.map((model) => model?.id).filter((id): id is string =>
      typeof id === "string" && /^\S{1,200}$/.test(id) && [...id].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)))].sort();
  } catch (error) { throw sttRequestError(error); }
}

export async function transcribe(cfg: AppConfig, audio: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
  const status = sttStatus(cfg);
  if (status.provider === "auto" || status.provider === "fish") return fish.transcribe(audio, mime, cfg.tts!.fishKey!, signal);
  try {
    const form = new FormData();
    form.set("file", new Blob([audio.slice()], { type: mime }), "speech.wav");
    form.set("model", status.model);
    form.set("response_format", "json");
    const result = await sttFetch<{ text?: unknown }>(cfg, "/audio/transcriptions", { method: "POST", body: form }, signal);
    if (typeof result.text !== "string") throw new Error("invalid transcription");
    return result.text.trim();
  } catch (error) { throw sttRequestError(error); }
}

function sttRequestError(error: unknown): Error {
  if (error instanceof SttHttpError) {
    if (error.status === 401 || error.status === 403) return new Error("The speech input server rejected access. Check its API key in Speech input settings.");
    if (error.status === 429) return new Error("The speech input server is rate limited or out of quota. Try again later.");
    return new Error(`The speech input server could not complete the request (HTTP ${error.status}). Check its address and model in Speech input settings.`);
  }
  return new Error("Could not read a valid response from the speech input server. Check its connection, address and model in Speech input settings.");
}
