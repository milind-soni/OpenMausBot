/** A moment a client words in the reader's language: `clock` "10:30 AM" (marked UTC when there is no zone),
 * `bareClock` the same never marked, `longDate` "Thursday, October 22", `shortDate` "Thu, Oct 22". */
export interface WidgetMoment {
  at: number;
  style: "clock" | "bareClock" | "longDate" | "shortDate";
  zone?: string;
}

export type WidgetTextParam = string | number | WidgetText | WidgetMoment;

/** A server card's words as a `brief.*` or `server.meetings.*` (or a cause's `chat.notice.*`) catalog key and its params, which may name other keys or moments. The node
 * keeps its English beside it, which older clients and every bot widget show. */
export interface WidgetText {
  key: string;
  params?: Record<string, WidgetTextParam>;
}

/** The fields of one widget node a server card names by key. */
export type WidgetTextFields = Partial<Record<"value" | "label" | "title" | "caption", WidgetText>>;

const FIELDS = ["value", "label", "title", "caption"] as const;
const KEY = /^(?:brief|chat\.notice|server\.meetings)\.[\w.]{1,80}$/;
const STYLES = new Set<WidgetMoment["style"]>(["clock", "bareClock", "longDate", "shortDate"]);
const MAX_PARAMS = 8;
const MAX_DEPTH = 3;
const MAX_STRING = 400;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function readParam(raw: unknown, depth: number): WidgetTextParam | undefined {
  if (typeof raw === "string") return raw.slice(0, MAX_STRING);
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (!isRecord(raw)) return undefined;
  if (typeof raw.at === "number" && Number.isFinite(raw.at) && STYLES.has(raw.style as WidgetMoment["style"])) {
    return { at: raw.at, style: raw.style as WidgetMoment["style"], ...(typeof raw.zone === "string" && raw.zone.length <= 64 ? { zone: raw.zone } : {}) };
  }
  return readText(raw, depth + 1);
}

function readText(raw: unknown, depth: number): WidgetText | undefined {
  if (!isRecord(raw) || typeof raw.key !== "string" || !KEY.test(raw.key) || depth > MAX_DEPTH) return undefined;
  if (raw.params === undefined) return { key: raw.key };
  if (!isRecord(raw.params)) return undefined;
  const entries = Object.entries(raw.params).slice(0, MAX_PARAMS).map(([name, value]) => [name, readParam(value, depth)] as const);
  if (entries.some(([name, value]) => value === undefined || !/^\w{1,32}$/.test(name))) return undefined;
  return { key: raw.key, params: Object.fromEntries(entries) as Record<string, WidgetTextParam> };
}

/** A node's `i18n` as it may be kept: anything malformed is dropped, and the node keeps its English. */
export function readWidgetText(raw: unknown): WidgetTextFields | undefined {
  if (!isRecord(raw)) return undefined;
  const fields: WidgetTextFields = {};
  for (const field of FIELDS) {
    const text = readText(raw[field], 0);
    if (text) fields[field] = text;
  }
  return Object.keys(fields).length ? fields : undefined;
}
