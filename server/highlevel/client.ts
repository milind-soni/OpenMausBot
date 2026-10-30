// One function per HighLevel endpoint a bot may reach, with inputs typed and outputs trimmed to what a person cares
// about. The client itself cannot address a message, campaign, workflow or payment endpoint: that guard is here, not
// in the tool list, so no later tool can grow a path to them.
import { AsyncLocalStorage } from "node:async_hooks";
import { HIGHLEVEL_NOT_CONNECTED_TEXT, HIGHLEVEL_SIGNED_OUT_TEXT } from "./instructions.ts";
import { HighLevelRelayError, type RelayTokens } from "./relay.ts";
import { sameTokens, type HighLevelConnection, type HighLevelStore } from "./store.ts";

export const HIGHLEVEL_API_URL = "https://services.leadconnectorhq.com";
export const HIGHLEVEL_API_ENV = "OMB_HIGHLEVEL_API_URL";
export const HIGHLEVEL_VERSION = "2021-07-28";
export const HIGHLEVEL_CONVERSATIONS_VERSION = "2021-04-15";

/** Client-side budget under HighLevel's 100 requests / 10 s per location. */
export const BUDGET_CALLS = 90;
export const BUDGET_WINDOW_MS = 10_000;
const BACKOFF_MAX_MS = 10_000;
const REFRESH_MARGIN_MS = 60_000;
const MAX_SUCCESSORS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const CUSTOM_FIELDS_TTL_MS = 10 * 60_000;
const TEXT_MAX = 4_000;
export const PAGE_MAX = 50;
export const PAGE_NUMBER_MAX = 1_000;

/** Paths this client refuses outright, whatever tool asks: nothing here sends, campaigns, automates or charges. */
export const FORBIDDEN_PATHS = [
  /\/conversations\/messages/u,
  /\/conversations\/[^/]+\/messages\/[^/]+/u,
  /\/campaigns/u,
  /\/workflows?\//u,
  /\/workflows?$/u,
  /\/payments/u,
  /\/emails/u,
  /\/sms/u,
  /\/whatsapp/u,
  /\/invoices/u,
  /\/funnels/u,
  /\/forms/u,
  /\/surveys/u,
  /\/social-media-posting/u,
  /\/marketplace/u,
] as const;

export class HighLevelError extends Error {
  readonly status: number | undefined;
  /** The connection needs a new sign-in: the tool answer tells the bot to ask the person and end the turn. */
  readonly signedOut: boolean;
  constructor(message: string, options: { status?: number; signedOut?: boolean } = {}) {
    super(message);
    this.name = "HighLevelError";
    this.status = options.status;
    this.signedOut = options.signedOut === true;
  }
}

export interface HighLevelClientOptions {
  store: HighLevelStore;
  /** Refresh through the relay; null when no relay is configured (a Private Integration token never refreshes). */
  refresh: ((refreshToken: string) => Promise<RelayTokens>) | null;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | undefined>;
type Json = Record<string, unknown>;
interface RequestOptions {
  query?: Query; body?: unknown; version?: string;
  /** A POST HighLevel may receive twice with the same result (a search, adding tags). HighLevel takes no idempotency key. */
  repeatable?: boolean;
}

const repeatable = (method: string, options: RequestOptions): boolean => method !== "POST" || options.repeatable === true;

function unknownOutcome(path: string, cause: string, status: number): HighLevelError {
  return new HighLevelError(`${cause}, and the ${thing(path)} may have been saved anyway. Check before trying again, so it is not added twice.`, { status });
}

const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value.slice(0, TEXT_MAX) : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 200) : []);
/** Drops undefined fields so trimmed objects stay small. */
const compact = <T extends object>(record: T): T => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
const pageSize = (value: number | undefined) => Math.min(PAGE_MAX, Math.max(1, Math.floor(value ?? 20)));
const pageNumber = (value: number | undefined) => Math.min(PAGE_NUMBER_MAX, Math.max(1, Math.floor(value ?? 1)));

export interface CustomFieldDefinition { id: string; name: string; key?: string; dataType?: string; model?: string; options?: string[] }

export interface ContactFields {
  firstName?: string; lastName?: string; name?: string; email?: string; phone?: string; companyName?: string;
  tags?: string[]; source?: string; address1?: string; city?: string; state?: string; postalCode?: string; country?: string;
  website?: string; timezone?: string; assignedTo?: string; dateOfBirth?: string;
  /** By custom field name or key; the client maps names to ids. */
  customFields?: Record<string, unknown>;
}

export interface TrimmedContact {
  id: string; name?: string; firstName?: string; lastName?: string; email?: string; phone?: string; companyName?: string;
  tags: string[]; source?: string; assignedTo?: string; dateAdded?: string; dateUpdated?: string; website?: string; timezone?: string;
  dnd?: boolean; address?: { address1?: string; city?: string; state?: string; postalCode?: string; country?: string };
  customFields?: Record<string, unknown>;
}

