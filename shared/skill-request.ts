/**
 * Durable payload on a learned-skill confirmation card. None of the staged
 * SKILL.md reaches the bot's enabled skill index until the user confirms; during
 * an update the approved version stays live.
 */
export type SkillRequestAction = "create" | "update" | SkillSwitchAction;

/** Chief-only management of an existing library skill; share assigns one target without changing its scope. */
export type SkillManagementAction = "share" | "assign" | "unassign" | "transfer_maintainer";

export function isSkillManagementAction(action: unknown): action is SkillManagementAction {
  return action === "share" || action === "assign" || action === "unassign" || action === "transfer_maintainer";
}

/** Explicit assignment and effective library access differ for every-bot skills and private namesakes. */
export interface SkillAssignmentState {
  name: string;
  in_library: boolean;
  scope: "all_bots" | "selected_bots" | null;
  assigned: boolean;
  shadowed: boolean;
  enabled: boolean;
  available: boolean;
  content_revision: string | null;
  package_files_revision: string | null;
  management_revision: string;
}

/** Turning one of the bot's existing skills on or off, or deleting it: no new
 * SKILL.md, so the card shows the current one and approval binds to it. */
export type SkillSwitchAction = "enable" | "disable" | "delete";

export function isSkillSwitchAction(action: unknown): action is SkillSwitchAction {
  return action === "enable" || action === "disable" || action === "delete";
}

export function skillSwitchVerb(action: SkillSwitchAction): string {
  return action === "enable" ? "turn on" : action === "disable" ? "turn off" : "delete";
}

/** Kept on the receipt so Undo reverts the library write and the assignments together. */
export interface SkillShareRecord {
  /** deduplicated: identical bytes were already in the library; assigned: it already was a library skill. */
  library: "installed" | "deduplicated" | "assigned" | "updated";
  sha256: string;
  sharedAt: number;
  assigned: Array<{ botId: string; name: string }>;
  skipped: Array<{ botId: string; name: string; reason: string }>;
}

export interface SkillRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  stagedId: string;
  action: SkillRequestAction;
  name: string;
  gist: string;
  /** Human-readable provenance retained with the installed skill. */
  source?: string;
  /** Exact, secret-scrubbed SKILL.md shown as plain text before approval. */
  preview?: string;
  /** Binds approval to the exact bytes shown in preview. */
  sha256?: string;
  /** references/<topic>.md files shown in full beside the SKILL.md; absent when the skill is SKILL.md alone. */
  references?: Array<{ path: string; content: string }>;
  /** Binds approval to the exact references shown. */
  referencesSha256?: string;
  warnings: string[];
  createdAt: number;
  /** An update or delete that applied without a person: the SKILL.md it replaced or removed, so
   * Undo can put it back while the skill is unchanged since. enabled is false for a deleted skill that was off. */
  previous?: { preview: string; source: string; references?: Array<{ path: string; content: string }>; enabled?: boolean };
  shared?: SkillShareRecord;
  shareError?: string;
}

/** The hash a current client may echo after it displayed the complete
 * proposal. Old cards deliberately return undefined and remain deny-only. */
export function reviewedSkillSha256(request: SkillRequestCardData): string | undefined {
  if (!request.preview || !request.sha256 || !/^[a-f0-9]{64}$/i.test(request.sha256)) return undefined;
  return request.sha256;
}

/** Map the server-authored affirmative labels explicitly and fail closed for
 * anything else. This keeps new Update/Apply wording working without turning
 * an unknown or corrupted card answer into approval. */
export function skillRequestBehavior(answer: string): "allow" | "deny" {
  const normalized = answer.trim().toLowerCase();
  return ["enable", "turn on", "turn off", "delete", "update", "apply", "allow", "allow once", "confirm", "yes"].includes(normalized)
    ? "allow"
    : "deny";
}
