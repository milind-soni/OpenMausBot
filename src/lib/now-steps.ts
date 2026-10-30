import type { LocaleKey } from "@/locales";
import type { Message } from "@/state/store";
import type { LiveStatus } from "@/state/turn-status";
import type { StepQuiet } from "../../shared/turn-progress";
import { t } from "./i18n";
import { toolActivityPhrases, turnNowPhrases } from "./live-activity";
import { withWhose } from "./tool-step-label";

export type NowStepState = "done" | "failed" | "now";

export interface NowStep {
  id: string;
  label: string;
  state: NowStepState;
  hover?: string;
}

const DONE_NAMED: Partial<Record<string, LocaleKey>> = {
  command: "chat.now.ranNamed",
  web: "chat.now.searchedWebFor",
  fetch: "chat.now.readSite",
  read: "chat.now.readNamed",
  write: "chat.now.wroteNamed",
  edit: "chat.now.editedNamed",
};

const DONE_PLAIN: Partial<Record<string, LocaleKey>> = {
  "chat.activity.runCommand": "chat.now.ranCommand",
  "chat.activity.searchWeb": "chat.now.searchedWeb",
  "chat.activity.readPage": "chat.now.readPage",
  "chat.activity.readFile": "chat.now.readFile",
  "chat.activity.writeFile": "chat.now.wroteFile",
  "chat.activity.editFile": "chat.now.editedFile",
  "chat.activity.searching": "chat.now.searchedFiles",
};

type StepTool = NonNullable<Message["tool"]>;

export function stepLabel(tool: StepTool, state: NowStepState): string {
  return withWhose(stepWords(tool, state), tool);
}

function stepWords(tool: StepTool, state: NowStepState): string {
  const now = toolActivityPhrases(tool);
  if (state === "now") return now.phrases[0]!;
  const named = tool.step && DONE_NAMED[tool.step.activity];
  if (named) return t(named, { target: tool.step!.target });
  const plain = DONE_PLAIN[now.phase];
  return plain ? t(plain) : now.phrases[0]!;
}

const isCall = (message: Message) =>
  message.kind === "activity" && Boolean(message.tool?.itemId) && !message.comm && !message.tool?.rescue;

/** The current ask's tool calls, newest last: what it did and what it is doing, with the live call the chat has no row
 * for yet (a file whose content the engine is still writing). */
export function nowSteps(messages: readonly Message[], status: LiveStatus | null, limit = 4): NowStep[] {
  const asked = messages.findLastIndex((message) => message.role === "user" && message.kind === "text" && !message.steered);
  const calls = messages.slice(asked + 1).filter(isCall);
  const steps: NowStep[] = calls.map((message) => {
    const tool = message.tool!;
    const state: NowStepState = tool.ok === undefined ? "now" : tool.ok ? "done" : "failed";
    return { id: message.id, label: stepLabel(tool, state), state, ...(tool.step?.detail ? { hover: tool.step.detail } : {}) };
  });
  const itemId = status?.itemId;
  const live = itemId && !calls.some((message) => message.tool?.itemId === itemId) ? turnNowPhrases(status) : null;
  if (live) steps.push({ id: `live:${itemId}`, label: live.phrases[0]!, state: "now", ...(live.hover ? { hover: live.hover } : {}) });
  return steps.slice(-limit);
}

const PROCESS_STATE = { network: "chat.liveness.network", busy: "chat.liveness.busy", idle: "chat.liveness.idle" } as const;

/** "last output 2 min ago", or what the call's processes show while it has printed nothing. */
export function quietText(quiet: StepQuiet | undefined, now: number): string | undefined {
  if (!quiet) return undefined;
  if (quiet.kind !== "output") return t(PROCESS_STATE[quiet.kind]);
  const minutes = Math.floor(Math.max(0, now - quiet.at) / 60_000);
  if (minutes < 1) return t("chat.liveness.outputJustNow");
  if (minutes < 60) return t("chat.liveness.outputMinutes", { count: minutes });
  return t("chat.liveness.outputHours", { count: Math.floor(minutes / 60) });
}