function scopeFor(path: string, method: string): string {
  const read = method === "GET";
  if (path.startsWith("/contacts")) return read ? "contacts.readonly" : "contacts.write";
  if (path.startsWith("/opportunities")) return read ? "opportunities.readonly" : "opportunities.write";
  if (/^\/conversations\/[^/]+\/messages/u.test(path)) return "conversations/message.readonly";
  if (path.startsWith("/conversations")) return "conversations.readonly";
  if (path.startsWith("/calendars/events")) return "calendars/events.readonly";
  if (path.startsWith("/calendars")) return "calendars.readonly";
  if (/^\/locations\/[^/]+\/customFields/u.test(path)) return "locations/customFields.readonly";
  if (path.startsWith("/locations")) return "locations.readonly";
  return "the required";
}

/** What HighLevel's Private Integrations page calls each scope, so a person can find the box to tick. */
const PERMISSION_NAMES: Record<string, string> = {
  "contacts.readonly": "View Contacts", "contacts.write": "Edit Contacts",
  "opportunities.readonly": "View Opportunities", "opportunities.write": "Edit Opportunities",
  "conversations.readonly": "View Conversations", "conversations/message.readonly": "View Conversation Messages", "calendars.readonly": "View Calendars", "calendars/events.readonly": "View Calendar Events",
  "locations.readonly": "View Locations", "locations/customFields.readonly": "View Custom Fields",
};

function thing(path: string): string {
  if (/^\/contacts\/[^/]+\/notes/u.test(path)) return "note";
  if (/^\/contacts\/[^/]+\/tasks/u.test(path)) return "task";
  if (path.startsWith("/contacts")) return "contact";
  if (path.startsWith("/opportunities/pipelines")) return "pipeline";
  if (path.startsWith("/opportunities")) return "opportunity";
  if (path.startsWith("/conversations")) return "conversation";
  if (path.startsWith("/calendars")) return "calendar";
  if (path.startsWith("/locations")) return "location";
  return "record";
}

/** HighLevel's error bodies carry `message` as a string or a list of validation strings. */
function rawApiMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const message = body.message ?? body.error;
  if (typeof message === "string") return message || undefined;
  if (Array.isArray(message)) return message.filter((item) => typeof item === "string").join("; ") || undefined;
  return undefined;
}

const SECRET_SHAPES = [/\bBearer\s+[\w.~+/=-]{8,}/giu, /\bpit-[\w-]{4,}/gu, /\beyJ[\w-]{6,}(?:\.[\w-]*)*/gu] as const;

/** Removes the given secrets and anything shaped like a token (Bearer values, pit- tokens, JWTs). */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}

