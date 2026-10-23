// The Admin's signed requests to a Cloud home. They run before the session gate: the signature is the credential. Never
// log their headers, bodies or codes. A bad pairing signature counts against the pairing lockout; a health or power read
// opens nothing, so each route has its own nonces and never locks the Admin out of pairing. The power routes are the sleep
// handshake of a plan that sleeps (server/cloud-power.ts); the Admin calls them for no other plan.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoxReport } from "../bot-box/box.ts";
import { boxSummary } from "../cloud-health.ts";
import { CLOUD_HEALTH_PATH, CLOUD_PAIRING_PATH, createCloudPairing, createCloudRequestVerifier, readSignedBody } from "../cloud-home.ts";
import { teamMemberEmail, type CloudTeam } from "../cloud-team.ts";
import { CLOUD_TEAM_ADMIN_PATH, type TeamAdminSummary } from "../cloud-team-admin.ts";
import type { CloudHealth } from "../cloud-health.ts";
import { CLOUD_IDLE_ACTIVITY_MS, CLOUD_POWER_PATH, CLOUD_POWER_SLEEP_PATH, type CloudPower } from "../cloud-power.ts";
import { json } from "../harness/http.ts";
import { requestSource } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";

export interface CloudSignedRequest { req: IncomingMessage; res: ServerResponse; url: URL; path: string; method: string }

/** The bot box's self-report (server/bot-box): `{ box: "bwrap" | "off" | …, checks: "n/n" }`, read like health. */
export const CLOUD_BOX_PATH = "/api/cloud/box";

/** A Team Cloud's member left (removed, or they left): `{ email }`, signed with the body like the sleep request. What was
 * theirs alone is deleted here (host/team-member-left.ts). */
export const CLOUD_TEAM_MEMBER_LEFT_PATH = "/api/cloud/team/member-left";

