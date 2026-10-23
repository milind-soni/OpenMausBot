// No import from server/drivers: they pull in the whole provider stack.
import { hasNativeAutoReview, supportsApprovalMode } from "../../shared/approval-mode.ts";

export interface EngineCapabilities {
  resume: boolean;
  nativeReviewer: boolean;
  full: boolean;
  edits: boolean;
  stepCap?: number;
  subagents: boolean;
}

const CHAT_STEP_CAP = 64;

// transcript: the engine sends the thread as SendTurnInput.transcript messages, so the turn text must not replay it inline too.
type EngineRow = Pick<EngineCapabilities, "resume" | "stepCap"> & { transcript?: true };

const CHAT_ROW: EngineRow = { resume: false, stepCap: CHAT_STEP_CAP, transcript: true };

const ENGINES: Readonly<Record<string, EngineRow>> = {
  claudeAgent: { resume: true },
  codex: { resume: true },
  piAgent: { resume: true },
  antigravityAgent: { resume: true },
  grokAgent: { resume: true },
  geminiAgent: { resume: true },
  kimiAgent: { resume: true },
  droidAgent: { resume: true },
  cursorAgent: { resume: true },
  museCode: { resume: true },
  opencodeGo: { resume: true },
  qwenAgent: { resume: true },
  hermesAgent: { resume: true },
  deepseekAgent: { resume: true },
  clineAgent: { resume: true },
  customAcp: { resume: true },
  "openai-compat": CHAT_ROW,
  grok: CHAT_ROW,
  minimax: CHAT_ROW,
  mistral: CHAT_ROW,
  cerebras: CHAT_ROW,
  groq: CHAT_ROW,
  meta: CHAT_ROW,
};

export function replaysTranscriptNatively(driverKind: string | undefined): boolean {
  return driverKind !== undefined && Object.hasOwn(ENGINES, driverKind) && ENGINES[driverKind]!.transcript === true;
}

export const ENGINE_KINDS: readonly string[] = Object.keys(ENGINES);

export function engineCapabilities(driverKind: string | undefined): EngineCapabilities {
  const row = driverKind !== undefined && Object.hasOwn(ENGINES, driverKind) ? ENGINES[driverKind] : undefined;
  return {
    resume: row?.resume ?? false,
    nativeReviewer: hasNativeAutoReview(driverKind),
    full: supportsApprovalMode(driverKind, "full"),
    edits: supportsApprovalMode(driverKind, "edits"),
    ...(row?.stepCap === undefined ? {} : { stepCap: row.stepCap }),
    subagents: false,
  };
}
