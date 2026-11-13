export interface ConnectorCardData {
  /** What the card connects: a Composio app (absent or "composio"), or a sign-in to an MCP server ("mcp"). */
  source?: "composio" | "mcp";
  /** Composio toolkit slug, or the MCP server's name. It is validated server-side before every action. */
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  /** Cards created by one agent request resume together after all connect. */
  resumeKey: string;
  /** Account alias supplied by the agent when adding a second account. */
  alias?: string;
  error?: string;
  dismissed?: boolean;
  /** A newer card for the same request replaced this one: it is hidden as `dismissed` is, and nothing waits on it. */
  superseded?: boolean;
  resumed?: boolean;
  /** Stop ended the turn this card paused: it offers no action, and a
   * connection made afterwards is kept but continues nothing. */
  stopped?: boolean;
}
