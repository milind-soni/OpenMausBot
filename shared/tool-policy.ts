// A middle approval level for tool calls, as shared/command-policy.ts is for
// shell commands.
//
// The problem it solves: with connected apps mounted, a bot in Ask mode raises
// a card for every tool call. An Agent Bus that writes one row to a sheet
// costs two taps, every time, forever. Full access removes the cards but also
// returns before the outbound guard (server/auto-approve.ts), so it removes
// approval on sends as well — the one thing the operator asked to keep.
//
// **The wrapper's name is not an identity.** Composio mounts a multiplexer:
// one tool, `COMPOSIO_MULTI_EXECUTE_TOOL`, whose arguments name the tool it
// actually runs. Allowing it by name allows every app the workspace has ever
// connected, Instagram and Gmail included, while reading like a narrow grant
// for a spreadsheet. So a verdict is keyed on the INNER slugs, which the
// driver must read from the native input and forward. Observed 2026-10-10:
// `{"tools":[{"tool_slug":"GOOGLESHEETS_CREATE_GOOGLE_SHEET1", ...}]}`.
//
// Fail closed: `allow` only when every inner tool was read and every one of
// them is on the operator's list. Unreadable, empty, partial or unknown all
// return `ask`, which is the behaviour that exists today.

import { isOutboundTool } from "./outbound.ts";

export type ToolDecision = "allow" | "ask";

export interface ToolPolicyVerdict {
  decision: ToolDecision;
  /** Why, in words that can go in the transcript chip or the decision log. */
  reason: string;
}

/** Tools whose whole job is to run another tool named in their arguments.
 * Matched on the bare name, so a provider prefix (`composio_`, `mcp__…__`)
 * does not smuggle one past. */
const MULTIPLEXERS = new Set([
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_EXECUTE_TOOL",
]);

/** The tool name without a provider prefix. `composio_GOOGLESHEETS_BATCH_GET`
 * and `mcp__composio__GOOGLESHEETS_BATCH_GET` are the same tool.
 *
 * The prefix strip is deliberately case-SENSITIVE. The mount prefix is the
 * lower-case `composio_`; the slug itself is upper-case, and one real slug is
 * `COMPOSIO_MULTI_EXECUTE_TOOL`. A case-insensitive strip turned that into
 * `MULTI_EXECUTE_TOOL`, which matched no multiplexer and so would have let
 * the wrapper through as an ordinary tool — the exact hole this module
 * exists to close. Caught by its own test before it ran anywhere. */
export function bareToolSlug(tool: string): string {
  const afterMcp = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  const afterPrefix = afterMcp.startsWith("composio_") ? afterMcp.slice("composio_".length) : afterMcp;
  return afterPrefix.trim().toUpperCase();
}

export function toolMultiplexes(tool: string): boolean {
  return MULTIPLEXERS.has(bareToolSlug(tool));
}

export interface ToolPolicyInput {
  /** The tool name the provider reported. */
  tool: string;
  /** The inner tool slugs this call would run, when the driver could read
   * every one of them. Undefined for a multiplexer means they could not be
   * read, which is not a reason to allow anything. */
  innerToolSlugs?: readonly string[];
  /** The operator's list, from OMB_TOOL_POLICY_ALLOW. Empty turns the policy
   * off, and off is what every install had before this. */
  allowedToolSlugs: readonly string[];
}

const ask = (reason: string): ToolPolicyVerdict => ({ decision: "ask", reason });

/**
 * Should this tool call run without asking?
 *
 * `allow` only when the operator configured a list, and either the tool is
 * named on it directly, or it is a multiplexer whose every inner tool is
 * named on it. Otherwise `ask`, with the reason that decided it.
 */
export function toolPolicyVerdict(input: ToolPolicyInput): ToolPolicyVerdict {
  const allowed = new Set(
    (input.allowedToolSlugs ?? [])
      .map((slug) => bareToolSlug(String(slug)))
      .filter(Boolean),
  );
  if (!allowed.size) return ask("no tool policy configured");

  const tool = bareToolSlug(input.tool ?? "");
  if (!tool) return ask("could not read which tool runs");

  if (toolMultiplexes(input.tool)) {
    // Listing the wrapper itself can never satisfy this. Its name says
    // nothing about what it would run, so treating it as a grant would be a
    // grant for everything the workspace has connected.
    const inner = input.innerToolSlugs;
    if (!inner) return ask(`${tool} runs another tool and its arguments could not be read`);
    if (!inner.length) return ask(`${tool} named no inner tool`);
    const slugs = inner.map((slug) => bareToolSlug(String(slug)));
    if (slugs.some((slug) => !slug)) return ask("an inner tool had no name");
    // A multiplexer nested inside a multiplexer is a way to launder the check.
    if (slugs.some((slug) => MULTIPLEXERS.has(slug))) return ask("an inner tool is itself a multiplexer");
    const refused = slugs.find((slug) => !allowed.has(slug));
    if (refused) return ask(`${refused} is not on the tool policy list`);
    // A send is never this policy's to approve, even when the operator put it
    // on the list. autoVerdict's own outbound guard cannot catch these: it
    // sees ACP's category ("other"), and isOutboundTool("other") is false.
    // The relay's gate in server/index.ts does check inner slugs and would
    // still stop the send, but a card that auto-approves a send is wrong on
    // its own terms. Found 2026-10-11 in review.
    const sends = slugs.find((slug) => isOutboundTool(slug));
    if (sends) return ask(`${sends} sends something, which this policy never approves`);
    return { decision: "allow", reason: `tool policy: ${slugs.join(", ")}` };
  }

  if (MULTIPLEXERS.has(tool)) return ask("a multiplexer is never granted by its own name");
  if (!allowed.has(tool)) return ask(`${tool} is not on the tool policy list`);
  if (isOutboundTool(tool)) return ask(`${tool} sends something, which this policy never approves`);
  return { decision: "allow", reason: `tool policy: ${tool}` };
}

/** Read the inner tool slugs out of an ACP tool call's native input.
 *
 * Returns undefined when the shape is not the one observed, which the policy
 * treats as "could not be read" and therefore asks. Never guesses: a slug
 * that is not a plain non-empty string makes the whole read fail, because a
 * partial list would approve the half it understood.
 */
export function innerToolSlugsOf(rawInput: unknown): string[] | undefined {
  const containers: unknown[] = [rawInput];
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    containers.push((rawInput as Record<string, unknown>).arguments);
  }
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const record = container as Record<string, unknown>;
    const list = record.tools;
    if (Array.isArray(list)) {
      const slugs: string[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
        const slug = (entry as Record<string, unknown>).tool_slug;
        if (typeof slug !== "string" || !slug.trim()) return undefined;
        slugs.push(slug.trim());
      }
      return slugs;
    }
    const single = record.tool_slug;
    if (typeof single === "string" && single.trim()) return [single.trim()];
  }
  return undefined;
}
