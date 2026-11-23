// The top bun's line: what a run does, in one short sentence a small model writes from the ask and the steps. The ask
// itself stands in until it arrives, and whenever it can't.
import { layerLabel } from "./draft.ts";
import { appMeta } from "./apps.ts";
import type { BurgerLayer } from "./layers.ts";

export const SUMMARY_LINE_MAX = 90;

export function summaryPrompt(ask: string, layers: readonly Pick<BurgerLayer, "kind" | "words" | "app">[]): string {
  const steps = layers.map((layer, index) => `${index + 1}. ${layer.kind === "app" && layer.app ? `${appMeta(layer.app).label}: ` : ""}${layerLabel(layer)}`);
  return [
    "Name what this saved workflow does in one short line, at most 70 characters.",
    'Start with a verb in the third person and name the real things it touches, like "Emails this week\'s sales sheet to Priya and archives it".',
    "Write it in the language of the request. Reply with the line only: no quotes, no full stop at the end.",
    "",
    `Request: ${ask.slice(0, 600)}`,
    "Steps:",
    ...steps.slice(0, 20),
  ].join("\n");
}

/** The model's reply as one line, or null when it isn't one. */
export function cleanSummary(reply: string | null | undefined): string | null {
  if (!reply) return null;
  const line = reply.trim().split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  const bare = line.replace(/^(?:summary|line)\s*:\s*/i, "").replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").replace(/[.。]+$/, "").trim();
  if (bare.length < 4) return null;
  return bare.length > SUMMARY_LINE_MAX ? `${bare.slice(0, SUMMARY_LINE_MAX - 1).trimEnd()}…` : bare;
}
