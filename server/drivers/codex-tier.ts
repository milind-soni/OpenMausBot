/** An official Codex row run on one of its model's service tiers (`gpt-5.5+priority`, the catalog's Fast). The driver sends
 * the tier as turn/start's `serviceTierForTurn`: that turn only, so the thread's own tier stays and a plain row is standard. */
export const TIERED_ID = /^(.+)\+([a-z][a-z0-9_-]*)$/i;
export const SEP = "::";
export const MODEL_ID = /^[\w][\w./:+-]*$/;

/** The base model and tier of an official Fast row; null for any other id, so a provider-qualified `local::foo+priority` keeps its `+`. */
export function codexTierOf(id: string): { model: string; tier: string } | null {
  if (id.includes(SEP) || !MODEL_ID.test(id)) return null;
  const tiered = TIERED_ID.exec(id);
  return tiered ? { model: tiered[1], tier: tiered[2] } : null;
}
