import { z } from "zod";
import type { Audio, VerifyResult, Voice } from "./elevenlabs.ts";

const API = "https://api.cartesia.ai";
const VERSION = "2026-08-14";
export const DEFAULT_CARTESIA_MODEL = "sonic-3.6";
const voicesPage = z.object({
  data: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().optional() })),
  has_more: z.boolean(),
  next_page: z.string().nullish(),
});

async function request(path: string, key: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("cartesia-version", VERSION);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    if (signal?.aborted) throw new Error("Cartesia speech was cancelled.");
    if (timeout.aborted) throw new Error("Cartesia did not answer in time. Try again.");
    throw new Error("Could not reach Cartesia. Check your connection.");
  }
  if (response.ok) return response;
  await response.body?.cancel().catch(() => {});
  // Remote errors can echo a credential or private transcript.
  const { status } = response;
  if (status === 401 || status === 403) throw new Error("Cartesia rejected the API key or its permissions. Check the key in Settings.");
  if (status === 402) throw new Error("The Cartesia account needs credits to generate speech.");
  if (status === 429) throw new Error("Cartesia is rate-limiting requests. Wait a moment and try again.");
  throw new Error(`Cartesia request failed (HTTP ${status}). Check your voice and model settings.`);
}

async function readResponse(response: Response, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new Error("Cartesia returned too much data.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const response = await request("/voices?limit=1&is_owner=true", key, {}, 20_000);
    await response.body?.cancel().catch(() => {});
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not check the Cartesia API key." };
  }
}

async function listPage(key: string, params: URLSearchParams) {
  const response = await request(`/voices?${params}`, key, {}, 20_000);
  const text = await readResponse(response, 2 * 1024 * 1024);
  let body: unknown;
  try { body = JSON.parse(text.toString("utf-8")); } catch { body = null; }
  const parsed = voicesPage.safeParse(body);
  if (!parsed.success) throw new Error("Cartesia returned an invalid voice list. Try again later.");
  return parsed.data;
}

export async function listVoices(key: string, { query, current }: { query?: string; current?: string } = {}): Promise<Voice[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (query?.trim()) params.set("q", query.trim());
  const first = await listPage(key, params);
  const voices = new Map(first.data.map((voice) => [voice.id, voice]));
  if (!query?.trim()) {
    // The first page can fill with public voices before the account's private clones.
    params.set("is_owner", "true");
    const cursors = new Set<string>();
    for (;;) {
      const owned = await listPage(key, params);
      for (const voice of owned.data) voices.set(voice.id, voice);
      if (!owned.has_more) break;
      const cursor = owned.next_page ?? owned.data.at(-1)?.id;
      if (!cursor || cursors.has(cursor) || cursors.size >= 25) throw new Error("Cartesia did not finish listing owned voices. Search by name or ID.");
      cursors.add(cursor);
      params.set("starting_after", cursor);
    }
    if (current && !voices.has(current)) {
      const selected = await listPage(key, new URLSearchParams({ q: current, limit: "10" })).catch(() => null);
      const match = selected?.data.find((voice) => voice.id === current);
      if (match) voices.set(match.id, match);
    }
  }
  return [...voices.values()].map(({ id, name, description }) => ({ id, label: name, description }));
}

export async function synthesize(text: string, voiceId: string, key: string, model?: string, language?: string, signal?: AbortSignal): Promise<Audio> {
  const response = await request("/tts/bytes", key, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      model_id: model || DEFAULT_CARTESIA_MODEL,
      transcript: text,
      voice: voiceId,
      ...(language ? { language } : {}),
      output_format: { container: "mp3", sample_rate: 44_100, bit_rate: 64_000 },
    }),
  }, 60_000, signal);
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mime !== "audio/mpeg" && mime !== "audio/mp3") {
    await response.body?.cancel().catch(() => {});
    throw new Error("Cartesia returned an unexpected audio format. Try again later.");
  }
  const bytes = await readResponse(response, 32 * 1024 * 1024);
  if (!bytes.length) throw new Error("Cartesia returned empty audio. Try again.");
  return { bytes, mime: "audio/mpeg" };
}
