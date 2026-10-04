// What the harness tells GPT-Live about the bot's cards during a Live call.
// English only: the voice speaks the user's language on its own, and the
// server has no i18n. The strings mirror src/locales/en.json approval.voice.*
// and approval.tool.* so the call and the card say the same thing.
import type { OptionCardData } from "./wire.ts";

export type LiveCardKind = "approval" | "review" | "question";

/** "approval": a provider or peer ask the voice may decide with a strict yes/no.
 * "review": a harness-native proposal (skill, routine, profile, default
 * model, team setup) that must be reviewed on screen.
 * "question": a provider question. An expired proposal is settled: nothing
 * can answer it any more. */
export function liveCardKind(card: OptionCardData | undefined): LiveCardKind | null {
  if (!card?.requestId || card.answered || card.dismissed || card.expired) return null;
  if (card.skillRequest || card.routineRequest || card.profileRequest || card.modelRequest || card.teamSetupRequest) {
    return "review";
  }
  return card.tool ? "approval" : "question";
}

/** Why a decision made on a Live call must not reach this card, or null to
 * deliver it. A card settled a moment earlier (answered or dismissed on
 * screen) is refused before anything runs: delivering to it would add a
 * false "the action was not run" line after the tap did run it. A card that
 * is not on the thread is left to the normal answer path. */
export function liveDecisionRefusal(card: OptionCardData | undefined): string | null {
  if (!card) return null;
  const kind = liveCardKind(card);
  if (kind === "review") return "This request is reviewed on screen.";
  return kind ? null : "The request is no longer open.";
}

const TOOL_PHRASES: Record<string, string> = {
  Bash: "run a command",
  Read: "read a file",
  Write: "write a file",
  Edit: "edit a file",
  WebFetch: "fetch a web page",
  WebSearch: "search the web",
  schedule_routine: "schedule a routine",
  manage_routine: "change a routine",
  stage_skill: "enable a learned skill",
  update_skill: "update a learned skill",
  update_profile: "update its profile",
  shell: "run a command",
  edit: "edit a file",
  read: "read a file",
  fetch: "fetch a web page",
  delete: "delete a file",
  think: "think",
  other: "take an action",
  tool: "use a tool",
};

/** Same rule as toolLabel in src/components/ApprovalCard.tsx, in English. */
export function toolPhrase(tool?: string): string {
  if (!tool) return "take an action";
  return TOOL_PHRASES[tool] ?? tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
}

const DETAIL_LIMIT = 400;

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** A bot's step as the voice may name it: the tool's own spoken label, or
 * the tool's name ("team notes: query database") — never its arguments,
 * which can hold paths, queries or private text. */
export function liveStepLabel(tool: { name: string; spoken?: string }): string {
  if (tool.spoken?.trim()) return brief(tool.spoken, 80);
  const parts = tool.name.split("__");
  if (parts[0] === "mcp" && parts.length >= 3) {
    const server = parts[1].replace(/[-_]+/g, " ").trim();
    const action = parts.slice(2).join(" ").replace(/_+/g, " ").trim();
    return brief(`${server}: ${action}`, 80);
  }
  return toolPhrase(tool.name);
}

function brief(text: string, limit = DETAIL_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return flat.length <= limit ? flat : `${flat.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

// The voice IS the bot to the person on the call, so everything below is
// either said as the bot ("I …") or addressed to the voice as "you". Never
// name the bot in the third person: the voice then talks about itself as a
// separate "backend" (seen in the first test calls).

export function spokenApprovalPrompt(card: OptionCardData): string {
  const detail = brief(card.subtitle);
  return `I want to ${toolPhrase(card.tool)}.${detail ? ` ${detail}.` : ""} May I?`;
}

export function spokenReviewPrompt(card: OptionCardData): string {
  const title = brief(card.title || "a proposal", 200);
  return `Tell the user, in your own words, that you need their decision in the chat: ${title}. They review it on screen and choose there; it cannot be decided by voice.`;
}

/** The bot waits for an app to be connected in the chat (a connector card). */
export function spokenConnectorPrompt(label: string): string {
  return `Tell the user, in your own words, that you need them to connect ${brief(label || "an app", 80)} in the chat before you can go on. It cannot be done by voice.`;
}

/** The bot waits for a credential entered on screen (a secret card). It must
 * never travel through the call, so the voice never asks for it aloud. */
export function spokenSecretPrompt(label: string): string {
  return `Tell the user, in your own words, that you need ${brief(label || "a credential", 80)} entered in the chat on screen before you can go on. Never ask them to say it aloud.`;
}

export function spokenQuestionPrompt(card: OptionCardData): string {
  const detail = brief(card.subtitle || card.title);
  const choices = card.options.length ? ` The options are ${card.options.join(", ")}.` : "";
  // brief() drops the detail's own closing mark, so the "?" is never doubled
  return `Ask the user, in your own words: ${detail}?${choices} Then delegate their answer.`;
}

export const LIVE_COPY = {
  notHeard: "The request was not heard clearly. Ask the user to say it again.",
  notClear: "That was not a clear yes or no. Ask the user again for a clear yes or no.",
  deniedMessage: "Denied by the user, on a live call.",
  answeredInChat: "The user answered that request in the chat. Do not ask about it again.",
  working: "You are working on the request now. Nothing is done until the result comes back; do not guess it.",
  answerPassed: "You are using the user's answer now. Wait for the result.",
  granted: "Thanks, I'll go ahead.",
  denied: "Okay, I won't do it.",
  saveFailed: (detail: string) => `The decision could not be saved${detail ? `: ${detail}` : "."} Ask the user to try again.`,
  noAnswer: "I'm done. The result, or what went wrong, is in the chat.",
  typedAnswerLead: (typed: string) => `About what you typed in the chat ("${brief(typed, 200)}"):`,
  progress: (spoken: string) => `Progress: ${brief(spoken, 200)}`,
  status: (workedMs: number, steps: number, lastStep: string | null, lastStepAgoMs: number) =>
    `Status note, do not announce it: you are still working on it (${duration(workedMs)} so far, ${steps} step${steps === 1 ? "" : "s"}${
      lastStep ? `; last step: ${lastStep}, ${duration(lastStepAgoMs)} ago` : ""}).`,
  signedOut: "The call has ended because the sign-in that started it has ended. Sign in again to start a new call.",
  unpaired: "The call has ended because the phone that started it was unpaired from this computer.",
  permissionRequest: (prompt: string) => `You need the user's permission. Say it in your own words: ${prompt} Ask for a clear yes or no, then delegate their answer.`,
};
