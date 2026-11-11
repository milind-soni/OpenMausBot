// The connected app an MCP server stands for, read from its address or its name alone, never from the network. Only apps
// listed here: an unknown server is never offered an app that may not be the same one.
import type { CuratedConnectorSlug } from "../shared/connector-curated.ts";

/** The connected app an MCP server that wants a sign-in can be swapped for in this turn. `connected`: it is connected already. */
export interface McpServerApp { slug: string; label: string; connected: boolean }

type KnownApp = { slug: CuratedConnectorSlug; label: string };
const GMAIL: KnownApp = { slug: "gmail", label: "Gmail" };
const CALENDAR: KnownApp = { slug: "googlecalendar", label: "Google Calendar" };

const BY_HOST: Record<string, KnownApp> = { "gmailmcp.googleapis.com": GMAIL, "calendarmcp.googleapis.com": CALENDAR };
const BY_NAME: ReadonlyArray<readonly [RegExp, KnownApp]> = [
  [/^gmail(?![a-z])/i, GMAIL],
  [/^(?:google[-_ ]?calendar|gcal(?:endar)?)(?![a-z])/i, CALENDAR],
];

export function knownMcpServerApp(name: string, url: string): KnownApp | null {
  const host = URL.canParse(url) ? new URL(url).hostname.toLowerCase() : "";
  return (Object.hasOwn(BY_HOST, host) ? BY_HOST[host] : undefined) ?? BY_NAME.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}
