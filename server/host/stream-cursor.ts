/** The sequence number in an event stream cursor (`<stream id>:<seq>`), or null when it names another stream or none. */
export function streamCursorSeq(raw: string | string[] | undefined, streamId: string): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const [stream, seq] = value.split(":");
  if (stream !== streamId) return null;
  const parsed = Number(seq);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
