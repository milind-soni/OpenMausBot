// Registry fields a reseller owns. Pure and strict: a malformed value throws, because an older binary dropping a field
// silently would bill or brand a workspace wrongly.

export const FLEET_STATUSES = ["running", "suspended", "provisioning", "error", "retained"] as const;
export type FleetWorkspaceStatus = (typeof FLEET_STATUSES)[number];

export const FLEET_MAX_EVENTS = 100;

/** Minor units (cents) per month. */
export interface RateSet {
  workspaceMonthMinor: number;
  userMonthMinor: number;
}

export interface FleetReseller {
  /** 1 to 40 characters, the brand name limit; also the default brand name. */
  name: string;
  /** ISO 4217 code. */
  currency: string;
  /** What the reseller owes the vendor, as the reseller asserts it. */
  wholesale: RateSet;
  /** What the reseller charges its customers. */
  retail: RateSet;
  /** Sign-in mail relay; `urlFile` is a root-readable path holding the SMTP URL. */
  smtp?: { urlFile: string; from: string };
}

export interface FleetWorkspaceEvent {
  /** ISO time. */
  at: string;
  status: FleetWorkspaceStatus;
}

/** Currencies whose minor unit is 1/100, the only ones the CLI accepts. */
export const TWO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "AED", "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EGP", "EUR", "GBP", "HKD", "ILS", "INR", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "QAR", "RON", "SAR", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

const RATE_KEYS = ["workspaceMonthMinor", "userMonthMinor"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function record(value: unknown, what: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${what} has an unknown field "${key}"`);
  return value;
}

function minor(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${what} must be a non-negative whole number of minor units`);
  return value;
}

const hasControl = (text: string) => [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function line(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max || hasControl(value)) throw new Error(`${what} must be 1 to ${max} characters without control characters`);
  return value;
}

function rateSet(value: unknown, what: string): RateSet {
  const fields = record(value, what, RATE_KEYS);
  return { workspaceMonthMinor: minor(fields.workspaceMonthMinor, `${what}.workspaceMonthMinor`), userMonthMinor: minor(fields.userMonthMinor, `${what}.userMonthMinor`) };
}

export function parseRetailOverride(value: unknown): Partial<RateSet> {
  const fields = record(value, "retailOverride", RATE_KEYS);
  return {
    ...(fields.workspaceMonthMinor !== undefined ? { workspaceMonthMinor: minor(fields.workspaceMonthMinor, "retailOverride.workspaceMonthMinor") } : {}),
    ...(fields.userMonthMinor !== undefined ? { userMonthMinor: minor(fields.userMonthMinor, "retailOverride.userMonthMinor") } : {}),
  };
}

export function parseReseller(value: unknown): FleetReseller {
  const fields = record(value, "reseller", ["name", "currency", "wholesale", "retail", "smtp"]);
  if (typeof fields.currency !== "string" || !/^[A-Z]{3}$/.test(fields.currency)) throw new Error("reseller.currency must be a three-letter ISO code in capitals");
  let smtp: FleetReseller["smtp"];
  if (fields.smtp !== undefined) {
    const mail = record(fields.smtp, "reseller.smtp", ["urlFile", "from"]);
    const urlFile = line(mail.urlFile, "reseller.smtp.urlFile", 1024);
    if (!urlFile.startsWith("/")) throw new Error("reseller.smtp.urlFile must be an absolute path");
    smtp = { urlFile, from: line(mail.from, "reseller.smtp.from", 254) };
  }
  return {
    name: line(fields.name, "reseller.name", 40),
    currency: fields.currency,
    wholesale: rateSet(fields.wholesale, "reseller.wholesale"),
    retail: rateSet(fields.retail, "reseller.retail"),
    ...(smtp ? { smtp } : {}),
  };
}

export function parseEvents(value: unknown): FleetWorkspaceEvent[] {
  if (!Array.isArray(value)) throw new Error("events must be an array");
  if (value.length > FLEET_MAX_EVENTS) throw new Error(`events holds at most ${FLEET_MAX_EVENTS} entries`);
  return value.map((item, index) => {
    const event = record(item, `events[${index}]`, ["at", "status"]);
    const at = event.at;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) throw new Error(`events[${index}].at must be an ISO time`);
    if (!FLEET_STATUSES.includes(event.status as FleetWorkspaceStatus)) throw new Error(`events[${index}].status must be one of ${FLEET_STATUSES.join(", ")}`);
    return { at, status: event.status as FleetWorkspaceStatus };
  });
}

/** Major units with at most two decimals ("49", "49.5", "49.00") to minor units. */
export function parseMinorAmount(text: string, flag: string): number {
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`${flag} takes an amount with at most two decimals, such as 49.00`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
