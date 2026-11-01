/** Security: display data only. The change itself (the bot's fields, its secretRefs) stays in the server's memory until
 * the person answers and never reaches the wire or messages.json, so after a restart the card can only expire. */
export interface McpChangeRequest {
  requestId: string;
  botId: string;
  threadId: string;
  action: "enable" | "update" | "remove";
  name: string;
  result?: { state: "applied" | "denied" | "expired" | "failed"; text: string };
  /** The bot's parked turn took the result. */
  resumed?: boolean;
}
