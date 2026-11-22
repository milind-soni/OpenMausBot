import type { ProfileProblem } from "./profile-format.ts";

/** What one plan line does when applied.
 * - `add`: a new area or bot.
 * - `change`: a change the file makes, applied with the plan.
 * - `access`: a change that gives a bot more access ("Gives more access"); applied only when the person confirms it
 *   from the desktop app or a paired admin device.
 * - `conflict`: the file and this app both changed one field; nothing is applied to it until the person picks
 *   keep mine or take the file, by the line's `choice` key.
 * - `changed-here`: changed in this app since the profile set it; kept.
 * - `gone`: no longer in the profiles; kept (`remove` when the plan prunes).
 * - `blocked`: its file has problems, so it is left as it is.
 * - `later`: in the profiles, but this version of the app does not apply it yet.
 * - `note`: something the person should know, such as a model this app does not have. */
export type ProfilePlanLineKind = "add" | "change" | "access" | "conflict" | "changed-here" | "gone" | "remove" | "blocked" | "later" | "note";

export interface ProfilePlanLine {
  kind: ProfilePlanLineKind;
  subject: { kind: "organization" | "area" | "bot" | "mcp-server"; id: string; name: string; botId?: string };
  field?: string;
  /** One plain sentence. */
  text: string;
  /** The profile file the line comes from, relative to the folder. */
  file?: string;
  /** A conflict's values, shortened for display, and the key its choice goes under. */
  conflict?: { choice: string; file: string; mine: string };
}

/** A conflict's resolution, keyed by its line's `conflict.choice`. */
export type ProfileChoice = "mine" | "file";

export interface ProfilePlanCounts {
  add: number;
  change: number;
  access: number;
  conflict: number;
  changedHere: number;
  gone: number;
  remove: number;
  blocked: number;
  later: number;
}

/** POST /api/profiles/plan answers this; POST /api/profiles/apply answers it with `applied`. */
export interface ProfilePlan {
  folder: string;
  /** The folder's git commit, when it is a git checkout. */
  commit?: string;
  organization?: string;
  /** Identifies this exact plan: apply with `expect` set to it refuses a folder or app that changed since. */
  digest: string;
  lines: ProfilePlanLine[];
  counts: ProfilePlanCounts;
  /** Nothing to apply, nothing to decide and no settled conflict to record. */
  noChanges: boolean;
  problems: Array<ProfileProblem & { sentence: string }>;
  warnings: Array<ProfileProblem & { sentence: string }>;
}

export interface ProfileApplyRequest {
  /** The folder to read; absent reads the chosen folder. Applying makes it the chosen folder. */
  folder?: string;
  choices?: Record<string, ProfileChoice>;
  /** Delete bots no longer in the profiles instead of keeping them. */
  prune?: boolean;
  /** Apply the "Gives more access" lines too. Refused (403) unless the request comes from the desktop app or an admin
   * session of a paired device. Without it those lines are left out and the rest applies. */
  giveAccess?: boolean;
  /** The plan's `digest`: refuse (409) when the plan is no longer the one the person saw. */
  expect?: string;
}

export interface ProfileApplyResult extends ProfilePlan {
  applied: {
    /** Lines applied. */
    lines: ProfilePlanLine[];
    /** Lines left out, each with why: more access not confirmed, an open conflict, or the app refused it. */
    skipped: Array<ProfilePlanLine & { reason: string }>;
  };
}

/** GET /api/profiles: the chosen folder and what was last applied from it. */
export interface ProfilesStatus {
  folder?: string;
  applied?: { at: number; commit?: string; digest: string; folder: string };
  /** Each area applied, by its key: the department it became. */
  areas: Record<string, { section: string }>;
}

/** GET /api/profiles/bots/:id: what bot settings show for a bot that came from a profile. */
export interface ProfileBotView {
  /** Managed fields whose value was changed in this app since the profile last set it, by plan field name
   * (`soul`, `title`, `approval`, `memory.enabled`, …). */
  changedHere: string[];
  /** Secret slots the bot's profile names: each person fills them with their own key. Values are never sent. */
  secrets: ProfileSecretSlot[];
}

/** One key a bot's profile asks for, and what it is for (`Edu brain`, or an MCP server's name). A `secret` is named in
 * the app's key store, an `env` is an environment variable; a `file` slot never carries its path. */
export type ProfileSecretSlot = { kind: "secret" | "env"; name: string; for: string } | { kind: "file"; for: string };
