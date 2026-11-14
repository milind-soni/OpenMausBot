// Ollama picks a context window from the machine's VRAM unless told otherwise: 4,096 tokens below 23 GB, which on a
// laptop is less than our system prompt and tool list, and it drops the excess without an error. The OpenAI and Anthropic
// routes every engine here speaks cannot set it (OpenAI's request has no such field), and /api/ps only knows a model once
// it runs. So a model gets a second name that carries the window: /api/create from the same weights copies nothing but a
// small manifest, and every engine can use that name as is.
import { totalmem } from "node:os";

const SUFFIX = /-omb-(\d+)k$/;
const MIN_WINDOW = 16_384;
const MAX_WINDOW = 65_536;
/** An estimate, generous on purpose: what a token of window costs in memory varies with the architecture. */
const WINDOW_BYTES_PER_TOKEN = 64 * 1024;
/** What macOS lets the GPU wire by default, and a fair share of a PC's memory. */
const MEMORY_SHARE = 0.75;

const nameFor = (model: string, window: number) => `${model.includes(":") ? model : `${model}:latest`}-omb-${window / 1024}k`;

export const isContextName = (model: string) => SUFFIX.test(model);

/** The name a person picked, for one of ours coming back in a server's lists. */
export const pickedName = (model: string) => model.replace(SUFFIX, "");

/** The largest power of two that leaves the weights room, between what an agent needs and what stays fast on a laptop. */
export function windowFor(modelBytes: number | undefined, trained: number | undefined, memoryBytes = totalmem()): number {
  const room = modelBytes === undefined ? 0 : memoryBytes * MEMORY_SHARE - modelBytes;
  let window = MIN_WINDOW;
  while (window < MAX_WINDOW && room / WINDOW_BYTES_PER_TOKEN >= window * 2) window *= 2;
  return trained && trained < window ? trained : window;
}

interface ShowFacts {
  /** A window the person set in a Modelfile. */
  pinned?: number;
  trained?: number;
  remote: boolean;
}

export function showFacts(show: unknown): ShowFacts {
  const row = (show && typeof show === "object" ? show : {}) as { parameters?: unknown; model_info?: unknown; remote_host?: unknown; remote_model?: unknown };
  const pinned = typeof row.parameters === "string" ? /^\s*num_ctx\s+(\d+)\s*$/m.exec(row.parameters)?.[1] : undefined;
  const info = row.model_info && typeof row.model_info === "object" ? Object.entries(row.model_info) : [];
  const trained = info.find(([key, value]) => key.endsWith(".context_length") && typeof value === "number" && value > 0)?.[1] as number | undefined;
  return { ...(pinned ? { pinned: Number(pinned) } : {}), ...(trained ? { trained } : {}), remote: Boolean(row.remote_host || row.remote_model) };
}

export interface ServedModel {
  model: string;
  /** Known only once decided; absent leaves the catalog's own figure. */
  window?: number;
}

const decided = new Map<string, ServedModel>();
const checkedAt = new Map<string, number>();
const deciding = new Map<string, Promise<ServedModel>>();
const cacheKey = (origin: string, model: string) => `${origin}\n${model}`;

/** What was decided for this model, without asking the server. */
export function servedModel(origin: string, model: string): ServedModel | undefined {
  return decided.get(cacheKey(origin, model));
}

async function json(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function decide(origin: string, model: string, fetchImpl: typeof fetch, memoryBytes: number | undefined): Promise<ServedModel> {
  const facts = showFacts(await json(fetchImpl, `${origin}/api/show`, post({ model }), 3_000));
  if (facts.remote) return { model };
  if (facts.pinned) return { model, window: facts.pinned };
  const running = await json(fetchImpl, `${origin}/api/ps`, {}, 3_000).catch(() => null) as { models?: Array<{ name?: unknown; model?: unknown; context_length?: unknown }> } | null;
  const loaded = running?.models?.find((entry) => entry.name === model || entry.model === model || entry.name === `${model}:latest`)?.context_length;
  const tags = await json(fetchImpl, `${origin}/api/tags`, {}, 3_000).catch(() => null) as { models?: Array<{ name?: unknown; size?: unknown }> } | null;
  const row = tags?.models?.find((entry) => entry.name === model || entry.name === `${model}:latest`);
  const window = windowFor(typeof row?.size === "number" ? row.size : undefined, facts.trained, memoryBytes);
  // Already running with enough, from the person's OLLAMA_CONTEXT_LENGTH or a large machine's default: leave it so.
  if (typeof loaded === "number" && loaded >= window) return { model, window: loaded };
  const name = nameFor(model, window);
  await json(fetchImpl, `${origin}/api/create`, post({ model: name, from: model, parameters: { num_ctx: window }, stream: false }), 15_000);
  return { model: name, window };
}

const RETRY_AFTER_MS = 60_000;
const RECHECK_AFTER_MS = 60_000;
const forgetLater = (forget: () => void) => { setTimeout(forget, RETRY_AFTER_MS).unref(); };

/** Never throws: anything that goes wrong (another server on this port, an older Ollama, a name it refuses) leaves the
 * model as it was for a minute, then tries again. */
export function serveWithWindow(origin: string, model: string, fetchImpl: typeof fetch = fetch, memoryBytes?: number): Promise<ServedModel> {
  if (isContextName(model)) return Promise.resolve({ model });
  const key = cacheKey(origin, model);
  const known = decided.get(key);
  if (known && (known.model === model || Date.now() - (checkedAt.get(key) ?? 0) < RECHECK_AFTER_MS)) return Promise.resolve(known);
  const running = deciding.get(key);
  if (running) return running;
  // Someone tidying `ollama list` may have removed our name. Only a clear "not found" counts: a busy server is still fine.
  const stillThere = known
    ? fetchImpl(`${origin}/api/show`, { ...post({ model: known.model }), signal: AbortSignal.timeout(3_000) }).then((response) => response.status !== 404, () => true)
    : Promise.resolve(false);
  const attempt = stillThere
    .then((there) => there ? known! : decide(origin, model, fetchImpl, memoryBytes))
    .then((served) => { decided.set(key, served); checkedAt.set(key, Date.now()); return served; })
    .catch(() => {
      const unchanged = { model };
      decided.set(key, unchanged);
      forgetLater(() => { if (decided.get(key) === unchanged) decided.delete(key); });
      return unchanged;
    })
    .finally(() => { deciding.delete(key); });
  deciding.set(key, attempt);
  return attempt;
}

const answersAsOllama = new Map<string, Promise<boolean>>();

/** The one thing only Ollama answers: `/api/version` with a version. */
export function isOllama(origin: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let answer = answersAsOllama.get(origin);
  if (!answer) {
    answer = json(fetchImpl, `${origin}/api/version`, {}, 2_000)
      .then((body) => typeof (body as { version?: unknown } | null)?.version === "string")
      .catch(() => false);
    answersAsOllama.set(origin, answer);
    // A server that was simply not up yet must not be written off for good.
    void answer.then((yes) => { if (!yes) forgetLater(() => answersAsOllama.delete(origin)); });
  }
  return answer;
}

export function forgetServedModels(): void {
  decided.clear();
  checkedAt.clear();
  deciding.clear();
  answersAsOllama.clear();
}
