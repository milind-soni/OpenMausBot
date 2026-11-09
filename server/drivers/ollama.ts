// Ollama's own API (docs/api.md in github.com/ollama/ollama): /api/tags lists the pulled models with their size and
// details, /api/version answers with a version, and /api/show names a model's capabilities ("tools", "vision") from
// v0.6.4. A default install takes no key on these routes or on the OpenAI-compatible ones under /v1.
import type { LocalModel, LocalModelThinking as OllamaThinking, OllamaState, OllamaStatus } from "../../shared/local-model.ts";
import { isContextName } from "./ollama-context.ts";

export const OLLAMA_PORT = "11434";
/** Where `ollama serve` listens unless OLLAMA_HOST says otherwise. */
export const OLLAMA_LOCAL_URLS: readonly string[] = ["http://127.0.0.1:11434", "http://localhost:11434"];
/** Ollama ignores the key; the OpenAI-compatible request still carries one. */
export const OLLAMA_PLACEHOLDER_KEY = "ollama";
export const OLLAMA_PULL_COMMAND = "ollama pull llama3.2";

/** A pulled model, as /api/tags and /api/show describe it. */
export type OllamaModel = LocalModel;
export type { OllamaState, OllamaStatus };

/** The server's own address: the base URL without the /v1 the OpenAI-compatible routes sit under. */
export function ollamaOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function onOllamaPort(url: string): boolean {
  try { return new URL(url).port === OLLAMA_PORT; } catch { return false; }
}

const EMBEDDING = /embed|(?:^|[/:-])bge-|minilm/i;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The chat models in an /api/tags answer, or null when the answer is not one. An embedding model answers no chat (its
 * name only counts where Ollama gives no family), and a name that carries a context window is the model it was made from. */
export function ollamaTags(payload: unknown): OllamaModel[] | null {
  const rows = payload && typeof payload === "object" ? (payload as { models?: unknown }).models : undefined;
  if (!Array.isArray(rows)) return null;
  const seen = new Set<string>();
  const models: OllamaModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as { name?: unknown; model?: unknown; size?: unknown; details?: unknown };
    const name = text(entry.name) ?? text(entry.model);
    const details = (entry.details && typeof entry.details === "object" ? entry.details : {}) as { family?: unknown; families?: unknown; parameter_size?: unknown; quantization_level?: unknown };
    const families = [details.family, ...(Array.isArray(details.families) ? details.families : [])].filter((family): family is string => typeof family === "string");
    if (!name || seen.has(name) || isContextName(name) || families.some((family) => /bert$/i.test(family)) || (!families.length && EMBEDDING.test(name))) continue;
    seen.add(name);
    const parameters = text(details.parameter_size), quantization = text(details.quantization_level);
    models.push({
      name,
      ...(typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size > 0 ? { bytes: entry.size } : {}),
      ...(parameters ? { parameters } : {}),
      ...(quantization ? { quantization } : {}),
    });
  }
  return models;
}

function thinkingControls(described: unknown): OllamaThinking {
  const values = described && typeof described === "object" ? (described as { values?: unknown }).values : undefined;
  const choices = Array.isArray(values)
    ? values.flatMap((value) => value === false ? ["off"] : value === true ? ["on"] : text(value) ? [text(value)!] : [])
    : [];
  return choices.length ? { choices, described: true } : { choices: ["off", "on"], described: false };
}

/** What /api/show says a model can do; empty when the server predates capabilities. */
export function showCapabilities(show: unknown): Pick<OllamaModel, "tools" | "vision" | "thinking"> {
  const { capabilities, thinking } = (show && typeof show === "object" ? show : {}) as { capabilities?: unknown; thinking?: unknown };
  if (!Array.isArray(capabilities) || !capabilities.every((entry) => typeof entry === "string")) return {};
  const controls = capabilities.includes("thinking") ? thinkingControls(thinking) : undefined;
  return { tools: capabilities.includes("tools"), vision: capabilities.includes("vision"), ...(controls && controls.choices.length > 1 ? { thinking: controls } : {}) };
}

/** The `reasoning_effort` a thinking choice sends on /v1, undefined to leave the model's default. Before /api/show
 * listed a model's controls Ollama refused a level on a model that only thinks or doesn't, so "on" stays unsent there. */
export function thinkingEffort(thinking: OllamaThinking | undefined, choice: string | undefined): string | undefined {
  if (!thinking || !choice || !thinking.choices.includes(choice)) return undefined;
  if (choice === "off") return "none";
  if (choice === "on") return thinking.described ? "high" : undefined;
  return choice;
}

/** False only for a model /api/show says cannot chat. */
function answersChats(show: unknown): boolean {
  const capabilities = show && typeof show === "object" ? (show as { capabilities?: unknown }).capabilities : undefined;
  return !Array.isArray(capabilities) || capabilities.includes("completion");
}

