// The API key stays on the harness: the renderer gets only voice metadata and audio bytes.
import type { FishTtsModel } from "../config.ts";

const API = (process.env.OMB_FISH_AUDIO_API || "https://api.fish.audio").replace(/\/+$/, "");
export const DEFAULT_FISH_MODEL: FishTtsModel = "s2.1-pro";
const MAX_ERROR_LENGTH = 240;
const PAGE_SIZE = 100;
const MAX_OWNED_PAGES = 100;

export interface Voice {
  id: string;
  label: string;
  description?: string;
}

export interface Audio {
  bytes: Uint8Array;
  mime: string;
}

export type VerifyResult = { ok: true } | { ok: false; message: string };

async function safeBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  } catch {
    return null;
  }
}

function serviceDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const detail = record.detail;
  const message =
    (typeof detail === "string" && detail) ||
    (detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).message === "string"
      ? ((detail as Record<string, unknown>).message as string)
      : "") ||
    (typeof record.message === "string" && record.message) ||
    (typeof record.error === "string" && record.error) ||
    "";
  return message.trim().slice(0, MAX_ERROR_LENGTH);
}

function errorMessage(status: number, action: string, body: unknown): string {
  const detail = serviceDetail(body);
  if (status === 401 || status === 403) {
    return "Fish Audio rejected that API key, or the key cannot access voice models.";
  }
  if (status === 402) return detail || "Fish Audio says this account has insufficient balance.";
  if (status === 429) return detail || "Fish Audio is rate-limiting this account — wait a moment and try again.";
  return detail ? `${action} failed: ${detail}` : `${action} failed (${status})`;
}

export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    // The public catalog needs no key, so it proves nothing; `self=true` answers 401 for an absent or invalid Bearer token.
    const res = await fetch(`${API}/model?page_size=1&self=true`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, message: errorMessage(res.status, "checking that key", await safeBody(res)) };
  } catch {
    return { ok: false, message: "Couldn't reach Fish Audio to check that key — check your connection." };
  }
}

async function fishGet(key: string, path: string): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Couldn't reach Fish Audio to list voices — check your connection.");
  }
  return { status: response.status, body: await safeBody(response) };
}

async function modelPage(key: string, query: string): Promise<{ items: unknown[]; hasMore: boolean }> {
  const { status, body } = await fishGet(key, `/model?${query}`);
  if (status < 200 || status >= 300) throw new Error(errorMessage(status, "listing voices", body));
  if (!body || typeof body !== "object") return { items: [], hasMore: false };
  const page = body as Record<string, unknown>;
  return {
    items: Array.isArray(page.items) ? page.items : [],
    hasMore: page.has_more === true,
  };
}

async function modelById(key: string, id: string): Promise<Voice | undefined> {
  const { status, body } = await fishGet(key, `/model/${id}`);
  if (status === 404) return undefined;
  if (status < 200 || status >= 300) throw new Error(errorMessage(status, "looking up that voice", body));
  return toVoice(body);
}

function toVoice(item: unknown): Voice | undefined {
  if (!item || typeof item !== "object") return undefined;
  const model = item as Record<string, unknown>;
  // `/model` also lists SVC models and untrained ones; only trained TTS models are valid `reference_id`s for `/v1/tts`.
  if (model.type !== "tts" || model.state !== "trained") return undefined;
  const id = typeof model._id === "string" ? model._id.trim() : "";
  if (!id) return undefined;
  const label = typeof model.title === "string" && model.title.trim() ? model.title.trim() : "Voice";
  const description =
    typeof model.description === "string" && model.description.trim()
      ? model.description.trim().slice(0, MAX_ERROR_LENGTH)
      : undefined;
  return { id, label, description };
}

/** A bare Fish voice id, or the id in a `fish.audio/m/<id>` link. */
export function fishVoiceId(input: string): string | undefined {
  return /(?:^|\/m\/)([0-9a-f]{32})(?=$|[/?#])/i.exec(input.trim())?.[1]?.toLowerCase();
}

async function popularAndOwnedModels(key: string): Promise<unknown[]> {
  // Fish returns ten results by default and leaves private voices out of the public catalog: read every owned page too.
  const [publicPage, owned] = await Promise.all([
    modelPage(key, `page_size=${PAGE_SIZE}&sort_by=task_count`),
    (async () => {
      const items: unknown[] = [];
      for (let pageNumber = 1; pageNumber <= MAX_OWNED_PAGES; pageNumber += 1) {
        const page = await modelPage(
          key,
          `page_size=${PAGE_SIZE}&self=true&sort_by=created_at&page_number=${pageNumber}`,
        );
        items.push(...page.items);
        if (!page.hasMore) return items;
      }
      throw new Error("Fish Audio returned too many voice pages. Narrow the account's voice library and try again.");
    })(),
  ]);
  return [...publicPage.items, ...owned];
}

async function searchModels(key: string, query: string): Promise<unknown[]> {
  const title = encodeURIComponent(query);
  const pages = await Promise.all([
    modelPage(key, `page_size=${PAGE_SIZE}&sort_by=task_count&title=${title}`),
    modelPage(key, `page_size=${PAGE_SIZE}&self=true&title=${title}`),
  ]);
  return pages.flatMap((page) => page.items);
}

export interface VoiceSearch {
  query?: string;
  current?: string;
}

export async function listVoices(key: string, { query, current }: VoiceSearch = {}): Promise<Voice[]> {
  const trimmed = query?.trim() ?? "";
  const pastedId = fishVoiceId(trimmed);
  const voices = pastedId
    ? [await modelById(key, pastedId)].filter((voice) => voice !== undefined)
    : (trimmed ? await searchModels(key, trimmed) : await popularAndOwnedModels(key)).flatMap((item) => toVoice(item) ?? []);
  if (!trimmed && current && fishVoiceId(current) === current && !voices.some((voice) => voice.id === current)) {
    // The list already loaded: a current voice this key cannot read (private, or a passing Fish error) only goes unnamed.
    const voice = await modelById(key, current).catch(() => undefined);
    if (voice) voices.unshift(voice);
  }
  return [...new Map(voices.map((voice) => [voice.id, voice])).values()];
}

export async function synthesize(
  text: string,
  voiceId: string,
  key: string,
  model: FishTtsModel = DEFAULT_FISH_MODEL,
): Promise<Audio> {
  let res: Response;
  try {
    res = await fetch(`${API}/v1/tts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "audio/mpeg",
        model,
      },
      body: JSON.stringify({
        text,
        reference_id: voiceId,
        format: "mp3",
        sample_rate: 44_100,
        mp3_bitrate: 64,
        latency: "normal",
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Couldn't reach Fish Audio to generate speech — check your connection.");
  }
  if (!res.ok) throw new Error(errorMessage(res.status, "speaking", await safeBody(res)));
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
}
