// Fish Audio text to speech. The API key stays on the harness: the renderer
// receives only voice metadata and synthesized audio bytes.
const API = (process.env.OMB_FISH_AUDIO_API || "https://api.fish.audio").replace(/\/+$/, "");
const MODEL = "s2.1-pro";
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

/** Verify the exact permission the voice picker needs. */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    // The public catalog is intentionally readable without authentication,
    // so it cannot prove a supplied key. `self=true` crosses the account
    // boundary and returns 401 for an absent or invalid Bearer token.
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

async function modelPage(key: string, query: string): Promise<{ items: unknown[]; hasMore: boolean }> {
  let response: Response;
  try {
    response = await fetch(`${API}/model?${query}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Couldn't reach Fish Audio to list voices — check your connection.");
  }
  const body = await safeBody(response);
  if (!response.ok) throw new Error(errorMessage(response.status, "listing voices", body));
  if (!body || typeof body !== "object") return { items: [], hasMore: false };
  const page = body as Record<string, unknown>;
  return {
    items: Array.isArray(page.items) ? page.items : [],
    hasMore: page.has_more === true,
  };
}

export async function listVoices(key: string): Promise<Voice[]> {
  // Fish defaults to ten results and excludes private account voices from
  // the public catalog. Load the popular public page and every page belonging
  // to this account, so a user's 101st custom voice remains selectable.
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
  const items = [...publicPage.items, ...owned];
  const voices = items.flatMap((item): Voice[] => {
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    // `/model` includes SVC models and account models that are still
    // training or have failed. Only trained TTS models are valid
    // `reference_id` values for `/v1/tts`.
    if (model.type !== "tts" || model.state !== "trained") return [];
    const id = typeof model._id === "string" ? model._id.trim() : "";
    if (!id) return [];
    const label = typeof model.title === "string" && model.title.trim() ? model.title.trim() : "Voice";
    const description =
      typeof model.description === "string" && model.description.trim()
        ? model.description.trim().slice(0, MAX_ERROR_LENGTH)
        : undefined;
    return [{ id, label, description }];
  });
  return [...new Map(voices.map((voice) => [voice.id, voice])).values()];
}

export async function synthesize(text: string, voiceId: string, key: string): Promise<Audio> {
  let res: Response;
  try {
    res = await fetch(`${API}/v1/tts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "audio/mpeg",
        model: MODEL,
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