function nobodyListening(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; errors?: unknown } } | undefined)?.cause;
  if (cause?.code === "ECONNREFUSED") return true;
  return Array.isArray(cause?.errors) && cause.errors.length > 0 && cause.errors.every((entry) => (entry as { code?: unknown }).code === "ECONNREFUSED");
}

const timedOut = (error: unknown) => (error as { name?: unknown } | undefined)?.name === "TimeoutError";

const answered = new Map<string, boolean>();

/** Whether this server has answered as Ollama: /api/tags with a list and /api/version with a version (some other servers
 * imitate /api/tags alone). Undefined until asked; a failed version request alone doesn't undo a yes. */
export function answeredAsOllama(url: string): boolean | undefined {
  return answered.get(ollamaOrigin(url));
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Sent as a bearer token, for an Ollama behind a proxy that asks for one. */
  key?: string;
  /** Also ask /api/show what each model can do. */
  capabilities?: boolean;
  /** Where "this computer" is looked for, when not Ollama's defaults. */
  localUrls?: readonly string[];
}

/** Never throws. */
export async function probeOllama(url: string, options: ProbeOptions = {}): Promise<OllamaStatus> {
  const origin = ollamaOrigin(url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const headers = options.key ? { authorization: `Bearer ${options.key}` } : undefined;
  const ask = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${origin}${path}`, { ...init, headers: { ...headers, ...init.headers as Record<string, string> }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  let models: OllamaModel[] | null;
  let version: string | undefined;
  try {
    const [tags, about] = await Promise.all([
      ask("/api/tags"),
      ask("/api/version").then((response) => response.ok ? response.json() : null).catch(() => null),
    ]);
    models = tags.ok ? ollamaTags(await tags.json().catch(() => null)) : null;
    version = text((about as { version?: unknown } | null)?.version);
  } catch (error) {
    if (nobodyListening(error)) return { state: "not-running", url: origin, models: [] };
    return { state: "unreachable", url: origin, models: [], problem: timedOut(error) ? "timeout" : "network" };
  }
  if (models === null) answered.set(origin, false);
  else if (version) answered.set(origin, true);
  else if (!answered.has(origin)) answered.set(origin, false);
  if (!models) return { state: "unreachable", url: origin, models: [], problem: "not-ollama" };
  if (options.capabilities) {
    const asked = await Promise.all(models.map(async (model) => {
      try {
        const response = await ask("/api/show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: model.name }) });
        if (!response.ok) return model;
        const show: unknown = await response.json();
        return answersChats(show) ? { ...model, ...showCapabilities(show) } : null;
      } catch {
        return model;
      }
    }));
    models = asked.filter((model) => model !== null);
  }
  return { state: models.length ? "ready" : "no-models", url: origin, ...(version ? { version } : {}), models };
}

/** What stops an Ollama from answering, for the engine list; null when it can, or when something else answers there. */
export function ollamaUnavailable(status: OllamaStatus, addedAsOllama = false): string | null {
  switch (status.state) {
    case "ready": return null;
    case "no-models": return `Ollama has no models yet. Run \`${OLLAMA_PULL_COMMAND}\`, then check again.`;
    case "not-running": return `Ollama isn't running at ${status.url}. Open the Ollama app or run \`ollama serve\`.`;
    case "unreachable": return status.problem === "not-ollama" ? addedAsOllama ? `Something answers at ${status.url}, but it isn't Ollama.` : null
      : `Can't reach Ollama at ${status.url}${status.problem === "timeout" ? ": it did not answer in time" : ""}. Check the address and that this computer can reach it.`;
  }
}

const RANK: Record<OllamaState, number> = { ready: 0, "no-models": 1, unreachable: 2, "not-running": 3 };

/** Ollama on this computer, or at an address someone set: the first that runs, else the most telling answer. */
export async function findOllama(urls: readonly string[] = [], options: ProbeOptions = {}): Promise<OllamaStatus> {
  const origins = [...new Set([...urls, ...(options.localUrls ?? OLLAMA_LOCAL_URLS)].map(ollamaOrigin))];
  const found = await Promise.all(origins.map((origin) => probeOllama(origin, options)));
  return found.reduce((best, status) => RANK[status.state] < RANK[best.state] ? status : best);
}

/** An OpenAI-compatible instance that is really Ollama: added as Ollama, it answered as Ollama, or it is on Ollama's port
 * and nothing there has answered otherwise. */
export function isOllamaServer(config: unknown): boolean {
  const { url, catalog } = (config && typeof config === "object" ? config : {}) as { url?: unknown; catalog?: unknown };
  if (catalog === "ollama") return true;
  if (catalog !== undefined || typeof url !== "string") return false;
  const answer = answeredAsOllama(url);
  return answer === true || (answer === undefined && onOllamaPort(url));
}

export function forgetOllamaAnswers(): void {
  answered.clear();
}
