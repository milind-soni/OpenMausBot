/** Security: display data only. An update's change (the bot's fields, its secretRefs) stays in the server's memory until
 * the person answers and never reaches the wire or messages.json, so after a restart a Change card can only expire. A
 * Turn on or Remove card holds no fields, so it still applies after a restart. */
export interface McpChangeRequest {
  requestId: string;
  botId: string;
  threadId: string;
  action: "enable" | "update" | "remove";
  name: string;
  /** sha256 hex of where the server reached when the person was asked (its address, or its command and arguments). An
   * answer applies only while the server still reaches there. */
  targetHash: string;
  result?: { state: "applied" | "denied" | "expired" | "failed"; text: string };
  /** The bot's parked turn took the result. */
  resumed?: boolean;
}
