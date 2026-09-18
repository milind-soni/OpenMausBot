// ACP is the one native-session family whose prompt is assembled by
// OpenMausBot itself. Keep session-aware instruction composition here so each
// harness receives the same fresh/resume/recovery behavior.
import type { SendTurnInput } from "../../contracts.ts";
import type { PromptSection } from "../../system-prompt.ts";
import {
  acpInstructionSectionHash,
  readAcpInstructionReceipt,
  type AcpInstructionReceipt,
} from "./instruction-receipts.ts";

/** The composition path used for an ACP prompt. */
export type AcpPromptMode = "fresh" | "resume" | "replacement" | "recovery";

/** Inputs needed to compose one ACP `session/prompt` text value. */
export type AcpPromptCompositionInput = {
  turn: SendTurnInput;
  providerInstanceId: string;
  nativeSessionId: string;
  /** True only when session/load (or session/resume) returned a usable result. */
  resumed: boolean;
  /** True when a supplied cursor was rejected before the prompt was sent. */
  resumeRejected?: boolean;
  /** True when the provider-bound prompt actually used the separate bounded
   * recovery transcript (rather than merely receiving one as an available
   * fallback). */
  recoveryTextSent?: boolean;
};

/** The prompt text and receipt state produced by the central composer. */
export type AcpPromptComposition = {
  text: string;
  mode: AcpPromptMode;
  /** Current sections to persist after the protocol result is received. */
  sections: PromptSection[];
  /** The previous receipt used to decide which sections changed. */
  previousReceipt?: AcpInstructionReceipt;
  /** The exact instruction block sent before the current turn text. */
  systemSentText: string;
  /** Current section ids whose replacement text was included. */
  sentSectionIds: string[];
  recoveryTextSent: boolean;
};

const replacementNotice =
  "OpenMausBot instruction replacement: the complete block below replaces any prior OpenMausBot instruction block. "
  + "The current approval policy and mounted tools remain enforced outside the model prompt.";

const updateNotice =
  "OpenMausBot instruction update: the following OpenMausBot sections replace their prior values. "
  + "The current approval policy and mounted tools remain enforced outside the model prompt.";

function systemText(turn: SendTurnInput, sections: readonly PromptSection[]): string {
  return turn.system ?? sections.map((section) => section.text).join("");
}

function withSystem(system: string, text: string): string {
  return system ? `${system}\n\n${text}` : text;
}

function sectionPairs(sections: readonly PromptSection[]): Array<{ id: string; hash: string }> {
  return sections.map((section) => ({ id: section.id, hash: acpInstructionSectionHash(section.text) }));
}

function samePairs(
  left: readonly { id: string; hash: string }[],
  right: readonly { id: string; hash: string }[],
): boolean {
  return left.length === right.length && left.every((pair, index) => {
    const other = right[index];
    return other?.id === pair.id && other.hash === pair.hash;
  });
}

function sameIds(
  left: readonly { id: string }[],
  right: readonly { id: string }[],
): boolean {
  return left.length === right.length && left.every((pair, index) => right[index]?.id === pair.id);
}

function updateText(
  sections: readonly PromptSection[],
  previous: AcpInstructionReceipt,
): string | undefined {
  const previousById = new Map(previous.sections.map((section) => [section.id, section.hash]));
  const currentIds = new Set(sections.map((section) => section.id));
  const currentPairs = sectionPairs(sections);
  const orderChanged = previous.sections.length === currentPairs.length && !sameIds(previous.sections, currentPairs);
  const changed = sections.filter((section) => previousById.get(section.id) !== acpInstructionSectionHash(section.text));
  const removed = previous.sections.filter((section) => !currentIds.has(section.id)).map((section) => section.id);
  if (changed.length === 0 && removed.length === 0 && !orderChanged) return undefined;
  const listed = orderChanged ? sections : changed;

  const entries = listed.map((section) => `Section "${section.id}" (replaces its prior value):\n${section.text}`);
  if (removed.length) entries.push(`Removed section ids: ${removed.map((id) => `"${id}"`).join(", ")}.`);
  return `${updateNotice}\n\n${entries.join("\n\n")}`;
}

function fullComposition(
  system: string,
  currentText: string,
  sections: PromptSection[],
  mode: AcpPromptMode,
  systemSentText = system,
  sentSectionIds = sections.map((section) => section.id),
  previousReceipt?: AcpInstructionReceipt,
  recoveryTextSent = false,
): AcpPromptComposition {
  return {
    text: withSystem(systemSentText, currentText),
    mode,
    sections,
    systemSentText,
    sentSectionIds,
    ...(previousReceipt ? { previousReceipt } : {}),
    recoveryTextSent,
  };
}

/** Compose one ACP prompt using the native session's accepted instruction
 * receipt, preserving the original full-prompt bytes for fresh sessions. */
export function composeAcpPrompt(input: AcpPromptCompositionInput): AcpPromptComposition {
  const sections = input.turn.systemSections ? [...input.turn.systemSections] : [];
  const system = systemText(input.turn, sections);
  const currentText = input.turn.text;

  if (sections.length === 0) {
    return {
      text: withSystem(system, currentText),
      mode: input.resumeRejected ? "recovery" : input.resumed ? "resume" : "fresh",
      sections,
      systemSentText: system,
      sentSectionIds: [],
      recoveryTextSent: input.recoveryTextSent === true,
    };
  }

  if (input.resumeRejected) {
    return fullComposition(system, currentText, sections, "recovery", system, sections.map((section) => section.id), undefined, input.recoveryTextSent === true);
  }

  if (!input.resumed) {
    return fullComposition(system, currentText, sections, "fresh", system, sections.map((section) => section.id), undefined, false);
  }

  const previousReceipt = readAcpInstructionReceipt(
    input.providerInstanceId,
    input.turn.botId ?? "",
    input.turn.threadId,
    input.nativeSessionId,
  );
  if (!previousReceipt) {
    const replacement = `${replacementNotice}\n\n${system}`;
    return fullComposition(replacement, currentText, sections, "replacement", replacement);
  }

  const currentPairs = sectionPairs(sections);
  if (samePairs(previousReceipt.sections, currentPairs)) {
    return { text: currentText, mode: "resume", sections, previousReceipt, systemSentText: "", sentSectionIds: [], recoveryTextSent: false };
  }

  const update = updateText(sections, previousReceipt);
  const orderChanged = previousReceipt.sections.length === currentPairs.length && !sameIds(previousReceipt.sections, currentPairs);
  const sentSectionIds = (orderChanged ? sections : sections.filter((section) =>
    previousReceipt.sections.find((old) => old.id === section.id)?.hash !== acpInstructionSectionHash(section.text)))
    .map((section) => section.id);
  const systemSentText = update ?? "";
  return {
    text: update ? `${update}\n\n${currentText}` : currentText,
    mode: "resume",
    sections,
    previousReceipt,
    systemSentText,
    sentSectionIds,
    recoveryTextSent: false,
  };
}