/** HighLevel's own explanation, safe to show a person or a bot: secrets redacted, one line, cut short. */
export function apiMessage(body: unknown, options: { secrets?: readonly string[]; max?: number } = {}): string | undefined {
  const raw = rawApiMessage(body);
  if (!raw) return undefined;
  const max = options.max ?? 300;
  const text = redactSecrets(raw, options.secrets).replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** HighLevel answers 401 both for a dead token ("Invalid JWT") and for a live one that lacks a scope
 * ("The token is not authorized for this scope."). Only the second says "scope"; it is a missing permission, not a sign-out. */
const SCOPE_REFUSAL = /not authori[sz]ed for (?:this|the) scope|insufficient[_ ]scope/iu;

export function isScopeRefusal(body: unknown): boolean {
  const raw = rawApiMessage(body);
  return raw !== undefined && SCOPE_REFUSAL.test(raw);
}

export function plainError(status: number, method: string, path: string, body: unknown): HighLevelError {
  const detail = apiMessage(body);
  if (status === 401 && isScopeRefusal(body)) {
    const scope = scopeFor(path, method);
    const name = PERMISSION_NAMES[scope];
    const permission = name ? `${name} permission (${scope})` : `${scope} permission`;
    return new HighLevelError(`HighLevel refused this (401): the connection lacks the ${permission}.${detail ? ` HighLevel said: ${detail}` : ""}`, { status });
  }
  if (status === 401) return new HighLevelError(HIGHLEVEL_SIGNED_OUT_TEXT, { status, signedOut: true });
  if (status === 403) return new HighLevelError(`HighLevel refused this (403): the connection lacks the ${scopeFor(path, method)} permission.${detail ? ` HighLevel said: ${detail}` : ""}`, { status });
  if (status === 404) return new HighLevelError(`HighLevel has no ${thing(path)} with that id (404).`, { status });
  if (status === 429) return new HighLevelError("HighLevel is rate-limiting; try again in a few seconds.", { status });
  if (status >= 500) return new HighLevelError(`HighLevel is having trouble (${status}); try again in a minute.`, { status });
  return new HighLevelError(`HighLevel rejected this (${status})${detail ? `: ${detail}` : "."}`, { status });
}

function waitFromHeaders(headers: Headers, now: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(BACKOFF_MAX_MS, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(BACKOFF_MAX_MS, Math.max(0, at - now));
  }
  const interval = Number(headers.get("x-ratelimit-interval-milliseconds"));
  if (Number.isFinite(interval) && interval > 0) return Math.min(BACKOFF_MAX_MS, interval);
  return 2_000;
}

/** The body as UTF-8 text, or null once it passes `max` bytes; reading stops there. */
async function textUpTo(response: Response, max: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(Buffer.concat(chunks));
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

export function assertAllowedPath(method: string, path: string): void {
  if (!path.startsWith("/") || path.includes("..") || path.includes("?") || path.includes("#")) throw new HighLevelError("HighLevel request path is not valid.");
  if (FORBIDDEN_PATHS.some((pattern) => pattern.test(path))) throw new HighLevelError("OpenMausBot never sends messages, runs campaigns or workflows, or moves money through HighLevel.");
  if (path.startsWith("/conversations") && method !== "GET") throw new HighLevelError("OpenMausBot reads conversations only; it never writes to them.");
  if (path.startsWith("/calendars") && method !== "GET") throw new HighLevelError("OpenMausBot reads calendars only; it never books or changes events.");
  if (path.startsWith("/locations") && method !== "GET") throw new HighLevelError("OpenMausBot never changes the location's settings.");
  if (method === "DELETE" && !/^\/contacts\/[^/]+\/tags$/u.test(path)) throw new HighLevelError("OpenMausBot never deletes HighLevel records.");
}

export class HighLevelClient {
  private readonly store: HighLevelStore;
  private readonly refreshViaRelay: HighLevelClientOptions["refresh"];
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly activeCall = new AsyncLocalStorage<() => void>();
  private readonly budget = new Map<string, number[]>();
  private refreshing: { from: HighLevelConnection; promise: Promise<HighLevelConnection | null> } | null = null;
  /** `refused` holds a missing-permission answer so contact reads do not re-ask HighLevel on every call. */
  private customFieldCache: { locationId: string; at: number; fields: CustomFieldDefinition[]; refused?: HighLevelError } | null = null;

  constructor(options: HighLevelClientOptions) {
    this.store = options.store;
    this.refreshViaRelay = options.refresh;
    this.apiUrl = (options.apiUrl ?? process.env[HIGHLEVEL_API_ENV] ?? HIGHLEVEL_API_URL).replace(/\/+$/u, "");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  withActiveCall<T>(assertActive: () => void, run: () => Promise<T>): Promise<T> {
    return this.activeCall.run(assertActive, run);
  }

  private async wait(ms: number): Promise<void> {
    await this.sleep(ms);
    this.activeCall.getStore()?.();
  }

  /** The connection, refreshed ahead of expiry; throws the signed-out error when a person must reconnect. */
  private async connection(): Promise<HighLevelConnection> {
    const current = this.store.get();
    if (!current) throw new HighLevelError(HIGHLEVEL_NOT_CONNECTED_TEXT, { signedOut: true });
    if (current.state === "needs-sign-in") throw new HighLevelError(HIGHLEVEL_SIGNED_OUT_TEXT, { signedOut: true });
    if (current.kind === "oauth" && current.expiresAt !== undefined && current.expiresAt - this.now() < REFRESH_MARGIN_MS) return (await this.refresh(current)) ?? this.successor(current);
    return current;
  }

  /** A connection the call can no longer use as it holds it: disconnected, signed out, reconnected or rotated since. */
  private replaced(connection: HighLevelConnection): boolean {
    const current = this.store.get();
    return !current || current.state !== "signed-in" || !sameTokens(current, connection);
  }

  /** What replaced `from` while a call used it: newer tokens for the same location carry the call on; another location ends it. */
  private successor(from: HighLevelConnection): HighLevelConnection {
    const current = this.store.get();
    if (!current) throw new HighLevelError(HIGHLEVEL_NOT_CONNECTED_TEXT, { signedOut: true });
    if (current.state === "needs-sign-in") throw new HighLevelError(HIGHLEVEL_SIGNED_OUT_TEXT, { signedOut: true });
    if (current.locationId !== from.locationId) throw new HighLevelError("The HighLevel connection changed to another location while this call ran; run it again.", { status: 409 });
    return current;
  }

  /** One refresh per token version: a burst of calls that all see an expired token shares the rotation. Null when the
   * connection was replaced meanwhile, so nothing was refreshed. */
  private refresh(current: HighLevelConnection): Promise<HighLevelConnection | null> {
    if (this.refreshing && sameTokens(this.refreshing.from, current)) return this.refreshing.promise;
    this.activeCall.getStore()?.();
    const promise = (async () => {
      if (current.kind !== "oauth" || !current.refreshToken) {
        this.store.markNeedsSignIn("The saved token was rejected by HighLevel.", current);
        throw new HighLevelError(HIGHLEVEL_SIGNED_OUT_TEXT, { status: 401, signedOut: true });
      }
      if (!this.refreshViaRelay) throw new HighLevelError("HighLevel's sign-in has expired and no OpenMausBot relay is configured to refresh it; ask the person to reconnect.", { signedOut: true });
      let tokens: RelayTokens;
      try {
        tokens = await this.refreshViaRelay(current.refreshToken);
      } catch (error) {
        if (this.replaced(current)) return null;
        if (error instanceof HighLevelRelayError && error.status === 401) {
          this.store.markNeedsSignIn("HighLevel rejected the saved sign-in (it was revoked or the app was uninstalled).", current);
          throw new HighLevelError(HIGHLEVEL_SIGNED_OUT_TEXT, { status: 401, signedOut: true });
        }
        throw new HighLevelError("HighLevel's sign-in could not be refreshed right now (the OpenMausBot relay did not answer); try again in a minute.", { status: 503 });
      }
      return this.store.rotate({
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
        expiresAt: this.now() + tokens.expiresIn * 1000, scopes: tokens.scope,
      }, current);
    })().finally(() => { if (this.refreshing?.promise === promise) this.refreshing = null; });
    this.refreshing = { from: current, promise };
    return promise;
  }

  private async spend(locationId: string): Promise<void> {
    const window = this.budget.get(locationId) ?? [];
    const now = this.now();
    const recent = window.filter((at) => now - at < BUDGET_WINDOW_MS);
    if (recent.length >= BUDGET_CALLS) {
      await this.wait(Math.max(1, recent[0]! + BUDGET_WINDOW_MS - now));
      return this.spend(locationId);
    }
    recent.push(now);
    this.budget.set(locationId, recent);
  }

  private async dispatch(connection: HighLevelConnection, method: string, path: string, options: RequestOptions): Promise<Response> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    await this.spend(connection.locationId);
    this.activeCall.getStore()?.();
    try {
      return await this.fetch(url, {
        method, redirect: "error",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          version: options.version ?? HIGHLEVEL_VERSION,
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw this.noAnswer(method, path, options);
    }
  }

  private noAnswer(method: string, path: string, options: RequestOptions): HighLevelError {
    if (!repeatable(method, options)) return unknownOutcome(path, "HighLevel did not answer (the request timed out or the network failed)", 503);
    return new HighLevelError("HighLevel did not answer (the request timed out or the network failed); try again in a minute.", { status: 503 });
  }

  private async body(response: Response, method: string, path: string, options: RequestOptions): Promise<unknown> {
    let text: string | null;
    try {
      text = await textUpTo(response, MAX_RESPONSE_BYTES);
    } catch {
      throw this.noAnswer(method, path, options);
    }
    if (text === null) throw new HighLevelError("HighLevel's answer was too large to read; narrow the request.", { status: response.status });
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  /** A create is never replayed after a 5xx: HighLevel may have saved it before failing. */
  async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, options: RequestOptions = {}): Promise<unknown> {
    assertAllowedPath(method, path);
    let connection = await this.connection();
    let refreshed = false;
    let waited = false;
    let retried5xx = false;
    let successors = 0;
    const successor = (from: HighLevelConnection) => {
      const next = this.successor(from);
      if (++successors > MAX_SUCCESSORS) throw new HighLevelError("HighLevel's sign-in kept changing while this call ran; try again in a minute.", { status: 503 });
      return next;
    };
    for (;;) {
      const response = await this.dispatch(connection, method, path, options);
      if (response.ok) return this.body(response, method, path, options);
      if (response.status >= 500 && !repeatable(method, options)) {
        await response.body?.cancel().catch(() => {});
        throw unknownOutcome(path, `HighLevel had trouble (${response.status})`, response.status);
      }
      if (response.status >= 500 && !retried5xx) {
        await response.body?.cancel().catch(() => {});
        retried5xx = true;
        await this.wait(1_000);
        continue;
      }
      const body = await this.body(response, method, path, options);
      // A live token that lacks one scope: name the permission; refreshing would not add it and the token still works.
      if (response.status === 401 && isScopeRefusal(body)) throw plainError(response.status, method, path, body);
      if (response.status === 401 && this.replaced(connection)) {
        connection = successor(connection);
        continue;
      }
      if (response.status === 401 && !refreshed) {
        if (connection.kind === "token") {
          this.store.markNeedsSignIn("HighLevel rejected the Private Integration token.", connection);
          throw new HighLevelError(HIGHLEVEL_SIGNED_OUT_TEXT, { status: 401, signedOut: true });
        }
        const rotated = await this.refresh(connection);
        refreshed = rotated !== null;
        connection = rotated ?? successor(connection);
        continue;
      }
      if (response.status === 429 && !waited) {
        waited = true;
        await this.wait(waitFromHeaders(response.headers, this.now()));
        continue;
      }
      if (response.status === 401) {
        this.store.markNeedsSignIn("HighLevel rejected the refreshed sign-in.", connection);
      }
      throw plainError(response.status, method, path, body);
    }
  }

  private async locationId(): Promise<string> {
    return (await this.connection()).locationId;
  }

  // ---- custom fields ------------------------------------------------------------------------------------------------

  async customFieldDefinitions(): Promise<CustomFieldDefinition[]> {
    const locationId = await this.locationId();
    const cached = this.customFieldCache;
    if (cached && cached.locationId === locationId && this.now() - cached.at < CUSTOM_FIELDS_TTL_MS) {
      if (cached.refused) throw cached.refused;
      return cached.fields;
    }
    let raw: unknown;
    try {
      raw = await this.request("GET", `/locations/${encodeURIComponent(locationId)}/customFields`);
    } catch (error) {
      // Optional for reads (fields then show by id): a token without View Custom Fields keeps working and stays signed in.
      if (error instanceof HighLevelError && !error.signedOut && (error.status === 401 || error.status === 403)) {
        this.customFieldCache = { locationId, at: this.now(), fields: [], refused: error };
      }
      throw error;
    }
    const fields = list(isRecord(raw) ? raw.customFields : []).flatMap((field) => {
      const id = str(field.id);
      const name = str(field.name);
      if (!id || !name) return [];
      const options = strings(field.picklistOptions);
      return [compact<CustomFieldDefinition>({ id, name, key: str(field.fieldKey), dataType: str(field.dataType), model: str(field.model), ...(options.length ? { options } : {}) })];
    });
    this.customFieldCache = { locationId, at: this.now(), fields };
    return fields;
  }

  private async customFieldsByName(values: Record<string, unknown> | undefined): Promise<Array<{ id: string; field_value: unknown }> | undefined> {
    if (!values || Object.keys(values).length === 0) return undefined;
    const definitions = await this.customFieldDefinitions();
    const out: Array<{ id: string; field_value: unknown }> = [];
    for (const [name, value] of Object.entries(values)) {
      const wanted = name.trim().toLowerCase();
      const match = definitions.find((field) => field.id === name || field.name.toLowerCase() === wanted || field.key?.toLowerCase() === wanted || field.key?.toLowerCase() === `contact.${wanted}`);
      if (!match) throw new HighLevelError(`HighLevel has no custom field named "${name.slice(0, 80)}". HIGHLEVEL_GET_LOCATION lists the custom fields.`, { status: 400 });
      out.push({ id: match.id, field_value: value });
    }
    return out;
  }

  private namedCustomFields(raw: unknown, definitions: CustomFieldDefinition[]): Record<string, unknown> | undefined {
    const entries = list(raw).flatMap((field) => {
      const id = str(field.id);
      if (!id) return [];
      const value = field.value ?? field.fieldValue ?? field.field_value;
      if (value === undefined || value === null || value === "") return [];
      const definition = definitions.find((candidate) => candidate.id === id);
      return [[definition?.name ?? id, typeof value === "string" ? value.slice(0, TEXT_MAX) : value] as const];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  // ---- contacts -------------------------------------------------------------------------------------------------------

  private trimContact(raw: Json, definitions: CustomFieldDefinition[]): TrimmedContact {
    const address = compact({ address1: str(raw.address1), city: str(raw.city), state: str(raw.state), postalCode: str(raw.postalCode), country: str(raw.country) });
    return compact<TrimmedContact>({
      id: String(raw.id ?? ""), name: str(raw.name) ?? str(raw.contactName), firstName: str(raw.firstName), lastName: str(raw.lastName),
      email: str(raw.email), phone: str(raw.phone), companyName: str(raw.companyName), tags: strings(raw.tags), source: str(raw.source),
      assignedTo: str(raw.assignedTo), dateAdded: str(raw.dateAdded), dateUpdated: str(raw.dateUpdated), website: str(raw.website),
      timezone: str(raw.timezone), dnd: bool(raw.dnd), ...(Object.keys(address).length ? { address } : {}),
      customFields: this.namedCustomFields(raw.customFields, definitions),
    });
  }

  private async contactBody(fields: ContactFields): Promise<Json> {
    const { customFields, ...plain } = fields;
    const mapped = await this.customFieldsByName(customFields);
    return compact({ ...plain, ...(mapped ? { customFields: mapped } : {}) });
  }

  async searchContacts(input: { query?: string; tag?: string; email?: string; phone?: string; page?: number; limit?: number }): Promise<{ contacts: TrimmedContact[]; total?: number; page: number }> {
    const locationId = await this.locationId();
    const filters: Json[] = [];
    if (input.email) filters.push({ field: "email", operator: "eq", value: input.email });
    if (input.phone) filters.push({ field: "phone", operator: "eq", value: input.phone });
    if (input.tag) filters.push({ field: "tags", operator: "eq", value: input.tag });
    const current = pageNumber(input.page);
    const raw = await this.request("POST", "/contacts/search", { repeatable: true, body: compact({
      locationId, page: current, pageLimit: pageSize(input.limit), query: input.query?.trim() || undefined, ...(filters.length ? { filters } : {}),
    }) });
    const definitions = await this.customFieldDefinitions().catch(() => []);
    const record = isRecord(raw) ? raw : {};
    return compact({ contacts: list(record.contacts).map((contact) => this.trimContact(contact, definitions)), total: num(record.total) ?? num(record.count), page: current });
  }

  async getContact(contactId: string): Promise<TrimmedContact> {
    const raw = await this.request("GET", `/contacts/${encodeURIComponent(contactId)}`);
    const contact = isRecord(raw) && isRecord(raw.contact) ? raw.contact : {};
    return this.trimContact(contact, await this.customFieldDefinitions().catch(() => []));
  }

  async createContact(fields: ContactFields): Promise<TrimmedContact> {
    const locationId = await this.locationId();
    const raw = await this.request("POST", "/contacts/", { body: { ...(await this.contactBody(fields)), locationId } });
    const contact = isRecord(raw) && isRecord(raw.contact) ? raw.contact : {};
    return this.trimContact(contact, await this.customFieldDefinitions().catch(() => []));
  }

  async updateContact(contactId: string, fields: ContactFields): Promise<TrimmedContact> {
    const raw = await this.request("PUT", `/contacts/${encodeURIComponent(contactId)}`, { body: await this.contactBody(fields) });
    const contact = isRecord(raw) && isRecord(raw.contact) ? raw.contact : { id: contactId };
    return this.trimContact(contact, await this.customFieldDefinitions().catch(() => []));
  }

  async addTags(contactId: string, tags: string[]): Promise<{ contactId: string; tags: string[] }> {
    const raw = await this.request("POST", `/contacts/${encodeURIComponent(contactId)}/tags`, { repeatable: true, body: { tags } });
    return { contactId, tags: strings(isRecord(raw) ? raw.tags : []) };
  }

  async removeTags(contactId: string, tags: string[]): Promise<{ contactId: string; tags: string[] }> {
    const raw = await this.request("DELETE", `/contacts/${encodeURIComponent(contactId)}/tags`, { body: { tags } });
    return { contactId, tags: strings(isRecord(raw) ? raw.tags : []) };
  }

  private trimNote(raw: Json) {
    return compact({ id: String(raw.id ?? ""), body: str(raw.body), title: str(raw.title), dateAdded: str(raw.dateAdded), userId: str(raw.userId), pinned: bool(raw.pinned) });
  }

  async listNotes(contactId: string) {
    const raw = await this.request("GET", `/contacts/${encodeURIComponent(contactId)}/notes`);
    return { contactId, notes: list(isRecord(raw) ? raw.notes : []).map((note) => this.trimNote(note)) };
  }

  async addNote(contactId: string, body: string) {
    const raw = await this.request("POST", `/contacts/${encodeURIComponent(contactId)}/notes`, { body: { body } });
    return { contactId, note: this.trimNote(isRecord(raw) && isRecord(raw.note) ? raw.note : {}) };
  }

  private trimTask(raw: Json) {
    return compact({ id: String(raw.id ?? ""), title: str(raw.title), body: str(raw.body), dueDate: str(raw.dueDate), completed: bool(raw.completed), assignedTo: str(raw.assignedTo) });
  }

  async listTasks(contactId: string) {
    const raw = await this.request("GET", `/contacts/${encodeURIComponent(contactId)}/tasks`);
    return { contactId, tasks: list(isRecord(raw) ? raw.tasks : []).map((task) => this.trimTask(task)) };
  }

  async addTask(contactId: string, input: { title: string; dueDate: string; body?: string; assignedTo?: string }) {
    const raw = await this.request("POST", `/contacts/${encodeURIComponent(contactId)}/tasks`, {
      body: compact({ title: input.title, dueDate: input.dueDate, body: input.body, assignedTo: input.assignedTo, completed: false }),
    });
    return { contactId, task: this.trimTask(isRecord(raw) && isRecord(raw.task) ? raw.task : {}) };
  }

  // ---- pipelines and opportunities -------------------------------------------------------------------------------------

  async listPipelines() {
    const locationId = await this.locationId();
    const raw = await this.request("GET", "/opportunities/pipelines", { query: { locationId } });
    return {
      pipelines: list(isRecord(raw) ? raw.pipelines : []).map((pipeline) => compact({
        id: String(pipeline.id ?? ""), name: str(pipeline.name),
        stages: list(pipeline.stages).map((stage) => compact({ id: String(stage.id ?? ""), name: str(stage.name), position: num(stage.position) })),
      })),
    };
  }

  private trimOpportunity(raw: Json) {
    const contact = isRecord(raw.contact) ? raw.contact : null;
    return compact({
      id: String(raw.id ?? ""), name: str(raw.name), status: str(raw.status), monetaryValue: num(raw.monetaryValue),
      pipelineId: str(raw.pipelineId), pipelineStageId: str(raw.pipelineStageId), contactId: str(raw.contactId),
      contact: contact ? compact({ id: str(contact.id), name: str(contact.name), email: str(contact.email), phone: str(contact.phone), companyName: str(contact.companyName) }) : undefined,
      assignedTo: str(raw.assignedTo), source: str(raw.source), createdAt: str(raw.createdAt), updatedAt: str(raw.updatedAt),
      lastStageChangeAt: str(raw.lastStageChangeAt), lastStatusChangeAt: str(raw.lastStatusChangeAt),
    });
  }

  async searchOpportunities(input: { query?: string; pipelineId?: string; stageId?: string; contactId?: string; status?: string; page?: number; limit?: number }) {
    const locationId = await this.locationId();
    const current = pageNumber(input.page);
    const raw = await this.request("GET", "/opportunities/search", { query: {
      location_id: locationId, q: input.query?.trim() || undefined, pipeline_id: input.pipelineId, pipeline_stage_id: input.stageId,
      contact_id: input.contactId, status: input.status, page: current, limit: pageSize(input.limit),
    } });
    const record = isRecord(raw) ? raw : {};
    const meta = isRecord(record.meta) ? record.meta : {};
    return compact({ opportunities: list(record.opportunities).map((item) => this.trimOpportunity(item)), total: num(meta.total) ?? num(record.total), page: current });
  }

  async getOpportunity(id: string) {
    const raw = await this.request("GET", `/opportunities/${encodeURIComponent(id)}`);
    return this.trimOpportunity(isRecord(raw) && isRecord(raw.opportunity) ? raw.opportunity : {});
  }

  async createOpportunity(input: { pipelineId: string; stageId?: string; contactId: string; name: string; value?: number; status?: string }) {
    const locationId = await this.locationId();
    const raw = await this.request("POST", "/opportunities/", { body: compact({
      pipelineId: input.pipelineId, locationId, name: input.name, pipelineStageId: input.stageId, status: input.status ?? "open",
      contactId: input.contactId, monetaryValue: input.value,
    }) });
    return this.trimOpportunity(isRecord(raw) && isRecord(raw.opportunity) ? raw.opportunity : {});
  }

  async updateOpportunity(id: string, input: { stageId?: string; status?: string; value?: number; name?: string; pipelineId?: string }) {
    const raw = await this.request("PUT", `/opportunities/${encodeURIComponent(id)}`, { body: compact({
      pipelineStageId: input.stageId, status: input.status, monetaryValue: input.value, name: input.name, pipelineId: input.pipelineId,
    }) });
    return this.trimOpportunity(isRecord(raw) && isRecord(raw.opportunity) ? raw.opportunity : { id });
  }

  // ---- conversations (read only) -----------------------------------------------------------------------------------------

  async searchConversations(input: { contactId?: string; query?: string; limit?: number }) {
    const locationId = await this.locationId();
    const raw = await this.request("GET", "/conversations/search", {
      version: HIGHLEVEL_CONVERSATIONS_VERSION,
      query: { locationId, contactId: input.contactId, query: input.query?.trim() || undefined, limit: pageSize(input.limit) },
    });
    const record = isRecord(raw) ? raw : {};
    return compact({
      conversations: list(record.conversations).map((item) => compact({
        id: String(item.id ?? ""), contactId: str(item.contactId), contactName: str(item.fullName) ?? str(item.contactName), email: str(item.email), phone: str(item.phone),
        type: str(item.type), lastMessageBody: str(item.lastMessageBody), lastMessageType: str(item.lastMessageType),
        lastMessageDate: str(item.lastMessageDate) ?? (num(item.lastMessageDate) !== undefined ? new Date(item.lastMessageDate as number).toISOString() : undefined),
        unreadCount: num(item.unreadCount), assignedTo: str(item.assignedTo),
      })),
      total: num(record.total),
    });
  }

  async readConversation(conversationId: string, input: { limit?: number; lastMessageId?: string } = {}) {
    const raw = await this.request("GET", `/conversations/${encodeURIComponent(conversationId)}/messages`, {
      version: HIGHLEVEL_CONVERSATIONS_VERSION, query: { limit: pageSize(input.limit), lastMessageId: input.lastMessageId },
    });
    // Documented as { lastMessageId, nextPage, messages }; served as { messages: { lastMessageId, nextPage, messages } }.
    const record = isRecord(raw) ? raw : {};
    const pageRecord = isRecord(record.messages) ? record.messages : record;
    return compact({
      conversationId,
      messages: list(pageRecord.messages).map((message) => compact({
        id: String(message.id ?? ""), type: str(message.messageType) ?? (num(message.type) !== undefined ? String(message.type) : undefined),
        direction: str(message.direction), status: str(message.status), dateAdded: str(message.dateAdded), body: str(message.body),
        contentType: str(message.contentType), attachments: Array.isArray(message.attachments) ? message.attachments.length : undefined,
      })),
      nextPage: bool(pageRecord.nextPage), lastMessageId: str(pageRecord.lastMessageId),
    });
  }

  // ---- calendars (read only) ----------------------------------------------------------------------------------------------

  async listCalendars() {
    const locationId = await this.locationId();
    const raw = await this.request("GET", "/calendars/", { query: { locationId } });
    return {
      calendars: list(isRecord(raw) ? raw.calendars : []).map((calendar) => compact({
        id: String(calendar.id ?? ""), name: str(calendar.name), description: str(calendar.description), isActive: bool(calendar.isActive),
        calendarType: str(calendar.calendarType), slotDuration: num(calendar.slotDuration), slotDurationUnit: str(calendar.slotDurationUnit),
        teamMembers: Array.isArray(calendar.teamMembers) ? calendar.teamMembers.length : undefined,
      })),
    };
  }

  async listEvents(input: { startTime: string; endTime: string; calendarId?: string; userId?: string }) {
    const locationId = await this.locationId();
    const ms = (value: string, name: string) => {
      const parsed = /^\d{10,}$/u.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
      if (!Number.isFinite(parsed)) throw new HighLevelError(`${name} must be an ISO 8601 date-time.`, { status: 400 });
      return parsed;
    };
    const raw = await this.request("GET", "/calendars/events", { query: {
      locationId, calendarId: input.calendarId, userId: input.userId, startTime: ms(input.startTime, "startTime"), endTime: ms(input.endTime, "endTime"),
    } });
    return {
      events: list(isRecord(raw) ? raw.events : []).map((event) => compact({
        id: String(event.id ?? ""), title: str(event.title), calendarId: str(event.calendarId), contactId: str(event.contactId),
        appointmentStatus: str(event.appointmentStatus), startTime: str(event.startTime), endTime: str(event.endTime),
        assignedUserId: str(event.assignedUserId), address: str(event.address), notes: str(event.notes),
      })),
    };
  }

  // ---- location --------------------------------------------------------------------------------------------------------------

  async getLocation() {
    const locationId = await this.locationId();
    const raw = await this.request("GET", `/locations/${encodeURIComponent(locationId)}`);
    const location = isRecord(raw) && isRecord(raw.location) ? raw.location : {};
    const customFields = await this.customFieldDefinitions().catch(() => []);
    return compact({
      id: str(location.id) ?? locationId, name: str(location.name), timezone: str(location.timezone), email: str(location.email), phone: str(location.phone),
      website: str(location.website), address: str(location.address), city: str(location.city), state: str(location.state), country: str(location.country),
      postalCode: str(location.postalCode), customFields,
    });
  }
}

/** Why the token check failed, in words a person can act on. HighLevel's own short reason is kept; the token never is. */
export function tokenCheckError(status: number, body: unknown, token: string, path: string): HighLevelError {
  const detail = apiMessage(body, { secrets: [token], max: 160 });
  const said = detail ? ` HighLevel said: ${detail}` : "";
  if (status === 401 && isScopeRefusal(body)) {
    return new HighLevelError(
      "This token is missing the View Locations permission (401), which OpenMausBot needs to check it. In HighLevel, open Settings → Private Integrations, " +
      `edit this integration, turn on View Locations and save, then connect again: the token stays the same.${said}`, { status });
  }
  if (status === 401) {
    return new HighLevelError(
      "HighLevel did not accept this token (401). Check that it was copied whole and has not been rotated or deleted, " +
      `and that its Private Integration has the View Locations permission.${said}`, { status });
  }
  if (status === 403) {
    return new HighLevelError(
      "This token does not belong to that location (403): it was created in another sub-account or at the agency level. " +
      `Create the Private Integration inside the sub-account whose location ID you entered.${said}`, { status });
  }
  if (status === 404) {
    return new HighLevelError("HighLevel has no location with that ID (404). Copy the location ID from Settings → Business Profile in the sub-account where you created the token.", { status });
  }
  return plainError(status, "GET", path, detail ? { message: detail } : {});
}

/** A Private Integration token is checked against the location it was issued for before it is saved. */
export async function lookupLocation(
  input: { token: string; locationId: string; apiUrl?: string; fetch?: typeof fetch },
): Promise<{ id: string; name: string; companyId?: string; timezone?: string }> {
  const apiUrl = (input.apiUrl ?? process.env[HIGHLEVEL_API_ENV] ?? HIGHLEVEL_API_URL).replace(/\/+$/u, "");
  const path = `/locations/${encodeURIComponent(input.locationId)}`;
  assertAllowedPath("GET", path);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(`${apiUrl}${path}`, {
      method: "GET", redirect: "error", headers: { authorization: `Bearer ${input.token}`, version: HIGHLEVEL_VERSION, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HighLevelError("HighLevel did not answer; check the connection and try again.", { status: 503 });
  }
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw tokenCheckError(response.status, body, input.token, path);
  const location = isRecord(body) && isRecord(body.location) ? body.location : {};
  return compact({ id: str(location.id) ?? input.locationId, name: str(location.name) ?? input.locationId, companyId: str(location.companyId), timezone: str(location.timezone) });
}
