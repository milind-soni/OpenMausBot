/** Masks whole credentials in `text`; unless flushing, holds back a trailing piece that could start one, so a
 * credential split across chunks or requests is never shown in halves. */
export function maskSecretHalves(text: string, secrets: readonly string[], safe: (text: string) => string, flush: boolean): { visible: string; held: string } {
  let combined = text;
  for (const secret of secrets) if (secret) combined = combined.split(secret).join("[redacted]");
  let hold = 0;
  if (!flush) for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, combined.length); length > hold; length--) {
      if (combined.endsWith(secret.slice(0, length))) { hold = length; break; }
    }
  }
  return { visible: safe(hold ? combined.slice(0, -hold) : combined), held: hold ? combined.slice(-hold) : "" };
}
