// ChatGPT credits on a Codex account: what the usage endpoint says about them, and whether they carry a send past a
// full window.

/** The ChatGPT usage endpoint's `credits` object: `has_credits`, `unlimited` and `balance`. Anything else reads as
 * no credits. */
export function codexHasCredits(value: unknown): boolean {
  const credits = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!credits) return false;
  if (credits.unlimited === true) return true;
  if (credits.has_credits !== true) return false;
  const balance = typeof credits.balance === "string" ? Number(credits.balance) : credits.balance;
  return typeof balance === "number" && Number.isFinite(balance) && balance > 0;
}

/** A local signal that Codex's ChatGPT credits are on and not used up, so a full window does not stop a send here. */
export function codexHasCreditRoom(row: { driver: string; codexCredits?: true }): boolean {
  return row.driver === "codex" && row.codexCredits === true;
}
