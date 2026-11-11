import type { ModelPrice, PriceList, PricedTurn } from "./prices.ts";
import { currentPrices } from "./model-manifest/manifest.ts";
import { billableFor } from "./prices.ts";

export interface ListPrice extends ModelPrice {
  asOf: string;
  source: string;
  changes?: ReadonlyArray<ModelPrice & { from: string }>;
}

export function listPrices(): Readonly<Record<string, ListPrice>> {
  return currentPrices().prices;
}

export function listPriceFor(model: string, at: Date = new Date()): ModelPrice | null {
  const { prices, aliases } = currentPrices();
  const key = model.trim().toLowerCase();
  const entry = prices[aliases.get(key) ?? key];
  if (!entry) return null;
  const day = at.toISOString().slice(0, 10);
  const change = entry.changes?.filter((candidate) => candidate.from <= day).at(-1);
  const current = change ?? entry;
  return {
    inputPerMillion: current.inputPerMillion,
    outputPerMillion: current.outputPerMillion,
    ...(current.cachedInputPerMillion !== undefined ? { cachedInputPerMillion: current.cachedInputPerMillion } : {}),
  };
}

export type CostSource = "reported" | "estimated";

export function estimatePriceFor(turn: Pick<PricedTurn, "driverKind" | "model">, operatorPrices: PriceList | null, at: Date = new Date()): ModelPrice | null {
  return operatorPrices?.[`${turn.driverKind}/${turn.model}`] ?? operatorPrices?.[turn.model] ??
    listPriceFor(turn.model, at) ?? operatorPrices?.default ?? null;
}

export function ledgerCost(
  turn: PricedTurn & { costUsd: number | null | undefined },
  operatorPrices: PriceList | null,
  at: Date = new Date(),
): { costUsd: number | null; costSource?: CostSource } {
  if (typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) && turn.costUsd >= 0) {
    return { costUsd: turn.costUsd, costSource: "reported" };
  }
  const unit = estimatePriceFor(turn, operatorPrices, at);
  if (!unit) return { costUsd: null };
  return { costUsd: billableFor(turn, { [turn.model]: unit }), costSource: "estimated" };
}
