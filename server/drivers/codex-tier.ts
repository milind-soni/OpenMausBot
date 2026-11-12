/** An official Codex row run on one of its model's service tiers (`gpt-5.5+priority`, the catalog's Fast). The driver sends
 * the tier as turn/start's `serviceTierForTurn`: that turn only, so the thread's own tier stays and a plain row is standard. */
export const TIERED_ID = /^(.+)\+([a-z][a-z0-9_-]*)$/i;
