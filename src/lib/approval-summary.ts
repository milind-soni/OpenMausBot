// How a held outbound action reads at a glance: "Send to Linear?" and
// "Create linear comment ×2", rather than the Composio slug the bot called.
//
// The rules match the phones (ios/Sources/CompanionCore/ApprovalCard.swift):
// the computer's own list of calls when the card carries one, else the
// "App · Label" first line of each block in the subtitle. The full request
// stays on the card; this is only the headline and the line under it.
import { t } from "@/lib/i18n";
import type { OptionCardData } from "@/state/store";

export interface OutboundCall {
  app: string | null;
  label: string;
}

/** At most this many distinct actions are named on the summary line. */
const SUMMARY_GROUPS = 3;

/** The subtitle is `App · Label` then the arguments on the next line, per
 * call, calls separated by a blank line. JSON.stringify never writes a raw
 * newline, so the first line of each block is always its heading. Any block
 * that does not read that way makes the whole subtitle unreadable. */
export function parseOutboundCalls(subtitle: string): OutboundCall[] {
  const calls: OutboundCall[] = [];
  for (const block of subtitle.split("\n\n")) {
    const heading = (block.split("\n")[0] ?? "").trim();
    if (!heading) return [];
    const at = heading.indexOf(" · ");
    if (at < 0) {
      calls.push({ app: null, label: heading });
      continue;
    }
    const app = heading.slice(0, at).trim();
    const label = heading.slice(at + " · ".length).trim();
    if (!app || !label) return [];
    calls.push({ app, label });
  }
  return calls;
}

/** The calls an outbound card covers, or [] for any other card. */
export function outboundCalls(card: Pick<OptionCardData, "outboundRequest" | "subtitle">): OutboundCall[] {
  if (!card.outboundRequest) return [];
  const calls = card.outboundRequest.calls;
  if (calls && calls.length > 0) return calls;
  return parseOutboundCalls(card.subtitle);
}

/** The one app the calls go to, or null when they name several or none. */
export function outboundApp(calls: OutboundCall[]): string | null {
  if (calls.length === 0 || calls.some((call) => !call.app)) return null;
  const apps = new Set(calls.map((call) => call.app));
  return apps.size === 1 ? calls[0]!.app : null;
}

/** Each distinct action once, in first-seen order, "×N" when it repeats;
 * past three, the rest are counted. */
export function collapseOutboundCalls(calls: OutboundCall[], namingApps: boolean): string {
  const order: OutboundCall[] = [];
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = JSON.stringify([call.app, call.label]);
    if (!counts.has(key)) order.push(call);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = order.slice(0, SUMMARY_GROUPS).map((call) => {
    const name = namingApps && call.app ? `${call.app} · ${call.label}` : call.label;
    const count = counts.get(JSON.stringify([call.app, call.label])) ?? 1;
    return count > 1 ? `${name} ×${count}` : name;
  });
  const line = parts.join(", ");
  const hidden = order.length - parts.length;
  return hidden > 0 ? `${line}, ${t("approval.outbound.more", { count: hidden })}` : line;
}

export interface OutboundSummary {
  /** "Send to Linear?", or "Send on your behalf?" for several apps or none. */
  headline: string;
  /** "Create linear comment ×2"; empty when the request could not be read. */
  summary: string;
  /** The request runs code the app cannot read (Composio's workbench or
   * proxy). Its raw arguments are code, not a message, so the card keeps
   * them behind Details. */
  opaque?: true;
}

/** The slug the server files every unreadable code request under
 * (shared/outbound.ts connectorCallsIn). */
const OPAQUE_TOOL = "COMPOSIO_PROXY_EXECUTE";

/** Headline and summary for an outbound card; undefined for any other card. */
export function outboundSummary(card: Pick<OptionCardData, "outboundRequest" | "subtitle">): OutboundSummary | undefined {
  if (!card.outboundRequest) return undefined;
  const calls = outboundCalls(card);
  const app = outboundApp(calls);
  if (card.outboundRequest.tool === OPAQUE_TOOL) {
    // "Send to Composio? Proxy execute" reads as if something were sent.
    // Say what is actually asked: code runs on the app's side.
    return {
      headline: t("approval.outbound.runCode", { app: app ?? card.outboundRequest.app ?? "Composio" }),
      summary: "",
      opaque: true,
    };
  }
  return {
    headline: app ? t("approval.outbound.sendTo", { app }) : t("approval.outbound.sendOnBehalf"),
    summary: collapseOutboundCalls(calls, app === null),
  };
}

/** Composio names its tools TOOLKIT_ACTION_WORDS, all upper case. */
const COMPOSIO_TOOL = /^[A-Z][A-Z0-9]+_([A-Z0-9_]+)$/;

/** A Composio slug as a verb phrase, "LINEAR_CREATE_LINEAR_COMMENT" →
 * "create linear comment"; undefined for any other name. */
export function composioActionPhrase(tool: string): string | undefined {
  const match = COMPOSIO_TOOL.exec(tool);
  if (!match) return undefined;
  return match[1]!.replace(/_+/g, " ").trim().toLowerCase() || undefined;
}
