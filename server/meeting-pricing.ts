import type { MeetingUsage } from "../shared/meeting-limits.ts";

const URL = "https://openrouter.ai/api/v1/models";
type Rates = { prompt: number; completion: number; input_cache_read?: number };
export interface MeetingPrice { model: string; rates: Rates; fetchedAt: number; source: string }
type CatalogueRow = { id: string; pricing?: Record<string, unknown> };
let cached: { at: number; rows: CatalogueRow[] } | undefined;
let pending: Promise<void> | undefined;

function rate(value: unknown, label: string): number {
  if (value === undefined || value === null || value === "" ||
      !["string", "number"].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`Missing or invalid OpenRouter ${label} rate`);
  }
  return Number(value);
}

export function resolveMeetingPrice(model: string, rows: CatalogueRow[], at: number): MeetingPrice {
  const exact = rows.find(row => row.id === model);
  const matches = exact ? [exact] : rows.filter(row => row.id.slice(row.id.indexOf("/") + 1) === model);
  if (matches.length !== 1) throw new Error(`No unique OpenRouter price for ${model}; choose a priced model before using a dollar limit.`);
  const row = matches[0], p = row.pricing ?? {};
  // Usage is reported per provider turn, not necessarily per HTTP call.
  // Do not pretend a token estimate accounts for unobservable fixed fees.
  if (p.request !== undefined && rate(p.request, "request") !== 0) throw new Error(`Per-request pricing for ${model} cannot be enforced from turn usage.`);
  if (Array.isArray(p.overrides) && p.overrides.length) throw new Error(`Tiered pricing for ${model} requires per-request usage; choose a flat-rate model.`);
  return { model: row.id, source: URL, fetchedAt: at, rates: {
    prompt: rate(p.prompt, "input"), completion: rate(p.completion, "output"),
    ...(p.input_cache_read === undefined ? {} : { input_cache_read: rate(p.input_cache_read, "cached input") }),
  } };
}

export async function openRouterMeetingPrices(models: string[]): Promise<Record<string, MeetingPrice>> {
  if (!cached || Date.now() - cached.at > 600_000) {
    pending ??= (async () => {
      const response = await fetch(URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`OpenRouter pricing unavailable (${response.status})`);
      const body = await response.json() as { data?: unknown };
      if (!Array.isArray(body.data) || body.data.some(row => !row || typeof row.id !== "string")) throw new Error("Invalid OpenRouter model catalogue");
      cached = { at: Date.now(), rows: body.data };
    })().finally(() => { pending = undefined; });
    await pending;
  }
  return Object.fromEntries([...new Set(models)].map(model => [model, resolveMeetingPrice(model, cached!.rows, cached!.at)]));
}

export function meetingUsageCost(usage: MeetingUsage, price: MeetingPrice): number {
  const clean = (n: number | undefined) => typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
  const input = clean(usage.input), cachedInput = Math.min(input, clean(usage.cachedInput));
  return (input - cachedInput) * price.rates.prompt + cachedInput * (price.rates.input_cache_read ?? price.rates.prompt) + clean(usage.output) * price.rates.completion;
}
