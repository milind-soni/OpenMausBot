// Small, stateless probes for CLI onboarding. The caller owns consent for the
// metered completion and persistence; neither credentials nor replies are logged.
export const API_ENDPOINTS = [
  { id: "openai", label: "OpenAI API", url: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/settings/keys" },
  { id: "groq", label: "Groq", url: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys" },
] as const;

export function normalizeApiUrl(value: string): string {
  const input = value.trim();
  const invalid = () => new Error("Enter an HTTPS API base URL without credentials, a query, or a fragment. HTTP is allowed only for localhost.");
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    // Reject invisible URL characters and ambiguous authority/path separators.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0020\u007f\\?#]/u.test(input) || url.username || url.password ||
    input.slice(input.indexOf("://") + 3).split("/")[0]?.includes("@") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  ) throw invalid();
  return url.href.replace(/\/+$/u, "");
}

class SetupApiError extends Error {}

function httpFailure(status: number, completion: boolean): SetupApiError {
  const prefix = `API returned HTTP ${status}.`;
  if (status === 401 || status === 403) return new SetupApiError(`${prefix} Check the API key and its access permissions.`);
  if (status === 402) return new SetupApiError(`${prefix} Check the provider's credits and billing settings.`);
  if (status === 429) return new SetupApiError(`${prefix} A rate or quota limit was reached. Check credits and limits, then try again later.`);
  if (status >= 300 && status < 400) return new SetupApiError(`${prefix} Redirects are not followed. Use the provider's direct API base URL.`);
  if (completion && [400, 404, 422].includes(status)) return new SetupApiError(`${prefix} Check the model ID and access, or choose a model that supports Chat Completions at this API URL.`);
  if (status === 404) return new SetupApiError(`${prefix} Check the API base URL: it must provide a /models endpoint.`);
  if (status >= 500) return new SetupApiError(`${prefix} The provider is unavailable. Try again later.`);
  return new SetupApiError(`${prefix} Check the API URL and provider settings, then try again.`);
}

async function setupJson(url: string, key: string, body?: Record<string, unknown>): Promise<unknown> {
  const base = normalizeApiUrl(url);
  // The wizard trims newly pasted keys. Existing credentials must be tested
  // exactly as the runtime will send them, not silently repaired only here.
  const token = key;
  // Header credentials must not contain control characters or whitespace.
  // eslint-disable-next-line no-control-regex
  if (!token || /[\u0000-\u0020\u007f]/u.test(token)) throw new SetupApiError("Enter a non-empty API key without spaces or line breaks.");
  const completion = body !== undefined;
  const operation = completion ? "The test reply" : "The model list";
  const timeoutMs = completion ? 30_000 : 8_000;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Include reading the response body in the deadline, not only headers.
    return await Promise.race([
      (async () => {
        const response = await fetch(`${base}${completion ? "/chat/completions" : "/models"}`, {
          method: completion ? "POST" : "GET",
          headers: { authorization: `Bearer ${token}`, ...(completion ? { "content-type": "application/json" } : {}) },
          ...(completion ? { body: JSON.stringify(body) } : {}),
          signal: abort.signal,
          redirect: "error",
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw httpFailure(response.status, completion);
        }
        try { return await response.json(); }
        catch { throw new SetupApiError(`${operation} returned invalid JSON. Check that the API URL supports the OpenAI-compatible API.`); }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new SetupApiError(`${operation} timed out after ${timeoutMs / 1000} seconds. Check the connection and try again.`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof SetupApiError) throw error;
    // fetch errors can contain a URL, echoed credentials, or provider content.
    // Deliberately expose neither their message nor their cause.
    throw new SetupApiError("Could not reach the API. Check the network and direct API URL; redirects are not followed.");
  } finally {
    clearTimeout(timer);
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export async function fetchSetupModels(url: string, key: string): Promise<Array<{ id: string; label: string }>> {
  const json = record(await setupJson(url, key));
  const models = new Map<string, { id: string; label: string }>();
  for (const entry of Array.isArray(json?.data) ? json.data : []) {
    const item = record(entry);
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    // Model IDs and display labels reach the terminal; block control sequences.
    // eslint-disable-next-line no-control-regex
    if (!id || /[\u0000-\u001f\u007f]/u.test(id) || models.has(id)) continue;
    // eslint-disable-next-line no-control-regex
    const name = typeof item?.name === "string" ? item.name.replace(/[\u0000-\u001f\u007f]/gu, "").trim() : "";
    models.set(id, { id, label: name || id });
  }
  if (!models.size) throw new SetupApiError("The API returned no usable models. Check the API URL and model access, or enter a model ID from your provider manually.");
  return [...models.values()];
}

/** Call only after consent, passing the effective instance's provider routing. */
export async function verifySetupCompletion(url: string, key: string, model: string, provider?: string): Promise<void> {
  const id = model.trim();
  // Keep manually entered IDs safe to show in the terminal and saved setup.
  // eslint-disable-next-line no-control-regex
  if (!id || /[\u0000-\u001f\u007f]/u.test(id)) throw new SetupApiError("Choose a non-empty model ID without control characters.");
  const host = new URL(normalizeApiUrl(url)).hostname.toLowerCase();
  // Mirror OpenAICompatDriver's OpenRouter-only routing, without inheriting
  // environment overrides that the caller may have deliberately disabled.
  const pinProvider = provider && (host === "openrouter.ai" || host.endsWith(".openrouter.ai"));
  const json = record(await setupJson(url, key, {
    model: id,
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    stream: false,
    ...(pinProvider ? { provider: { order: [provider], allow_fallbacks: false } } : {}),
  }));
  const choice = record(Array.isArray(json?.choices) ? json.choices[0] : undefined);
  const message = record(choice?.message);
  if (message?.role !== "assistant" || typeof message.content !== "string" || !message.content.trim()) {
    throw new SetupApiError("The API did not return an assistant text reply. Choose a model that supports Chat Completions, then try again.");
  }
}
