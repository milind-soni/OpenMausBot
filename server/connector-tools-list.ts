// An engine reads a connector's tools/list once, when its session starts: a list that fails then leaves the whole
// session without connected-app tools. So each backend's last good list stands in for a failed or rate-limited one.

/** Return an exact reply, or an error-only diagnostic when the server could not identify the request. */
export function parseMcpResponse(text: string, id: unknown): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidate = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    "id" in value && value.id !== null && value.id === id && !("method" in value) && ("result" in value || "error" in value);
  const diagnostic = (value: unknown): Record<string, unknown> | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !("id" in value) || value.id !== null || "method" in value) return null;
    const error = "error" in value ? value.error : undefined;
    if (error === null || typeof error !== "object" || Array.isArray(error) || !("message" in error) || typeof error.message !== "string") return null;
    // This is deliberately not a correlated response: it has no id or result to consume or cache.
    return { error };
  };
  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    return candidate(parsed) ? parsed : diagnostic(parsed);
  }
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  return frames.filter(candidate).at(-1) ?? frames.map(diagnostic).filter((frame) => frame !== null).at(-1) ?? null;
}

const lastToolsLists = new Map<string, unknown>();

function toolsListId(payload: unknown): { id: unknown } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const frame = payload as { method?: unknown; id?: unknown };
  return frame.method === "tools/list" && frame.id !== undefined ? { id: frame.id } : null;
}

function toolsResult(text: string, id: unknown): unknown {
  try {
    const frame = parseMcpResponse(text, id);
    if (!frame || frame.id !== id || frame.id === null || "error" in frame) return undefined;
    const result = frame.result;
    return Array.isArray((result as { tools?: unknown } | undefined)?.tools) ? result : undefined;
  } catch {
    return undefined;
  }
}

/** `backend` names the endpoint and credential, so one backend's list is never served for another. */
export async function withToolsListFallback(
  backend: string,
  payload: unknown,
  send: () => Promise<Response>,
): Promise<Response> {
  const request = toolsListId(payload);
  if (!request) return send();
  const cached = lastToolsLists.get(backend);
  const fallback = () => Response.json({ jsonrpc: "2.0", id: request.id, result: cached });
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (cached === undefined) throw error;
    return fallback();
  }
  if (response.ok) {
    const result = toolsResult(await response.clone().text(), request.id);
    if (result !== undefined) lastToolsLists.set(backend, result);
  } else if (cached !== undefined && (response.status >= 500 || response.status === 429)) {
    await response.body?.cancel();
    return fallback();
  }
  return response;
}
