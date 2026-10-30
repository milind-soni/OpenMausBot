// A loopback stand-in for services.leadconnectorhq.com: canned records with the noise fields the real API adds,
// bearer checks against a set of live access tokens, and one-shot response overrides for 401/429/5xx paths.
import { createServer, type Server } from "node:http";

export interface FakeHighLevelCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeHighLevelOverride { status: number; headers?: Record<string, string>; body?: unknown }

export interface FakeHighLevel {
  url: string;
  locationId: string;
  calls: FakeHighLevelCall[];
  /** Access tokens the API accepts. */
  tokens: Set<string>;
  /** Shifted one per request before any routing. */
  overrides: FakeHighLevelOverride[];
  /** Standing answers for "METHOD /path", given only to an accepted token: a missing scope, not a dead token. */
  pathOverrides: Map<string, FakeHighLevelOverride>;
  close(): Promise<void>;
}

export const FAKE_LOCATION_ID = "loc_fixture_01";

const RAW_CONTACT = (id: string, extra: Record<string, unknown> = {}) => ({
  id, locationId: FAKE_LOCATION_ID, firstName: "Ada", lastName: "Lovelace", name: "Ada Lovelace", email: "ada@fixture.test",
  emailLowerCase: "ada@fixture.test", firstNameLowerCase: "ada", lastNameLowerCase: "lovelace", fullNameLowerCase: "ada lovelace",
  phone: "+15550001234", companyName: "Analytical Engines", tags: ["vip", "newsletter"], source: "web form", assignedTo: "user_1",
  dateAdded: "2026-01-02T03:04:05.000Z", dateUpdated: "2026-02-03T04:05:06.000Z", address1: "1 Engine Row", city: "London", country: "GB",
  dnd: false, dndSettings: { Email: { status: "inactive" } }, type: "lead", attributionSource: { url: "https://x.test", ip: "10.0.0.1", userAgent: "ua" },
  lastAttributionSource: {}, visitorId: "v1", customFields: [{ id: "cf_lead", value: "Referral" }, { id: "cf_budget", value: 1200 }],
  ...extra,
});

const RAW_OPPORTUNITY = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: "Website redesign", monetaryValue: 4500, pipelineId: "pipe_1", pipelineStageId: "stage_new", assignedTo: "user_1", status: "open",
  source: "referral", lastStatusChangeAt: "2026-03-01T00:00:00.000Z", lastStageChangeAt: "2026-03-02T00:00:00.000Z", indexVersion: 3,
  createdAt: "2026-02-28T00:00:00.000Z", updatedAt: "2026-03-02T00:00:00.000Z", contactId: "contact_1", locationId: FAKE_LOCATION_ID,
  contact: { id: "contact_1", name: "Ada Lovelace", companyName: "Analytical Engines", email: "ada@fixture.test", phone: "+15550001234", tags: ["vip"] },
  notes: [], tasks: [], calendarEvents: [], customFields: [], followers: [],
  ...extra,
});

