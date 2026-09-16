// Phase 3 part 3 — the tool-less verifier.
//
// One model call with no tools reads the acceptance text (the task's
// body), the result digest, the gate results and the bot's last words, and
// answers in strict JSON. A parse failure is "not complete": the harness
// never turns prose into a pass. A gate that failed caps the verdict at
// "not complete" whatever the model says — the gates are ground truth.
import type { TaskGates } from "./task-board.ts";

export interface Verdict {
  isComplete: boolean;
  /** 0..1 */
  confidence: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  nextAction: string;
  /** False when the model's answer could not be read as JSON. */
  readable: boolean;
}

export interface VerifierInput {
  title: string;
  body: string;
  result: string | null;
  gates: TaskGates | null;
  /** The bot's own text messages from the run, newest last. */
  botSaid: string[];
}

const TEXT_CAP = 6_000;
const clip = (text: string, max = TEXT_CAP) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The marker lets the fake engine recognise a verifier call; the real
 * model reads it as the role it is playing. */
export function verifierPrompt(input: VerifierInput): string {
  const gates = input.gates
    ? `${input.gates.scope}\n${input.gates.results.filter((r) => r.status !== "pass").map((r) => `${r.name} output:\n${clip(r.tail, 1_500)}`).join("\n")}`
    : "No gates were declared for this folder; nothing was run.";
  return [
    "You are the VERIFIER. You have no tools. Judge only from what is below; do not assume work happened because it was described.",
    "",
    `Task: ${input.title}`,
    `Acceptance (what the person asked for):\n${clip(input.body || "(no acceptance text — judge against the title)")}`,
    "",
    `Result recorded by the harness:\n${clip(input.result ?? "(none)")}`,
    "",
    `Checks run by the harness (ground truth):\n${gates}`,
    "",
    `What the bot said, newest last:\n${input.botSaid.length ? input.botSaid.map((line) => `- ${clip(line, 1_200)}`).join("\n") : "(nothing)"}`,
    "",
    "Answer with one JSON object and nothing else:",
    '{"is_complete": true|false, "confidence": 0..1, "evidence_for": ["…"], "evidence_against": ["…"], "next_action": "one sentence, or empty when complete"}',
    "A claim without evidence in the result or the checks is not evidence. A failed check means not complete.",
    "next_action must be something the bot can do on its own in one more attempt with nobody watching: never \"ask the user\", \"clarify\" or \"confirm\". If the request and the checks conflict, say which reading to take and why.",
  ].join("\n");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean).slice(0, 8) : [];
}

export function parseVerdict(text: string, context: { gatesFailed?: boolean } = {}): Verdict {
  const unreadable: Verdict = { isComplete: false, confidence: 0, evidenceFor: [], evidenceAgainst: ["the verifier's answer could not be read as JSON"], nextAction: "", readable: false };
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return unreadable;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return unreadable;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.is_complete !== "boolean") return unreadable;
  const confidenceRaw = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  const verdict: Verdict = {
    isComplete: parsed.is_complete,
    confidence: Math.min(1, Math.max(0, confidenceRaw)),
    evidenceFor: stringList(parsed.evidence_for),
    evidenceAgainst: stringList(parsed.evidence_against),
    nextAction: typeof parsed.next_action === "string" ? parsed.next_action.trim().slice(0, 400) : "",
    readable: true,
  };
  if (verdict.isComplete && context.gatesFailed) {
    verdict.isComplete = false;
    verdict.evidenceAgainst = ["a gate failed; the checks outrank the model's judgement", ...verdict.evidenceAgainst];
  }
  return verdict;
}

export function verdictLine(verdict: Verdict): string {
  const confidence = verdict.confidence.toFixed(2);
  if (verdict.isComplete) return `Verified: complete (confidence ${confidence}).`;
  const why = verdict.evidenceAgainst[0] ? ` — ${verdict.evidenceAgainst[0]}` : "";
  const next = verdict.nextAction ? ` Next: ${verdict.nextAction}` : "";
  return `Verified: not complete (confidence ${confidence})${why}.${next}`;
}
