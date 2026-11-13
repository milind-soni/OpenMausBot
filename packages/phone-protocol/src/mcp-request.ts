/** Security: display data only. An update's change (the bot's fields, its secretRefs) stays in the server's memory until
 * the person answers and never reaches the wire or messages.json, so after a restart a Change card can only expire. A
 * Turn on or Remove card holds no fields, so it still applies after a restart. */
export interface McpChangeRequest {
  requestId: string;
  botId: string;
  threadId: string;
  action: "enable" | "update" | "remove";
  name: string;
  /** sha256 hex of the server's display target (the masked address, or the command line with secrets hidden), the string
   * the card and the bot show. An answer applies only while the server still reaches there. Security: the card is stored,
   * synced to phones and visible to teammates, so the hash must never cover a raw secret a reader could guess offline;
   * a change confined to a masked part is not detected. */
  targetHash: string;
  result?: { state: "applied" | "denied" | "expired" | "failed"; text: string };
  /** The bot's parked turn took the result. */
  resumed?: boolean;
}
