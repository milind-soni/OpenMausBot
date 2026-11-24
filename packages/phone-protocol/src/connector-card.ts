export interface ConnectorCardData {
  /** What the card connects: a Composio app (absent or "composio"), a sign-in to an MCP server ("mcp"), or the GitHub
   * sign-in after a clone, fetch or push failed for want of one ("github", whose `text` names the bot and the repository). */
  source?: "composio" | "mcp" | "github";
  /** Composio toolkit slug, or the MCP server's name. It is validated server-side before every action. */
  slug: string;
  /** A "github" card on a Team Cloud: the member whose own GitHub sign-in it asks for (their person key), kept on the
   * card so only they can settle it, whoever writes in the chat later and across restarts. */
  person?: string;
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
