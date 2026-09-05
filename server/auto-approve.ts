// Auto mode: when a bot may answer its own permission requests.
//
// Safe Auto and remembered grants stop at the destructive/sensitive and
// unattended boundaries below. Full access is a separate, explicitly
// acknowledged mode: it answers every permission request, including those
// guards, while questions remain outside this module and always reach a human.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

import { approvalModeFor, type ApprovalMode } from "../shared/approval-mode.ts";

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
];

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable.
const SENSITIVE = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
];

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: RegExp[], text: string): string | null {
  for (const re of rules) if (re.test(text)) return re.source;
  return null;
}

export function looksSensitive(text: string): boolean {
  return matchFirst(SENSITIVE, text) !== null;
}

export function looksDestructive(text: string): boolean {
  return matchFirst(DESTRUCTIVE, text) !== null;
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Command tools are therefore keyed by their program —
 * `Bash:git`, `Bash:npm` — so the grant is as narrow as the thing you
 * actually looked at. Computed once, server-side, and echoed back by the
 * client so the two sides can never disagree about what was granted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "run_command", "computer_exec", "terminal"]);

export function approvalKey(tool: string, summary: string, scope?: "local-computer"): string {
  const bare = tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
  if (!COMMAND_TOOLS.has(bare)) return scope ? `${scope}:${tool}` : tool;
  // first bare word of the command, skipping env assignments and sudo
  const words = summary.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || words[i] === "sudo")) i += 1;
  const program = (words[i] ?? "").split("/").pop()?.replace(/[^\w.-]/g, "") ?? "";
  const key = program ? `${tool}:${program}` : tool;
  return scope ? `${scope}:${key}` : key;
}

export interface AutoApprover {
  autoApprove?: boolean;
  approvalMode?: ApprovalMode;
  alwaysAllow?: string[];
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all. */
export type AutoVerdictSource =
  | "always-allow"
  | "auto-mode"
  | "full-access"
  | "explicit-approval-block"
  | "unattended-block"
  | "local-computer-block"
  | "destructive-guard"
  | "sensitive-guard"
  | "no-grant";

/** A durable "Always allow" choice is offered only when that exact grant
 * would be honored on the next identical request. Custom delegates approval
 * semantics to config.toml, while guards and provider-sandbox changes are
 * intentionally never bypassed by remembered app grants. */
export function rememberableApprovalKey(
  bot: AutoApprover | null | undefined,
  tool: string,
  summary: string,
  context: {
    source: AutoVerdictSource | undefined;
    scope?: "local-computer";
    requiresExplicitApproval?: boolean;
  },
): string | undefined {
  if (
    !bot ||
    approvalModeFor(bot) === "custom" ||
    context.source !== "no-grant" ||
    context.scope ||
    context.requiresExplicitApproval
  ) {
    return undefined;
  }
  return approvalKey(tool, summary, context.scope);
}

export interface AutoVerdict {
  /** Chip text when the bot may answer itself, null when a human decides.
   * The string becomes the chip in the transcript, so an auto-approved
   * action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
  /** What identifies the rule that decided: the matched regex (guards) or
   * the granted key (always-allow, and unattended-block over one). Auto
   * mode has no narrower identity than the mode itself, so it carries none. */
  rule?: string;
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
    /** The provider is asking to widen its configured sandbox rather than
     * perform one ordinary action. Only explicit Full may synthesize this. */
    requiresExplicitApproval?: boolean;
  },
): AutoVerdict {
  const mode = approvalModeFor(bot);
  // This branch intentionally precedes every guard. Entering Full access is
  // separately consent-gated by the bot PATCH endpoint, and its promise is
  // literal: even destructive, sensitive, unattended, and host-computer
  // permission requests are approved. The request.opened caller invokes this
  // function for permissions only, never for provider questions.
  if (mode === "full") {
    return {
      approve: `approved ${tool} (full access)`,
      source: "full-access",
    };
  }
  if (context?.requiresExplicitApproval) {
    return { approve: null, source: "explicit-approval-block" };
  }
  // the guards outrank the grants, so an "always allow" can never widen
  // into them
  const destructive = matchFirst(DESTRUCTIVE, summary) ?? matchFirst(DESTRUCTIVE, tool);
  const sensitive = destructive ? null : matchFirst(SENSITIVE, summary);
  // The grant is computed even when a hard block will refuse it: the row
  // worth auditing is "this WOULD have auto-approved, and only the block
  // stood in the way", which cannot be told apart from an ordinary
  // "nobody granted this" card without knowing both halves.
  const key = approvalKey(tool, summary, context?.scope);
  const grant =
    destructive || sensitive
      ? null
      : mode !== "custom" && bot.alwaysAllow?.includes(key)
        ? { approve: `auto-approved ${key} (always allowed)`, source: "always-allow" as const, rule: key }
        : mode === "auto"
          ? { approve: `auto-approved ${tool}`, source: "auto-mode" as const, rule: undefined }
          : null;
  if (context?.unattended) {
    // Auto mode is something a person switched on for turns they are present
    // for. A webhook turn begins with nobody watching, on a payload someone
    // else wrote, so it does not inherit that decision — the guard above is a
    // pattern list its own comment calls "not a security boundary", and it
    // must not stand in for a human at 3am. A guard that would have carded
    // anyway keeps its own name; the block is only the story when it is the
    // thing that changed the outcome.
    if (grant) return { approve: null, source: "unattended-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer" && mode !== "auto") {
    // Host control is not covered by a remembered always-allow grant.
    // After the Auto-on-this-computer warning, unclassified GUI actions
    // (click/type) may auto-approve; destructive/sensitive still card.
    if (grant) return { approve: null, source: "local-computer-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
  if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
  if (grant) return { approve: grant.approve, source: grant.source, rule: grant.rule };
  return { approve: null, source: "no-grant" };
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
    requiresExplicitApproval?: boolean;
  },
): string | null {
  return autoVerdict(bot, tool, summary, context).approve;
}
