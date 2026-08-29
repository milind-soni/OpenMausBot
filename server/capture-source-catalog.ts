import { hasAgentCapability } from "./agent-capabilities.ts";

/**
 * The Capture package uses stable source ids rather than connector names.
 * Keep this catalog small, explicit, and credential-free: it is safe to
 * expose in diagnostics and makes readiness failures actionable before a
 * routine starts.
 */

export type CaptureSourceTransport = "connector" | "browser" | "local";
export type CaptureSourceCursorKind = "opaque" | "timestamp" | "file" | "none";
export type CaptureSourceReadiness = "ready" | "needs-auth" | "unavailable";

/** A source may have a local/API transport and a browser fallback. Keeping
 * transport facts on the source (instead of inferring them from a browser
 * receipt) lets diagnostics describe the real path that will be used. */
export type CaptureSourceTransportSpec =
  | { transport: "connector"; connectorSlug: string }
  | { transport: "browser"; browserHost: string }
  | { transport: "local"; capabilityIds?: readonly string[] };

interface CaptureSourceBase {
  id: string;
  label: string;
  cursorKind: CaptureSourceCursorKind;
  /** A source can be part of more than one schedule without duplicating it. */
  schedules: readonly ("fast" | "hourly" | "manual")[];
  privacy: "metadata" | "content" | "local";
  /** Ordered fallback transports. The first ready transport wins. */
  fallbackTransports?: readonly CaptureSourceTransportSpec[];
}

export type CaptureSourceDefinition =
  & CaptureSourceBase
  & CaptureSourceTransportSpec;

export const CAPTURE_SOURCE_CATALOG: readonly CaptureSourceDefinition[] = [
  ...[1, 2, 3].map((account) => ({
    id: `gmail-account-${account}`,
    label: `Gmail account ${account}`,
    transport: "connector" as const,
    connectorSlug: "gmail",
    cursorKind: "opaque" as const,
    schedules: ["fast", "hourly", "manual"] as const,
    privacy: "content" as const,
  })),
  ...[1, 2, 3].map((account) => ({
    id: `calendar-account-${account}`,
    label: `Calendar account ${account}`,
    transport: "connector" as const,
    connectorSlug: "googlecalendar",
    cursorKind: "opaque" as const,
    schedules: ["fast", "hourly", "manual"] as const,
    privacy: "content" as const,
  })),
  ...[1, 2, 3].map((account) => ({
    id: `drive-account-${account}`,
    label: `Google Drive account ${account}`,
    transport: "connector" as const,
    connectorSlug: "googledrive",
    cursorKind: "opaque" as const,
    schedules: ["hourly", "manual"] as const,
    privacy: "content" as const,
  })),
  {
    id: "github",
    label: "GitHub",
    transport: "connector",
    connectorSlug: "github",
    cursorKind: "opaque",
    schedules: ["hourly", "manual"],
    privacy: "content",
  },
  {
    id: "plaud",
    label: "Plaud",
    transport: "local",
    capabilityIds: ["plaud-cli", "plaud"],
    fallbackTransports: [{ transport: "browser", browserHost: "plaud.ai" }],
    cursorKind: "timestamp",
    schedules: ["fast", "hourly", "manual"],
    privacy: "content",
  },
  {
    id: "google-messages",
    label: "Google Messages",
    transport: "local",
    capabilityIds: ["notification-mirror", "google-messages"],
    fallbackTransports: [{ transport: "browser", browserHost: "messages.google.com" }],
    cursorKind: "timestamp",
    schedules: ["fast", "hourly", "manual"],
    privacy: "content",
  },
  {
    id: "monarch",
    label: "Monarch",
    transport: "browser",
    browserHost: "monarchmoney.com",
    cursorKind: "timestamp",
    schedules: ["hourly", "manual"],
    privacy: "content",
  },
  {
    id: "mercury",
    label: "Mercury",
    transport: "local",
    // Mercury's direct adapter is hosted by the local Anvil BI workspace;
    // the browser is only a fallback and is not required for readiness.
    capabilityIds: ["mercury-anvil", "anvil-bi", "mercury"],
    fallbackTransports: [{ transport: "browser", browserHost: "mercury.com" }],
    cursorKind: "timestamp",
    schedules: ["hourly", "manual"],
    privacy: "content",
  },
  {
    id: "chrome-history",
    label: "Chrome history",
    transport: "local",
    cursorKind: "timestamp",
    schedules: ["hourly", "manual"],
    privacy: "metadata",
  },
  {
    id: "youtube",
    label: "YouTube",
    transport: "browser",
    browserHost: "youtube.com",
    cursorKind: "timestamp",
    schedules: ["hourly", "manual"],
    privacy: "metadata",
  },
  ...[
    ["ai-chatgpt", "ChatGPT sidebar", "chatgpt.com"],
    ["ai-claude", "Claude sidebar", "claude.ai"],
    ["ai-grok", "Grok sidebar", "grok.com"],
    ["ai-gemini", "Gemini sidebar", "gemini.google.com"],
  ].map(([id, label, browserHost]) => ({
    id,
    label,
    transport: "browser" as const,
    browserHost,
    cursorKind: "timestamp" as const,
    schedules: ["hourly", "manual"] as const,
    privacy: "metadata" as const,
  })),
  {
    id: "whoop",
    label: "WHOOP",
    transport: "local",
    cursorKind: "file",
    schedules: ["hourly", "manual"],
    privacy: "local",
  },
  {
    id: "anvil-bi",
    label: "Anvil BI",
    transport: "local",
    cursorKind: "none",
    schedules: ["hourly", "manual"],
    privacy: "local",
  },
  {
    id: "telegram-relay",
    label: "Telegram relay",
    transport: "local",
    cursorKind: "none",
    schedules: ["hourly", "manual"],
    privacy: "metadata",
  },
  {
    id: "hevy",
    label: "Hevy",
    transport: "local",
    cursorKind: "file",
    schedules: ["hourly", "manual"],
    privacy: "local",
  },
  {
    id: "local-inbox",
    label: "Local inbox",
    transport: "local",
    cursorKind: "file",
    schedules: ["hourly", "manual"],
    privacy: "local",
  },
  {
    id: "grok-corpus",
    label: "Grok desktop corpus",
    transport: "local",
    cursorKind: "file",
    schedules: ["manual"],
    privacy: "local",
  },
  {
    id: "grok-bot-os",
    label: "Grok Bot OS",
    transport: "local",
    cursorKind: "file",
    schedules: ["manual"],
    privacy: "local",
  },
] as const;

