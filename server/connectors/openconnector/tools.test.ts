// OpenConnector action ids must speak on the connector surface as the repo's own tool shape —
// upper-snake names satisfying shared CONNECTOR_TOOL_NAME_PATTERN, grouped under the toolkit slug
// that connectorTools/connectorScopes grants key on, with read/write decided by the existing verb
// rules in shared/connector-scopes.ts. These tests pin all three against the mapping module.
import { describe, expect, it } from "vitest";
import { CONNECTOR_TOOL_NAME_PATTERN } from "../../../shared/wire.ts";
import { isReadOnlyAction } from "../../../shared/connector-scopes.ts";
import { serviceSlugFor, serviceSlugForCandidates } from "../../connector-verdict.ts";
import {
  TOOL_DESCRIPTION_MAX,
  actionForConnectorTool,
  connectorToolForAction,
  connectorToolListingForAction,
} from "./tools.ts";

const MAPPING_CASES = [
  "github.get_current_user",
  "gmail.send_email",
  "google_calendar.create_event",
  "google_calendar.list_events",
  "bland_ai.send_call",
  "slack.post_message",
  "linear.create_issue",
  "notion.search_pages",
  "stripe.create_payment_link",
  "a1_b2.c3_d4",
] as const;

describe("connectorToolForAction", () => {
  it("maps every catalog id to a pattern-compliant upper-snake name", () => {
    for (const id of MAPPING_CASES) {
      const mapped = connectorToolForAction(id);
      expect(mapped, id).not.toBeNull();
      expect(CONNECTOR_TOOL_NAME_PATTERN.test(mapped!.name), mapped!.name).toBe(true);
      expect(mapped!.service).toBe(id.slice(0, id.indexOf(".")));
    }
    expect(connectorToolForAction("github.get_current_user")).toEqual({ service: "github", name: "GITHUB_GET_CURRENT_USER" });
  });

  it("keeps underscores inside underscored services intact", () => {
    expect(connectorToolForAction("google_calendar.get_event")).toEqual({ service: "google_calendar", name: "GOOGLE_CALENDAR_GET_EVENT" });
    expect(connectorToolForAction("bland_ai.send_call")).toEqual({ service: "bland_ai", name: "BLAND_AI_SEND_CALL" });
  });

  it("refuses malformed ids instead of emitting a partial name", () => {
    for (const bad of ["", "nodot", ".get", "github.", "Git Hub.get", "github.get x", "github..get", "x".repeat(200) + ".get"]) {
      expect(connectorToolForAction(bad), bad).toBeNull();
    }
  });

  it("caps names at the pattern's 128 characters", () => {
    const long = `github.${"a".repeat(130)}`;
    expect(connectorToolForAction(long)).toBeNull();
    const fits = `gh.${"a".repeat(119)}`;
    const mapped = connectorToolForAction(fits);
    expect(mapped).not.toBeNull();
    expect(mapped!.name.length).toBeLessThanOrEqual(128);
    expect(CONNECTOR_TOOL_NAME_PATTERN.test(mapped!.name)).toBe(true);
  });
});

describe("actionForConnectorTool", () => {
  it("round-trips catalog ids through the candidates-aware inverse", () => {
    const candidates = MAPPING_CASES.map((id) => id.slice(0, id.indexOf(".")));
    for (const id of MAPPING_CASES) {
      const mapped = connectorToolForAction(id)!;
      expect(actionForConnectorTool(mapped.name, candidates), id).toBe(id);
    }
  });

  it("lets the longest candidate win for underscored services", () => {
    const candidates = ["bland", "bland_ai"];
    expect(actionForConnectorTool("BLAND_AI_SEND_CALL", candidates)).toBe("bland_ai.send_call");
    expect(actionForConnectorTool("BLAND_GET_X", candidates)).toBe("bland.get_x");
  });

  it("falls back to the first underscore without candidates and refuses non-pattern names", () => {
    expect(actionForConnectorTool("GMAIL_SEND_EMAIL", [])).toBe("gmail.send_email");
    expect(actionForConnectorTool("NOUNDERSCORE", [])).toBeNull();
    expect(actionForConnectorTool("lowercase_name", [])).toBeNull();
  });
});

describe("grant and scope compatibility (no fork)", () => {
  it("resolves each mapped name to its service with the existing slug helpers", () => {
    const candidates = ["google_calendar", "github", "gmail"];
    const cases: Array<[string, string]> = [
      ["GITHUB_GET_CURRENT_USER", "github"],
      ["GOOGLE_CALENDAR_CREATE_EVENT", "google_calendar"],
      ["GOOGLE_CALENDAR_LIST_EVENTS", "google_calendar"],
      ["GMAIL_SEND_EMAIL", "gmail"],
    ];
    for (const [name, service] of cases) {
      // Exactly what connector-verdict does for a granted tool name.
      expect(serviceSlugForCandidates(name, candidates) ?? serviceSlugFor(name)).toBe(service);
    }
  });

  it("keeps the existing read-verb rule over mapped names", () => {
    // The relay's two-step: resolve the toolkit with the slug helpers, then apply the verb rule —
    // underscored services need the toolkit length to find their action part.
    const candidates = ["google_calendar", "github", "gmail", "notion", "linear", "slack", "stripe"];
    const read = (name: string) => isReadOnlyAction(name, serviceSlugForCandidates(name, candidates) ?? undefined);
    const reads = ["GITHUB_GET_CURRENT_USER", "GOOGLE_CALENDAR_LIST_EVENTS", "NOTION_SEARCH_PAGES", "GMAIL_FETCH_MESSAGE", "LINEAR_FETCH_ISSUES"];
    const writes = ["GMAIL_SEND_EMAIL", "SLACK_POST_MESSAGE", "LINEAR_CREATE_ISSUE", "STRIPE_CREATE_PAYMENT_LINK", "GITHUB_DELETE_REPOSITORY"];
    for (const name of reads) {
      expect(read(name), name).toBe(true);
    }
    for (const name of writes) {
      expect(read(name), name).toBe(false);
    }
  });

  it("scopes key on the mapped service slug", () => {
    const mapped = connectorToolForAction("google_calendar.create_event")!;
    expect(mapped.service).toBe("google_calendar");
    // The shape connectorScopes.apps stores: { apps: { "google_calendar": "write" } }.
    expect(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(mapped.service)).toBe(true);
  });
});

describe("connectorToolListingForAction", () => {
  it("trims descriptions to the shared cap and drops blanks", () => {
    const listing = connectorToolListingForAction({ id: "github.get_current_user", description: `  who\n am\t${"x".repeat(TOOL_DESCRIPTION_MAX + 50)} ` });
    expect(listing!.description!.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX);
    expect(listing!.description).not.toContain("\n");
    expect(connectorToolListingForAction({ id: "github.get_current_user", description: "   " })).toEqual({ service: "github", name: "GITHUB_GET_CURRENT_USER", inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] } });
    expect(connectorToolListingForAction({ id: "bad id", description: "x" })).toBeNull();
  });
});
