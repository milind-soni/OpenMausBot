// The setup checklist on an OMB Cloud home (components/CloudSetup.tsx,
// docs/cloud-pro.md): which steps it lists and whether each is done. Every
// answer comes from real state: the engines the Cloud reports, Move to
// Cloud's snapshot from this desktop app, the server's record of the first
// finished turn, and whether a first job was given. Nothing is ticked because
// the person said so; skipping the move is the one choice kept, as a choice.
// Pure, for tests.
import type { CloudMoveState } from "../../electron/cloud-move.mjs";
import { hintSeen, type OnboardingStatus, type WelcomeViewer } from "@/lib/onboarding";

/** "Hide setup", in the Cloud's own onboarding record (server config). */
export const CLOUD_SETUP_HIDDEN = "cloud-setup-hidden";
/** "Not now" on the move, from the checklist. */
export const CLOUD_SETUP_MOVE_SKIPPED = "cloud-setup-move-skipped";
/** The first-job question has been answered or skipped (lib/cloud-intent). */
export const CLOUD_INTENT_ASKED = "cloud-intent-asked";
/** A first job was given, so the bot's setup can start once an engine runs. */
export const CLOUD_INTENT_GIVEN = "cloud-intent-given";

export type CloudSetupStep = "cloud" | "job" | "engine" | "plan" | "move";
export type CloudSetupStatus = "todo" | "done" | "skipped";
export interface CloudSetupItem { id: CloudSetupStep; status: CloudSetupStatus }

export interface CloudSetupFacts {
  viewer: WelcomeViewer | null;
  connected: boolean;
  /** The Cloud has answered /api/instances (an empty list means not yet). */
  enginesKnown: boolean;
  /** Some engine on the Cloud can run a bot. */
  engineReady: boolean;
  /** The Cloud's onboarding record; undefined until its config arrives. */
  onboarding: OnboardingStatus | undefined;
  /** The first job is set up: its bot has a routine (lib/cloud-intent jobRoutine). */
  planned?: boolean;
  /** Move to Cloud as this desktop app's main process reports it. Null in a
   * browser (no bridge) and until main has answered. */
  move: { phase: CloudMoveState["phase"]; action?: CloudMoveState["action"]; suggest: boolean } | null;
}

/** Where the checklist stands. "none": not a Cloud home, or a session that
 * cannot sign engines in or save the record (a guest's paired phone).
 * "waiting": the Cloud has not answered yet, so nothing flashes on a guess.
 * "done": an engine can run and the Cloud has done something: with a first
 * job given, its routine exists (the bot's first turn only asks questions);
 * without one, a bot has finished a turn there. */
export function cloudSetupStage(facts: Omit<CloudSetupFacts, "move">): "none" | "waiting" | "hidden" | "done" | "shown" {
  if (!facts.viewer?.cloudHome || !facts.viewer.canSave) return "none";
  if (!facts.connected || !facts.enginesKnown || !facts.onboarding) return "waiting";
  if (hintSeen(facts.onboarding, CLOUD_SETUP_HIDDEN)) return "hidden";
  const worked = hintSeen(facts.onboarding, CLOUD_INTENT_GIVEN) ? Boolean(facts.planned) : Boolean(facts.onboarding.firstTurnAt);
  if (facts.engineReady && worked) return "done";
  return "shown";
}

// A move started or stopped here stays in view, with its progress or error.
const UNDER_WAY = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking", "replacing", "restarting", "failed"]);

/** Bringing this computer's bots: offered only while main suggests it (the
 * desktop app, an empty Cloud, a computer with work to bring). Done after a
 * move; skipped once the person says Not now here. Null when not listed. */
export function moveStatus(move: CloudSetupFacts["move"], onboarding: OnboardingStatus | undefined): CloudSetupStatus | null {
  if (!move) return null;
  if (move.action !== "restore" && move.phase === "done") return "done";
  if (move.action !== "restore" && UNDER_WAY.has(move.phase)) return "todo";
  if (hintSeen(onboarding, CLOUD_SETUP_MOVE_SKIPPED)) return "skipped";
  return move.suggest ? "todo" : null;
}

/** The steps, in order. The Cloud itself exists, so the list starts one step
 * in. Giving a first job is done once one is given (the bot's setup then waits
 * for an engine) or once a turn has finished there; connecting an AI is the
 * one step that is required. A given job adds its own last step: the bot asks
 * its questions and proposes a routine, done once that routine exists. */
export function cloudSetupItems(facts: CloudSetupFacts): CloudSetupItem[] {
  const given = hintSeen(facts.onboarding, CLOUD_INTENT_GIVEN);
  const items: CloudSetupItem[] = [
    { id: "cloud", status: "done" },
    { id: "job", status: given || facts.onboarding?.firstTurnAt ? "done" : "todo" },
    { id: "engine", status: facts.engineReady ? "done" : "todo" },
  ];
  if (given) items.push({ id: "plan", status: facts.planned ? "done" : "todo" });
  const move = moveStatus(facts.move, facts.onboarding);
  if (move) items.push({ id: "move", status: move });
  return items;
}
