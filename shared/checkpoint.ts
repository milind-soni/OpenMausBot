/** Preserved independently of narrative summaries. Source IDs refer to the
 * original genuine user messages, which remain in the durable history. */
export interface CheckpointRequirement {
  id: string;
  text: string;
  sourceIds: string[];
  /** A model may suggest supersession, but cannot erase the original rule.
   * Exact later user wording lets the next agent reconcile the two. */
  corrections?: Array<{ sourceId: string; text: string }>;
}
