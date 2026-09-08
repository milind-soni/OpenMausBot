/** Isolate local bindings by task, message, block offset and source fingerprint. */
export function interactiveStateKey(
  threadId: string,
  messageId: string,
  offset: number,
  source: string,
): string {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `omb-interactive:v1:${threadId}:${messageId}:${offset}:${source.length}:${hash >>> 0}`;
}
/** Copy an admissible JSON state envelope, rejecting excess size and prototype keys. */
export function boundedInteractiveState(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  try {
    const text = JSON.stringify(value);
    if (text.length > 16 * 1024 || /"(?:__proto__|constructor|prototype)"\s*:/.test(text)) return;
    return JSON.parse(text);
  } catch {
    return;
  }
}
/** Restore only bounded local bindings; unavailable or corrupt storage starts fresh. */
export function readInteractiveState(key?: string): Record<string, unknown> | undefined {
  try {
    return key ? boundedInteractiveState(JSON.parse(localStorage.getItem(key) ?? "null")) : undefined;
  } catch {
    return;
  }
}
