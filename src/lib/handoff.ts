import { isHandoff, signInOutcome, signInWaits, type HandoffNeed } from "../../shared/sign-in-request";
import type { SignInRequestCardData, Surface } from "../../shared/wire";
import type { LocaleKey } from "@/locales";
import { t } from "./i18n";

/** The viewer's one control: what the person can do with the screen they look at. */
export type ViewerPillState = "watching" | "control" | "control-request";

/** A pending handoff opens the viewer already in control, and its button hands the step back as done; control the person
 * took on their own ends with Stop; otherwise they watch and may take control. */
export function viewerPillState({ inControl, requestPending }: { inControl: boolean; requestPending: boolean }): ViewerPillState {
  if (!inControl) return "watching";
  return requestPending ? "control-request" : "control";
}

export const PILL_ACTION = { watching: "take", control: "stop", "control-request": "done" } as const satisfies Record<ViewerPillState, string>;

const PLACE_LABEL: Record<Surface, LocaleKey> = {
  browser: "handoff.place.browser",
  vm: "handoff.place.computer",
  cloud: "handoff.place.computer",
  local: "handoff.place.computer",
};

export function handoffPlaceLabel(place: Surface): string {
  return t(PLACE_LABEL[place] ?? "handoff.place.computer");
}

const TITLE: Record<HandoffNeed, LocaleKey> = {
  sign_in: "handoff.title.signIn",
  captcha: "handoff.title.captcha",
  payment: "handoff.title.payment",
  approval: "handoff.title.approval",
  other: "handoff.title.other",
};

export function handoffTitle(need: HandoffNeed | undefined): string {
  return t(TITLE[need ?? "other"] ?? "handoff.title.other");
}

export type HandoffEnd = "done" | "skipped" | "expired" | "chat" | "stopped" | "replaced";

/** How a handoff card ended, or null while it waits. */
export function handoffEnd(card: Pick<SignInRequestCardData, "done" | "cancelled" | "expired" | "answeredInChat" | "stopped" | "superseded">): HandoffEnd | null {
  const outcome = signInOutcome(card);
  if (outcome === "done") return "done";
  if (outcome === "cancelled") return "skipped";
  if (outcome === "expired") return "expired";
  if (card.answeredInChat) return "chat";
  if (card.superseded) return "replaced";
  if (card.stopped) return "stopped";
  return null;
}

const END_WORD: Record<HandoffEnd, LocaleKey> = {
  done: "handoff.end.done",
  skipped: "handoff.end.skipped",
  expired: "handoff.end.expired",
  chat: "handoff.end.chat",
  stopped: "handoff.end.stopped",
  replaced: "handoff.end.replaced",
};

/** "Done · Sign in to GitHub on the open page": the collapsed row after the place's own label. */
export function handoffSummary(end: HandoffEnd, instruction: string): string {
  return `${t(END_WORD[end])} · ${instruction}`;
}

type Row = { id: string; kind: string; signIn?: SignInRequestCardData };

/** The newest handoff still waiting in these rows: only it shows a live picture, so stacked requests stay short. */
export function newestWaitingHandoff(rows: readonly Row[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "signin" && isHandoff(row.signIn) && row.signIn!.stopped !== true && signInWaits(row.signIn!)) return row.id;
  }
  return null;
}
