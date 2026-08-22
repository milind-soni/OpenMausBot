const MAX_RENDERER_ERROR_TEXT = 8_000;

/** Remove user identity and local-path material before renderer diagnostics
 * cross the process boundary. The server applies its independent structured
 * secret redaction again before any telemetry sink receives the payload. */
export function redactRendererErrorText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .slice(0, MAX_RENDERER_ERROR_TEXT)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "«redacted-email»")
    .replace(/\b((?:user(?:name|[_-]?id)?|account[_-]?id)\s*[:=]\s*)[^\s,;]+/gi, "$1«redacted-id»")
    .replace(/\b(?:Authorization|Cookie)\s*:\s*[^\r\n]+/gi, "«redacted-header»")
    .replace(/([?&](?:access[_-]?token|token|auth|(?:api[_-]?)?key|secret|session)=)[^&\s]+/gi, "$1«redacted-value»")
    .replace(/file:\/\/\/[^\s)]+/gi, "file:///«redacted-path»")
    .replace(/\b[A-Za-z]:\\(?:[^\\\r\n:]+\\)+[^\\\r\n:)]*/g, "«redacted-path»")
    .replace(/(^|[\s(])\/(?:[^/\s:()]+\/)+[^/\s:()]+/gm, "$1«redacted-path»");
}
