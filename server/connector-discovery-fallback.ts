// An engine reads the connector bridge's tools/list once, when its session starts. When the connected-apps service does
// not answer then, an empty list would leave the bot only the few app tools defined here (Gmail and Calendar) for the
// whole session, with no way to reach any other connected app: it reads as "only Gmail and Calendar are connected".
// So the bridge lists the connected-apps service's own tools instead, under these short schemas. Each call is still sent
// to the service when it is made, and judged there and by the relay like any other.

const NOTE = " (The connected-apps service did not answer when this session started; if a call fails, try it again shortly.)";

/** The tools a session of the connected-apps service always offers, in the shape it takes them. */
export const DISCOVERY_FALLBACK_TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: "COMPOSIO_SEARCH_TOOLS",
    description: "Find the connected-app tools for a task: Google Drive, Sheets, Docs, Slack, Notion and every other app the person connected. Returns each tool's slug and how to call it." + NOTE,
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          description: "One entry per task.",
          items: {
            type: "object",
            properties: {
              use_case: { type: "string", description: "The task in plain words, e.g. \"read rows from a Google Sheet\"." },
              known_fields: { type: "string", description: "Anything already known that the task needs, e.g. a spreadsheet id." },
            },
            required: ["use_case"],
          },
        },
      },
      required: ["queries"],
    },
  },
  {
    name: "COMPOSIO_GET_TOOL_SCHEMAS",
    description: "Read the full arguments of connected-app tools by their slugs, as COMPOSIO_SEARCH_TOOLS named them." + NOTE,
    inputSchema: {
      type: "object",
      properties: { tool_slugs: { type: "array", items: { type: "string" }, description: "Tool slugs, e.g. GOOGLESHEETS_BATCH_GET." } },
      required: ["tool_slugs"],
    },
  },
  {
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    description: "Run one or more connected-app tools by slug with their arguments." + NOTE,
    inputSchema: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: {
            type: "object",
            properties: { tool_slug: { type: "string" }, arguments: { type: "object" } },
            required: ["tool_slug", "arguments"],
          },
        },
        sync_response_to_workbench: { type: "boolean", description: "false unless the response is very large." },
      },
      required: ["tools"],
    },
  },
  {
    name: "COMPOSIO_MANAGE_CONNECTIONS",
    description: "Ask the person to connect an app that is not connected yet." + NOTE,
    inputSchema: {
      type: "object",
      properties: { toolkits: { type: "array", items: { type: "string" }, description: "App slugs, e.g. googlesheets." } },
      required: ["toolkits"],
    },
  },
];