export async function startFakeHighLevel(options: { locationId?: string } = {}): Promise<FakeHighLevel> {
  const locationId = options.locationId ?? FAKE_LOCATION_ID;
  const calls: FakeHighLevelCall[] = [];
  const tokens = new Set<string>();
  const overrides: FakeHighLevelOverride[] = [];
  const pathOverrides = new Map<string, FakeHighLevelOverride>();
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://fixture");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers[key] = value;
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const call: FakeHighLevelCall = { method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body };
    calls.push(call);
    const answer = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "x-ratelimit-remaining": "97", "x-ratelimit-daily-remaining": "199000", ...extra });
      res.end(JSON.stringify(payload));
    };
    const override = overrides.shift();
    if (override) return answer(override.status, override.body ?? { message: `fixture ${override.status}` }, override.headers);
    const bearer = /^Bearer (.+)$/u.exec(headers.authorization ?? "")?.[1];
    if (!bearer || !tokens.has(bearer)) return answer(401, { statusCode: 401, message: "Invalid JWT" });
    if (headers.version !== "2021-07-28" && headers.version !== "2021-04-15") return answer(400, { message: "Version header is missing" });
    const standing = pathOverrides.get(`${call.method} ${url.pathname}`);
    if (standing) return answer(standing.status, standing.body ?? { message: `fixture ${standing.status}` }, standing.headers);
    const { method } = call;
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/contacts/search") return answer(200, { contacts: [RAW_CONTACT("contact_1")], total: 1 });
    if (method === "POST" && path === "/contacts/") return answer(201, { contact: RAW_CONTACT("contact_new", { ...(body as Record<string, unknown>), id: "contact_new" }) });
    if ((m = /^\/contacts\/([^/]+)\/tags$/u.exec(path)) && (method === "POST" || method === "DELETE")) return answer(200, { tags: (body as { tags: string[] }).tags });
    if ((m = /^\/contacts\/([^/]+)\/notes$/u.exec(path)) && method === "GET") return answer(200, { notes: [{ id: "note_1", body: "Called back", userId: "user_1", dateAdded: "2026-03-03T00:00:00.000Z", contactId: m[1] }] });
    if ((m = /^\/contacts\/([^/]+)\/notes$/u.exec(path)) && method === "POST") return answer(201, { note: { id: "note_new", body: (body as { body: string }).body, userId: "user_1", dateAdded: "2026-03-04T00:00:00.000Z", contactId: m[1] } });
    if ((m = /^\/contacts\/([^/]+)\/tasks$/u.exec(path)) && method === "GET") return answer(200, { tasks: [{ id: "task_1", title: "Send quote", body: "", dueDate: "2026-03-10T09:00:00.000Z", completed: false, assignedTo: "user_1", contactId: m[1] }] });
    if ((m = /^\/contacts\/([^/]+)\/tasks$/u.exec(path)) && method === "POST") return answer(201, { task: { id: "task_new", ...(body as Record<string, unknown>), contactId: m[1] } });
    if ((m = /^\/contacts\/([^/]+)$/u.exec(path)) && method === "GET") {
      if (m[1] === "missing") return answer(404, { statusCode: 404, message: "Contact not found" });
      return answer(200, { contact: RAW_CONTACT(m[1]!) });
    }
    if ((m = /^\/contacts\/([^/]+)$/u.exec(path)) && method === "PUT") return answer(200, { succeded: true, contact: RAW_CONTACT(m[1]!, body as Record<string, unknown>) });
    if (method === "GET" && path === "/opportunities/pipelines") return answer(200, { pipelines: [{ id: "pipe_1", name: "Sales", showInFunnel: true, locationId, stages: [{ id: "stage_new", name: "New", position: 0 }, { id: "stage_won", name: "Won", position: 1 }] }] });
    if (method === "GET" && path === "/opportunities/search") return answer(200, { opportunities: [RAW_OPPORTUNITY("opp_1")], meta: { total: 1, currentPage: 1 }, aggregations: {} });
    if (method === "POST" && path === "/opportunities/") return answer(201, { opportunity: RAW_OPPORTUNITY("opp_new", body as Record<string, unknown>) });
    if ((m = /^\/opportunities\/([^/]+)$/u.exec(path)) && method === "GET") return answer(200, { opportunity: RAW_OPPORTUNITY(m[1]!) });
    if ((m = /^\/opportunities\/([^/]+)$/u.exec(path)) && method === "PUT") return answer(200, { opportunity: RAW_OPPORTUNITY(m[1]!, body as Record<string, unknown>) });
    if (method === "GET" && path === "/conversations/search") {
      return answer(200, { conversations: [{ id: "conv_1", contactId: "contact_1", locationId, lastMessageBody: "See you Tuesday", lastMessageType: "TYPE_SMS", lastMessageDate: 1772000000000, type: "TYPE_PHONE", unreadCount: 2, fullName: "Ada Lovelace", contactName: "Ada Lovelace", email: "ada@fixture.test", phone: "+15550001234" }], total: 1 });
    }
    if ((m = /^\/conversations\/([^/]+)\/messages$/u.exec(path)) && method === "GET") {
      return answer(200, { messages: { lastMessageId: "msg_2", nextPage: false, messages: [
        { id: "msg_2", type: 1, messageType: "TYPE_SMS", direction: "inbound", status: "delivered", dateAdded: "2026-03-05T10:00:00.000Z", body: "See you Tuesday", contentType: "text/plain", attachments: [], conversationId: m[1], locationId, contactId: "contact_1", conversationProviderId: "prov" },
        { id: "msg_1", type: 1, messageType: "TYPE_SMS", direction: "outbound", status: "delivered", dateAdded: "2026-03-05T09:00:00.000Z", body: "Can we meet?", contentType: "text/plain", attachments: [{ url: "x" }], conversationId: m[1], locationId, contactId: "contact_1" },
      ] } });
    }
    if (method === "POST" && path.startsWith("/conversations/messages")) return answer(500, { message: "FIXTURE: a message send reached the fake; the client guard failed" });
    if (method === "GET" && path === "/calendars/") return answer(200, { calendars: [{ id: "cal_1", name: "Consultations", description: "30 min", isActive: true, calendarType: "round_robin", slotDuration: 30, slotDurationUnit: "mins", teamMembers: [{ userId: "user_1" }], locationId, openHours: [] }] });
    if (method === "GET" && path === "/calendars/events") return answer(200, { events: [{ id: "evt_1", title: "Intro call", calendarId: "cal_1", locationId, contactId: "contact_1", appointmentStatus: "confirmed", startTime: "2026-03-10T15:00:00.000Z", endTime: "2026-03-10T15:30:00.000Z", assignedUserId: "user_1", address: "Zoom", notes: "bring deck", users: ["user_1"], dateAdded: "2026-03-01T00:00:00.000Z" }] });
    if ((m = /^\/locations\/([^/]+)\/customFields$/u.exec(path)) && method === "GET") {
      return answer(200, { customFields: [
        { id: "cf_lead", name: "Lead Source", fieldKey: "contact.lead_source", dataType: "TEXT", position: 0, locationId, model: "contact" },
        { id: "cf_budget", name: "Budget", fieldKey: "contact.budget", dataType: "NUMERICAL", position: 1, locationId, model: "contact" },
      ] });
    }
    if ((m = /^\/locations\/([^/]+)$/u.exec(path)) && method === "GET") {
      if (m[1] !== locationId) return answer(403, { statusCode: 403, message: "The token does not have access to this location." });
      return answer(200, { location: { id: locationId, companyId: "company_1", name: "Example Profiles", timezone: "America/Chicago", email: "hello@fixture.test", phone: "+15550009999", website: "https://fixture.test", address: "2 Main St", city: "Austin", state: "TX", country: "US", postalCode: "78701", settings: {}, social: {}, business: {} } });
    }
    return answer(404, { statusCode: 404, message: `fixture has no route for ${method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake HighLevel did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`, locationId, calls, tokens, overrides, pathOverrides,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export interface FakeRelay {
  url: string;
  calls: Array<{ path: string; body: unknown }>;
  refreshes: number;
  /** What `start` has handed out, with whether the person finished and whether the payload was collected. */
  states: Map<string, { completed: boolean; claimed: boolean }>;
  /** The refresh tokens the relay (HighLevel) still honours. */
  refreshTokens: Set<string>;
  /** Every access token the relay has issued, in order. */
  issued: string[];
  unavailable: boolean;
  /** Simulates HighLevel's callback for a state: the next claim gets tokens. */
  complete(state: string): void;
  close(): Promise<void>;
}

/** The control plane's HighLevel routes, per spec §9: start → claim once (404 before the callback, 410 after) → refresh. */
export async function startFakeRelay(options: { onAccessToken?(token: string): void; locationId?: string; expiresIn?: number } = {}): Promise<FakeRelay> {
  const states = new Map<string, { completed: boolean; claimed: boolean }>();
  const refreshTokens = new Set<string>();
  const issued: string[] = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  let counter = 0;
  const relay: FakeRelay = {
    url: "", calls, refreshes: 0, states, refreshTokens, issued, unavailable: false,
    complete(state) { const row = states.get(state); if (row) row.completed = true; },
    close: async () => {},
  };
  const tokenSet = () => {
    counter++;
    const accessToken = `hl_access_${counter}`;
    const refreshToken = `hl_refresh_${counter}`;
    refreshTokens.add(refreshToken);
    issued.push(accessToken);
    options.onAccessToken?.(accessToken);
    return { accessToken, refreshToken, expiresIn: options.expiresIn ?? 86_400, scope: "contacts.readonly contacts.write opportunities.readonly", locationId: options.locationId ?? FAKE_LOCATION_ID, companyId: "company_1", userId: "user_1" };
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    calls.push({ path, body });
    const answer = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    if (relay.unavailable) return answer(503, { error: "highlevel_unavailable" });
    if (req.method !== "POST") return answer(405, { error: "method_not_allowed" });
    if (path === "/v1/highlevel/start") {
      const state = `state_${++counter}_${Math.random().toString(36).slice(2, 10)}`;
      states.set(state, { completed: false, claimed: false });
      return answer(200, { state, authorizationUrl: `https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation?response_type=code&client_id=fixture&state=${state}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    if (path === "/v1/highlevel/claim") {
      const row = states.get(String((body as { state?: unknown }).state ?? ""));
      if (!row || !row.completed) return answer(404, { error: "highlevel_unknown_state" });
      if (row.claimed) return answer(410, { error: "highlevel_claimed" });
      row.claimed = true;
      return answer(200, tokenSet());
    }
    if (path === "/v1/highlevel/refresh") {
      relay.refreshes++;
      const token = String((body as { refreshToken?: unknown }).refreshToken ?? "");
      if (!refreshTokens.has(token)) return answer(401, { error: "highlevel_refresh_rejected" });
      refreshTokens.delete(token);
      return answer(200, tokenSet());
    }
    return answer(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake relay did not bind");
  relay.url = `http://127.0.0.1:${address.port}`;
  relay.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return relay;
}