const CATALOG_BY_ID = new Map(CAPTURE_SOURCE_CATALOG.map((source) => [source.id, source]));

function browserHost(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`.${expected}`);
}

export interface CaptureReadinessInput {
  /** Connector slugs with at least one authorized account. */
  connectedConnectors?: readonly string[];
  /** Browser origins that have a usable, signed-in session. */
  browserOrigins?: readonly string[];
  /** Local capability ids such as `chrome-history`, `whoop`, or `local-inbox`. */
  localCapabilities?: readonly string[];
}

export interface CaptureSourceReadinessResult {
  sourceId: string;
  label: string;
  readiness: CaptureSourceReadiness;
  reason?: string;
}

/** The reviewed Capture package may read explicitly selected local sources
 * without enabling full computer control. This is intentionally an exact
 * package-id grant, not a general-purpose local-file capability. */
export const READ_ONLY_LOCAL_CAPTURE_PACKAGE_ID = "shane-grok-capture-replica";
/**
 * Compatibility adapter for callers that still use the old name. New code
 * should authorize the source.ingestion capability directly. Keeping this
 * adapter means old package records continue to work while migration moves
 * their grants onto the bot record.
 */
export function hasReadOnlyLocalCaptureGrant(input: {
  installedPackage?: unknown;
  playbooks?: unknown;
  chiefOfStaff?: unknown;
  agentGrants?: unknown;
}): boolean {
  return hasAgentCapability(input, "source.ingestion");
}

/**
 * Evaluate readiness without probing accounts or reading any secret. This is
 * deliberately conservative: a connector slug means at least one account,
 * while the three account slots still need explicit alias assignment in the
 * connection UI before their routines are enabled.
 */
export function evaluateCaptureReadiness(
  input: CaptureReadinessInput,
  sourceIds: readonly string[] = CAPTURE_SOURCE_CATALOG.map((source) => source.id),
): CaptureSourceReadinessResult[] {
  const connectors = new Set(input.connectedConnectors ?? []);
  const browsers = new Set(input.browserOrigins ?? []);
  const locals = new Set(input.localCapabilities ?? []);
  const evaluateTransport = (transport: CaptureSourceTransportSpec): CaptureSourceReadinessResult["readiness"] => {
    if (transport.transport === "connector") {
      return connectors.has(transport.connectorSlug) ? "ready" : "needs-auth";
    }
    if (transport.transport === "browser") {
      return [...browsers].some((origin) => {
        const actualHost = browserHost(origin);
        return actualHost !== null && hostMatches(actualHost, transport.browserHost);
      }) ? "ready" : "needs-auth";
    }
    const capabilityIds = transport.capabilityIds ?? [];
    return capabilityIds.some((capabilityId) => locals.has(capabilityId)) ? "ready" : "unavailable";
  };

  return sourceIds.map((sourceId) => {
    const source = CATALOG_BY_ID.get(sourceId);
    if (!source) {
      return { sourceId, label: sourceId, readiness: "unavailable", reason: "Unknown capture source id" };
    }
    const primaryTransport: CaptureSourceTransportSpec = source.transport === "connector"
      ? { transport: source.transport, connectorSlug: source.connectorSlug }
      : source.transport === "browser"
        ? { transport: source.transport, browserHost: source.browserHost }
        : { transport: source.transport, capabilityIds: source.capabilityIds ?? [source.id] };
    const transports = [primaryTransport, ...(source.fallbackTransports ?? [])];
    const readiness = transports.map(evaluateTransport);
    if (readiness.includes("ready")) {
      return { sourceId, label: source.label, readiness: "ready" };
    }
    if (readiness.includes("needs-auth")) {
      const primary = primaryTransport.transport === "connector"
        ? `Authorize ${primaryTransport.connectorSlug}`
        : primaryTransport.transport === "browser"
          ? `Open a signed-in ${source.label} browser session`
          : `Enable local source ${source.id}`;
      return { sourceId, label: source.label, readiness: "needs-auth", reason: primary };
    }
    return { sourceId, label: source.label, readiness: "unavailable", reason: `Enable local source ${source.id}` };
  });
}

export function captureSourceDefinition(sourceId: string): CaptureSourceDefinition | null {
  return CATALOG_BY_ID.get(sourceId) ?? null;
}
