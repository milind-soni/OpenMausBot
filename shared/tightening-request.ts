/**
 * Durable payload carried by a tightening card (propose_tightening).
 *
 * Authority reductions a bot may propose for itself or (for a Chief) a
 * section peer. Direction is enforced by shape: the intents cannot express
 * an escalation — approvalMode targets stop below full and custom, the
 * booleans only carry their tightening value, and the list fields only
 * carry removals. `validateTightening` then checks the remaining
 * state-relative direction (an upward move inside ask/edits/auto, a grant
 * that is not currently held) against live bot state, at propose AND again
 * at confirm, so a card that sat open can never apply a transition that
 * stopped being a reduction. Escalation stays human-only in Edit Profile.
 */
import { APPROVAL_MODES, type ApprovalMode } from "./approval-mode.ts";

/** Targets a proposal may name. "full" and "custom" are owner-only. */
export const TIGHTENING_MODE_TARGETS = ["ask", "edits", "auto"] as const;
export type TighteningModeTarget = (typeof TIGHTENING_MODE_TARGETS)[number];

export interface TighteningIntents {
  /** Strictly below the current level in the selector order, or custom → ask. */
  approvalMode?: TighteningModeTarget;
  /** true → false only. */
  composio?: false;
  /** true → false only. */
  browser?: false;
  /** false → true only: pausing before peer contact is tightening. */
  approvePeerComms?: true;
  /** Entries to remove from the always-allow list; additions are inexpressible. */
  alwaysAllow?: string[];
  /** Server names to unmount; additions are inexpressible. */
  mcpServers?: string[];
  /** Enabled skills to disable; enablement keeps its human review gate. */
  skills?: string[];
}

/** The authority surface a tightening card can touch, resolved against the
 * bot's live state (effective booleans, effective approval level, effective
 * MCP mounts, enabled skills). Snapshotted at propose and re-derived at
 * confirm; the hash of this state is the card's revision. */
export interface TighteningState {
  approvalMode: ApprovalMode;
  composio: boolean;
  browser: boolean;
  approvePeerComms: boolean;
  alwaysAllow: readonly string[];
  mcpServers: readonly string[];
  skills: readonly string[];
}

export interface TighteningRequestCardData {
  version: 1;
  requestId: string;
  /** The proposing conversation; authority is fixed here. */
  botId: string;
  threadId: string;
  /** Whose authority is reduced: the proposer, or a section peer named by a Chief. */
  targetBotId: string;
  targetName: string;
  createdAt: number;
  reason: string;
  intents: TighteningIntents;
  before: TighteningState;
  expectedRevision: string;
  appliedAt?: number;
}

export type TighteningOutcome =
  | { ok: true; after: TighteningState }
  | { ok: false; error: string };

/** Direction check against live state. Pure: the caller supplies the
 * snapshot, at propose and again at confirm. Every rejection names the
 * field and the allowed direction. */
export function validateTightening(before: TighteningState, intents: TighteningIntents): TighteningOutcome {
  const after: TighteningState = {
    ...before,
    alwaysAllow: [...before.alwaysAllow],
    mcpServers: [...before.mcpServers],
    skills: [...before.skills],
  };
  if (intents.approvalMode !== undefined) {
    const to = intents.approvalMode;
    const from = before.approvalMode;
    const reduces = from === "custom"
      ? to === "ask"
      : APPROVAL_MODES.indexOf(to) < APPROVAL_MODES.indexOf(from);
    if (!reduces) {
      return {
        ok: false,
        error: `approvalMode can only tighten: down the selector order (ask, edits, auto, full), or custom to ask. "${to}" does not reduce "${from}".`,
      };
    }
    after.approvalMode = to;
  }
  if (intents.composio !== undefined) {
    if (!before.composio) return { ok: false, error: "composio is already off; it may only be turned off" };
    after.composio = false;
  }
  if (intents.browser !== undefined) {
    if (!before.browser) return { ok: false, error: "browser is already off; it may only be turned off" };
    after.browser = false;
  }
  if (intents.approvePeerComms !== undefined) {
    if (before.approvePeerComms) return { ok: false, error: "approvePeerComms is already on; it may only be turned on" };
    after.approvePeerComms = true;
  }
  if (intents.alwaysAllow !== undefined) {
    const removals = [...new Set(intents.alwaysAllow)];
    if (!removals.length) return { ok: false, error: "alwaysAllow must name at least one grant to remove" };
    const unknown = removals.filter((key) => !before.alwaysAllow.includes(key));
    if (unknown.length) {
      return { ok: false, error: `alwaysAllow entries may only be removed, never added; not currently granted: ${unknown.join(", ")}` };
    }
    after.alwaysAllow = before.alwaysAllow.filter((key) => !removals.includes(key));
  }
  if (intents.mcpServers !== undefined) {
    const removals = [...new Set(intents.mcpServers)];
    if (!removals.length) return { ok: false, error: "mcpServers must name at least one server to unmount" };
    const unknown = removals.filter((name) => !before.mcpServers.includes(name));
    if (unknown.length) {
      return { ok: false, error: `mcpServers may only unmount servers this bot currently mounts; not mounted: ${unknown.join(", ")}` };
    }
    after.mcpServers = before.mcpServers.filter((name) => !removals.includes(name));
  }
  if (intents.skills !== undefined) {
    const removals = [...new Set(intents.skills)];
    if (!removals.length) return { ok: false, error: "skills must name at least one skill to disable" };
    const unknown = removals.filter((name) => !before.skills.includes(name));
    if (unknown.length) {
      return { ok: false, error: `skills may only be disabled, never enabled; not currently enabled: ${unknown.join(", ")}` };
    }
    after.skills = before.skills.filter((name) => !removals.includes(name));
  }
  return { ok: true, after };
}

