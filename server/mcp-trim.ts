export const DEFAULT_RESULT_BUDGET = 8_000;
/** The gate's own read-only query over a held result (mcp-shape.ts); named here so the banner and the tool never drift apart. */
export const QUERY_TOOL_NAME = "query_result";

const MIN_BUDGET = 512;

export interface TrimOutcome {
  text: string;
  trimmed: boolean;
  originalChars: number;
  /** The payload as kept by a structural cut, so a matching `structuredContent` keeps the same records. */
  value?: unknown;
}

/** The whole result is kept by the gate under `handle` for query_result (mcp-shape.ts). */
export interface HeldResult {
  handle: string;
  /** describeShape() of the held value */
  shape: string;
  /** a query known to be valid against the held value */
  example?: string;
  /** the text being cut is itself a query_result answer */
  queried?: boolean;
}

export interface TrimInput {
  text: string;
  budget?: number;
  spillPath?: string;
  spillHint?: boolean;
  toolName?: string;
  held?: HeldResult;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function serialize(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}

function fitArray(items: readonly unknown[], budget: number): unknown[] {
  const kept: unknown[] = [];
  let used = 2;
  for (const item of items) {
    const json = serialize(item);
    if (json === null) break;
    const cost = json.length + (kept.length ? 1 : 0);
    if (kept.length && used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  return kept;
}

function arrayFields(value: unknown): Array<{ key: string; items: readonly unknown[] }> {
  if (Array.isArray(value)) return [{ key: "", items: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([key, items]) => ({ key, items }));
}

/** Never mid-surrogate-pair: half an emoji is an invalid string some providers reject outright. */
function cutAt(text: string, chars: number): string {
  const cut = text.slice(0, Math.max(0, chars));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** At both ends: models read a quiet trailing note ("layers 5 of 110") as the whole result. */
export function truncationBanner(input: {
  originalChars: number;
  keptChars: number;
  dropped: Array<{ key: string; kept: number; total: number }>;
  spillPath?: string;
  spillHint?: boolean;
  structural: boolean;
  short?: boolean;
  held?: HeldResult;
  /** the closing banner of a held result: a reminder, not the whole note again */
  footer?: boolean;
}): string {
  const size = `${fmt(input.keptChars)} of ${fmt(input.originalChars)} chars`;
  if (input.held) return heldBanner(input, size);
  if (input.short) return `⚠️ TRUNCATED by OpenMausBot: kept ${size}; the rest was NOT shown. Narrow the call or page.`;
  const counts = input.dropped
    .filter((d) => d.kept < d.total)
    .map((d) => `${d.key || "items"} ${fmt(d.kept)} of ${fmt(d.total)}`)
    .join(", ");
  const what = input.structural && counts
    ? `kept ${counts} (${size}).`
    : input.structural
      ? `kept ${size}.`
      : `kept the first ${size}; the text is cut mid-way, so it may be incomplete JSON.`;
  // Never point at the spilled whole: reading it back costs more than not trimming.
  const next = "If the tool supports paging (offset/limit/page) or a narrower query or filter, call it again for the remaining items; never assume you saw everything.";
  const where = input.spillHint && input.spillPath
    ? ` The whole result is at ${JSON.stringify(input.spillPath)}; reading it costs as much as not trimming, so narrow the call first.`
    : "";
  return `⚠️ TRUNCATED by OpenMausBot: ${what} The rest was NOT shown. ${next}${where}`;
}

/** The result lives on; the model fetches the rest by query, so the note never suggests a file or a narrower call. */
function heldBanner(
  input: { originalChars: number; keptChars: number; dropped: Array<{ key: string; kept: number; total: number }>; held?: HeldResult; short?: boolean; footer?: boolean; structural: boolean },
  size: string,
): string {
  const held = input.held!;
  const counts = input.dropped
    .filter((d) => d.kept < d.total)
    .map((d) => `${d.key || "items"} ${fmt(d.kept)} of ${fmt(d.total)}`)
    .join(", ");
  const kept = input.structural && counts ? `kept ${counts} (${size})` : `kept ${size}`;
  const call = `${QUERY_TOOL_NAME} {"result":"${held.handle}","query":"<JMESPath>"}`;
  if (held.queried) {
    if (input.footer) return `⚠️ TRUNCATED by OpenMausBot: ${kept} of your query on "${held.handle}"; narrow it (see above).`;
    return `⚠️ TRUNCATED by OpenMausBot: your query on "${held.handle}" returned ${fmt(input.originalChars)} chars; ${kept}. The rest was NOT shown. Narrow the query: pick fewer fields with {a: a, b: b}, slice with [0:20], or filter with [?cond]. The result is ${held.shape}.`;
  }
  if (input.footer) return `⚠️ SHAPED by OpenMausBot: ${kept}; the rest is held as "${held.handle}" for ${QUERY_TOOL_NAME} (see the note above).`;
  if (input.short) return `⚠️ SHAPED by OpenMausBot: ${kept}; the rest is held as "${held.handle}": call ${call} for exactly what you need.`;
  const example = held.example ? ` e.g. ${held.example} or length(@).` : "";
  return `⚠️ SHAPED by OpenMausBot: result was ${fmt(input.originalChars)} chars; ${kept}. The whole result is held as "${held.handle}" (${held.shape}). For the rest call ${call} and select only the fields and rows you need,${example} Big answers are cut too; never ask for the whole thing.`;
}

function wrap(body: string, banner: string, footer = banner): string {
  return `${banner}\n\n${body}\n\n${footer}`;
}

export function trimStructured(parsed: unknown, budget: number): { value: unknown; dropped: Array<{ key: string; kept: number; total: number }> } | null {
  const room = Math.max(MIN_BUDGET, budget);
  const current = serialize(parsed);
  if (current !== null && current.length <= room) return null;
  const fields = arrayFields(parsed);
  if (!fields.length) return null;
  const skeleton = Array.isArray(parsed)
    ? 2
    : (serialize({ ...(parsed as Record<string, unknown>), ...Object.fromEntries(fields.map((f) => [f.key, []])) })?.length ?? Infinity);
  const share = Math.floor((room - skeleton) / fields.length);
  if (!Number.isFinite(skeleton) || share <= 0) return null;
  const dropped: Array<{ key: string; kept: number; total: number }> = [];
  let value: unknown;
  if (Array.isArray(parsed)) {
    const kept = fitArray(parsed, share);
    dropped.push({ key: "", kept: kept.length, total: parsed.length });
    value = kept;
  } else {
    const next: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    for (const field of fields) {
      const kept = fitArray(field.items, share);
      dropped.push({ key: field.key, kept: kept.length, total: field.items.length });
      next[field.key] = kept;
    }
    value = next;
  }
  if (!dropped.some((d) => d.kept < d.total)) return null;
  const json = serialize(value);
  return json !== null && json.length <= room ? { value, dropped } : null;
}

export function trimResultText(input: TrimInput): TrimOutcome {
  const { text } = input;
  const budget = Math.max(MIN_BUDGET, input.budget ?? DEFAULT_RESULT_BUDGET);
  if (text.length <= budget) return { text, trimmed: false, originalChars: text.length };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  const fields = parsed === undefined ? [] : arrayFields(parsed);
  // Banners sized at their widest, so the whole result lands under the budget; the short form when full ones would eat half.
  const held = input.held;
  const banner = (opts: { dropped: Array<{ key: string; kept: number; total: number }>; structural: boolean; short: boolean; footer?: boolean; keptChars: number }) =>
    truncationBanner({ originalChars: text.length, spillPath: input.spillPath, spillHint: input.spillHint, held, ...opts });
  const widestOf = (short: boolean) => {
    const variants = [
      { dropped: fields.map((f) => ({ key: f.key, kept: Math.max(0, f.items.length - 1), total: f.items.length })), structural: true },
      { dropped: [], structural: false },
    ];
    return Math.max(...variants.map((v) => banner({ ...v, short, keptChars: text.length }).length + banner({ ...v, short, keptChars: text.length, footer: Boolean(held) }).length));
  };
  const fullRoom = budget - (widestOf(false) + 4);
  const short = fullRoom < budget / 2;
  const room = Math.max(0, short ? budget - (widestOf(true) + 4) : fullRoom);
  if (fields.length) {
    const skeleton = Array.isArray(parsed)
      ? 2
      : (serialize({ ...(parsed as Record<string, unknown>), ...Object.fromEntries(fields.map((f) => [f.key, []])) })?.length ?? Infinity);
    const share = Math.floor((room - skeleton) / fields.length);
    if (Number.isFinite(skeleton) && share > 0) {
      const dropped: Array<{ key: string; kept: number; total: number }> = [];
      let value: unknown;
      if (Array.isArray(parsed)) {
        const kept = fitArray(parsed, share);
        dropped.push({ key: "", kept: kept.length, total: parsed.length });
        value = kept;
      } else {
        const next: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
        for (const field of fields) {
          const kept = fitArray(field.items, share);
          dropped.push({ key: field.key, kept: kept.length, total: field.items.length });
          next[field.key] = kept;
        }
        value = next;
      }
      const json = serialize(value);
      if (json !== null && json.length <= room) {
        return {
          text: wrap(json, banner({ keptChars: json.length, dropped, structural: true, short }), banner({ keptChars: json.length, dropped, structural: true, short, footer: Boolean(held) })),
          trimmed: true,
          originalChars: text.length,
          value,
        };
      }
    }
  }

  const cut = cutAt(text, room);
  return {
    text: wrap(cut, banner({ keptChars: cut.length, dropped: [], structural: false, short }), banner({ keptChars: cut.length, dropped: [], structural: false, short, footer: Boolean(held) })),
    trimmed: true,
    originalChars: text.length,
  };
}