export function createCloudSignedRoutes(deps: {
  secret: string;
  sessions: Pick<SessionRegistry, "openPairing" | "attemptAllowed" | "noteFailure" | "clearFailures">;
  /** A Team Cloud: every pairing body must carry the Admin's member claim (cloud-team.ts). */
  team?: CloudTeam | null;
  health: Pick<CloudHealth, "report">;
  /** The home's power once the server listens (null before, and on a server that is not a Cloud home). */
  power?: () => Pick<CloudPower, "report" | "prepareSleep"> | null;
  /** The bot box's report; absent on a server without one. */
  box?: () => BoxReport;
  /** A Team Cloud's shared connections and AI for its admins on the Admin; absent on a My Cloud. */
  teamAdmin?: { summary(): Promise<TeamAdminSummary> } | null;
  /** A Team Cloud's member left: delete what was theirs alone; absent on a My Cloud. */
  memberLeft?: ((email: string) => Promise<Record<string, unknown>>) | null;
  now?: () => number;
}) {
  const pairing = createCloudPairing({ secret: deps.secret, sessions: deps.sessions, team: deps.team ?? null, now: deps.now });
  const healthRequests = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const powerReads = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const sleepRequests = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const boxReads = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const teamAdminReads = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const memberLeftRequests = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  /** True when the request was one of these and has been answered. */
  return async ({ req, res, url, path, method }: CloudSignedRequest): Promise<boolean> => {
    const power = path === CLOUD_POWER_PATH || path === CLOUD_POWER_SLEEP_PATH ? deps.power?.() ?? null : null;
    const teamAdmin = path === CLOUD_TEAM_ADMIN_PATH && deps.team ? deps.teamAdmin ?? null : null;
    const memberLeft = path === CLOUD_TEAM_MEMBER_LEFT_PATH && deps.team ? deps.memberLeft ?? null : null;
    if (path !== CLOUD_PAIRING_PATH && path !== CLOUD_HEALTH_PATH && path !== CLOUD_BOX_PATH && !power && !teamAdmin && !memberLeft) return false;
    res.setHeader("cache-control", "no-store");
    const source = requestSource(req);
    const header = (name: string) => { const value = req.headers[name]; return typeof value === "string" ? value : undefined; };
    const signed = { timestamp: header("x-omb-cloud-timestamp"), nonce: header("x-omb-cloud-nonce"), signature: header("x-omb-cloud-signature") };
    if (power && path === CLOUD_POWER_PATH) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = powerReads.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) { console.warn(`cloud power read refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      const minutes = url.searchParams.get("idleMinutes");
      const window = minutes !== null && /^\d{1,4}$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 24 * 60 ? Number(minutes) * 60_000 : CLOUD_IDLE_ACTIVITY_MS;
      json(res, 200, power.report(window));
      return true;
    }
    if (power) {
      if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) { json(res, 415, { error: "send the sleep request as JSON (content-type: application/json)" }); return true; }
      const body = await readSignedBody(req);
      const verdict = sleepRequests.verify({ ...signed, method, target: `${path}${url.search}`, body });
      if (!verdict.ok) { console.warn(`cloud sleep request refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      let parsed: unknown;
      try { parsed = body.length ? JSON.parse(body.toString("utf8")) : {}; } catch { json(res, 400, { error: "invalid_body" }); return true; }
      const minutes = (parsed as { idleMinutes?: unknown } | null)?.idleMinutes;
      if (minutes !== undefined && !(Number.isInteger(minutes) && (minutes as number) >= 1 && (minutes as number) <= 24 * 60)) { json(res, 400, { error: "invalid_idle_minutes" }); return true; }
      const answer = power.prepareSleep(minutes === undefined ? CLOUD_IDLE_ACTIVITY_MS : (minutes as number) * 60_000);
      json(res, answer.ok ? 200 : 409, answer);
      return true;
    }
    if (teamAdmin) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = teamAdminReads.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) { console.warn(`team admin read refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      json(res, 200, await teamAdmin.summary());
      return true;
    }
    if (memberLeft) {
      if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) { json(res, 415, { error: "send the request as JSON (content-type: application/json)" }); return true; }
      const body = await readSignedBody(req);
      const verdict = memberLeftRequests.verify({ ...signed, method, target: `${path}${url.search}`, body });
      if (!verdict.ok) { console.warn(`team member-left request refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { json(res, 400, { error: "invalid_body" }); return true; }
      const email = teamMemberEmail((parsed as { email?: unknown } | null)?.email);
      if (!email) { json(res, 400, { error: "invalid_member" }); return true; }
      json(res, 200, { ok: true, ...(await memberLeft(email)) });
      return true;
    }
    if (path === CLOUD_BOX_PATH) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = boxReads.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) { console.warn(`bot box report read refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      json(res, 200, { v: 1, at: (deps.now ?? Date.now)(), ...(boxSummary(deps.box?.()) ?? { box: "off", reason: "not-cloud", checks: null, failed: [], boxed: 0, refused: { egress: 0, harness: 0 }, broker: { on: false, tokens: 0, forwarded: 0, refused: 0, unbrokered: [] }, hardening: { seccomp: "off", denied: 0, hidepid: false, flyApiPrivate: true } }) });
      return true;
    }
    if (path === CLOUD_HEALTH_PATH) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = healthRequests.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) {
        console.warn(`cloud health refused from ${source}: ${verdict.error}`);
        json(res, verdict.status, { error: verdict.error });
        return true;
      }
      json(res, 200, deps.health.report(url.searchParams.get("after")));
      return true;
    }
    if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      json(res, 415, { error: "send the pairing request as JSON (content-type: application/json)" });
      return true;
    }
    const result = pairing.handle({ ...signed, body: await readSignedBody(req), source });
    if (result.status !== 200) console.warn(`cloud pairing refused from ${source}: ${String(result.body.error)}`);
    json(res, result.status, result.body);
    return true;
  };
}
