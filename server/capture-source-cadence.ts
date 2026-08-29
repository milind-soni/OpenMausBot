/**
 * Source-health freshness is based on the source's expected capture cadence,
 * not on one global interval. A successful empty receipt is still a receipt:
 * this is especially important for event-driven sources such as Google
 * Messages, whose bridge heartbeat can be current even when no message has
 * arrived.
 */

export type CaptureSourceCadence = "fast" | "waking-delta" | "daily" | "default";

export interface CaptureSourceFreshnessPolicy {
  cadence: CaptureSourceCadence;
  expectedMaxAgeMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const CAPTURE_SOURCE_CADENCE_MAX_AGE_MS = {
  fast: 15 * MINUTE_MS,
  "waking-delta": 7 * HOUR_MS,
  daily: 26 * HOUR_MS,
  default: 2 * HOUR_MS,
} satisfies Readonly<Record<CaptureSourceCadence, number>>;

const FAST_SOURCE_IDS = new Set(["plaud", "google-messages"]);
const DAILY_SOURCE_IDS = new Set(["github", "mercury", "whoop", "hevy"]);

function cadenceForSource(sourceId: string): CaptureSourceCadence {
  if (
    /^gmail(?:-account-\d+)?$/.test(sourceId)
    || /^calendar(?:-account-\d+)?$/.test(sourceId)
    || FAST_SOURCE_IDS.has(sourceId)
    || sourceId === "messages"
  ) return "fast";
  if (DAILY_SOURCE_IDS.has(sourceId)) return "daily";
  if (/^drive(?:-account-\d+)?$/.test(sourceId)) return "waking-delta";

  // Browser sources are normally refreshed when the desktop wakes and then
  // reconciled as a delta. Specific fast/daily sources are handled above.
  if (
    sourceId.startsWith("ai-")
    || ["chrome-history", "local-inbox", "monarch", "youtube"].includes(sourceId)
  ) {
    return "waking-delta";
  }
  return "default";
}

export function captureSourceFreshnessPolicy(sourceId: string): CaptureSourceFreshnessPolicy {
  const cadence = cadenceForSource(sourceId);
  return { cadence, expectedMaxAgeMs: CAPTURE_SOURCE_CADENCE_MAX_AGE_MS[cadence] };
}
