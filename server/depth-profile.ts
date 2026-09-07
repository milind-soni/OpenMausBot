// How much work an answer is supposed to show.
//
// A bot's persona says who it is; the section context says what the team is
// doing; neither says what a finished answer looks like. Without that, the
// shape of a reply is whatever the underlying CLI happens to default to —
// and the coding CLIs default to terse, which is wrong for a bot whose job
// is analysis.
//
// Three profiles, because two is not enough (a short answer and a report are
// different things, but so is "normal") and four is a menu nobody reads.
//
// `standard` deliberately emits NOTHING. Every bot that predates this
// setting resolves to it, so turning this on changes no existing behaviour
// until someone opts a bot into quick or deep. That also keeps the emitted
// text byte-stable per bot, which matters because this rides the cached
// system prompt: a value that varied per turn would break the provider's
// prefix cache on every message.
export const DEPTH_PROFILES = ["quick", "standard", "deep"] as const;

export type DepthProfile = (typeof DEPTH_PROFILES)[number];

export const DEFAULT_DEPTH: DepthProfile = "standard";

export function isDepthProfile(value: unknown): value is DepthProfile {
  return typeof value === "string" && (DEPTH_PROFILES as readonly string[]).includes(value);
}

/** Stored values come from JSON on disk and from the API, so anything that
 * is not one of the three falls back rather than reaching a prompt. */
export function resolveDepthProfile(stored: unknown): DepthProfile {
  return isDepthProfile(stored) ? stored : DEFAULT_DEPTH;
}

const QUICK = [
  " Answer at the length the question deserves: a one-line question gets a one-line answer.",
  "Lead with the answer itself — no preamble, no restating the question, no summary of what you are about to do.",
  "Skip headings and tables unless the answer is genuinely a list or a comparison.",
].join(" ");

const DEEP = [
  " This bot's job is analysis, so a finished piece of work is a report, not a verdict.",
  "Lead with what you found, not with how you worked.",
  "Say what you actually examined — name the sources and, where it matters, when you looked.",
  "Keep what you verified separate from what you inferred, and say which is which.",
  "Name what you could not check and why. An honest gap is worth more than a plausible-looking number:" +
    " never present an estimate as a measurement, and never fill a hole with something you did not observe.",
  "Close with what is still open — the questions your work raised and did not settle.",
  "Use headings and tables where they earn their place; this chat renders Markdown.",
  "Put the report in your reply. Writing it to a file and leaving a summary here hides the work" +
    " from the person who asked for it — save a file as well only when they asked for one.",
].join(" ");

/** The layer itself. Empty for `standard`, so the default costs no tokens. */
export function depthProfileSystemPrompt(stored: unknown): string {
  const profile = resolveDepthProfile(stored);
  if (profile === "quick") return QUICK;
  if (profile === "deep") return DEEP;
  return "";
}
