// The connected app an MCP server stands for, read from its address or its name alone, never from the network. Only apps
// listed here: an unknown server is never offered an app that may not be the same one.
import type { CuratedConnectorSlug } from "../shared/connector-curated.ts";

/** The connected app an MCP server that wants a sign-in can be swapped for in this turn. `connected`: it is connected already. */
export interface McpServerApp { slug: string; label: string; connected: boolean }

type KnownApp = { slug: CuratedConnectorSlug; label: string };
const GMAIL: KnownApp = { slug: "gmail", label: "Gmail" };
const CALENDAR: KnownApp = { slug: "googlecalendar", label: "Google Calendar" };
const DRIVE: KnownApp = { slug: "googledrive", label: "Google Drive" };
const SHEETS: KnownApp = { slug: "googlesheets", label: "Google Sheets" };
const DOCS: KnownApp = { slug: "googledocs", label: "Google Docs" };

const BY_HOST: Record<string, KnownApp> = { "gmailmcp.googleapis.com": GMAIL, "calendarmcp.googleapis.com": CALENDAR };
/** Another editor's hosted Google servers, `/rest-mcp/<app>/mcp`, which sign in only from that editor (Google refuses this
 * app's address as the sign-in's return address): one copied here stands for the connected app. */
const HOSTED: Record<string, Record<string, KnownApp>> = {
  "api.cursor.com": { "google-drive": DRIVE, "google-sheets": SHEETS, "google-docs": DOCS },
};
/** At any other address, only a name that is the app's own: "gmail-filters" or "gcal2notion" is another tool. */
const BY_NAME: ReadonlyArray<readonly [RegExp, KnownApp]> = [
  [/^gmail(?:[-_]mcp)?$/i, GMAIL],
  [/^(?:google[-_]?calendar|gcal(?:endar)?)(?:[-_]mcp)?$/i, CALENDAR],
  [/^google[-_]?drive(?:[-_]mcp)?$/i, DRIVE],
  [/^google[-_]?sheets(?:[-_]mcp)?$/i, SHEETS],
  [/^google[-_]?docs(?:[-_]mcp)?$/i, DOCS],
];

/** The app path of a server at one of those hosted addresses, or undefined for any other address. */
function hostedPath(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const { hostname, pathname } = new URL(url);
  if (!Object.hasOwn(HOSTED, hostname.toLowerCase())) return undefined;
  return /^\/rest-mcp\/([a-z-]+)(?:\/|$)/.exec(pathname)?.[1];
}

function hostedApp(url: string): KnownApp | undefined {
  const app = hostedPath(url);
  const apps = app === undefined ? undefined : HOSTED[new URL(url).hostname.toLowerCase()];
  return apps && app && Object.hasOwn(apps, app) ? apps[app] : undefined;
}

/** A server at one of those hosted addresses: its sign-in can never finish from here, whatever app it is for. */
export function signsInOnlyElsewhere(url: string): boolean {
  return hostedPath(url) !== undefined;
}

export function knownMcpServerApp(name: string, url: string): KnownApp | null {
  const host = URL.canParse(url) ? new URL(url).hostname.toLowerCase() : "";
  return (Object.hasOwn(BY_HOST, host) ? BY_HOST[host] : undefined) ?? hostedApp(url) ?? BY_NAME.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}
