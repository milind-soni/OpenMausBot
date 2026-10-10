// Sell prices per million tokens, and what one ledger row is billable at.
// Pure arithmetic shared by the ledger summaries and the spend module; the
// numbers are the operator's own price list, never a vendor rate card.
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Re-read context, when priced apart; falls back to the input rate. */
  cachedInputPerMillion?: number;
}

/** Keyed by `driver/model`, by model id, or `default`. */
export type PriceList = Record<string, ModelPrice>;

export interface PricedTurn {
  driverKind: string;
  model: string;
  input: number;
  output: number;
  cachedInput?: number;
}

/** The most specific price for a turn: driver/model, then model, then default. */
export function priceFor(turn: Pick<PricedTurn, "driverKind" | "model">, prices: PriceList): ModelPrice | null {
  return prices[`${turn.driverKind}/${turn.model}`] ?? prices[turn.model] ?? prices.default ?? null;
}

const clean = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);

/** Dollars billable for one turn, or null when the list has no price for it. */
export function billableFor(turn: PricedTurn, prices: PriceList): number | null {
  const price = priceFor(turn, prices);
  if (!price) return null;
  const input = clean(turn.input);
  const cached = Math.min(clean(turn.cachedInput), input);
  const fresh = input - cached;
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion;
  return (fresh * price.inputPerMillion + cached * cachedRate + clean(turn.output) * price.outputPerMillion) / 1_000_000;
}
