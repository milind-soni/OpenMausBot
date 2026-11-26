// A Cloud home's signed routes and the health report behind them (server/host/README.md): what the Admin reads with the
// bootstrap secret. Null on any server that is not a Cloud home. The bot box's report rides both the health report and
// its own route, `GET /api/cloud/box`.
import type { BoxReport } from "../bot-box/box.ts";
import { createCloudDiagnose } from "../cloud-diagnose.ts";
import { createCloudHealth, type CloudHealth, type CloudHealthDeps } from "../cloud-health.ts";
import { clockKicker, clockSources, createCloudClock, registerCloudClock, type CloudClock } from "../cloud-clock.ts";
import { CLOUD_PAIRING_SKEW_S, type CloudHomeConfig } from "../cloud-home.ts";
import type { CloudPower } from "../cloud-power.ts";
import { createStorageHistory } from "../perf/storage-history.ts";
import { createCloudSignedRoutes } from "../routes/cloud-signed.ts";
import type { TeamAdminSummary } from "../cloud-team-admin.ts";
import type { SessionRegistry } from "../sessions.ts";

export interface CloudSignedHostDeps {
  cloudHome: CloudHomeConfig | null;
  health: Omit<CloudHealthDeps, "box">;
  sessions: Pick<SessionRegistry, "openPairing" | "revokeMember" | "attemptAllowed" | "noteFailure" | "clearFailures">;
  /** The home's power once the server listens (a late-bound singleton of index.ts). */
  power: () => Pick<CloudPower, "report" | "prepareSleep"> | null;
  box: () => BoxReport;
  /** A Team Cloud's shared connections and AI for its admins; used only when the home is a Team Cloud. */
  teamAdmin?: { summary(): Promise<TeamAdminSummary> };
  /** A Team Cloud's pairing claim said who invited this member: kept for their welcome (team-welcome.ts). */
  invited?: (member: string, by: string) => void;
  /** The team's rule turned remote access off: no browser sign-in for a User. */
  memberBrowserOff?: () => boolean;
  /** A Team Cloud's member left (the Admin's signed request): delete what was theirs alone. */
  memberLeft?: (email: string) => Promise<Record<string, unknown>>;
  /** A Team Cloud's rules changed on the Admin (its signed nudge): fetch them now. */
  policyChanged?: () => void;
  /** The plan was cancelled, or renews again (the Admin's signed request): routines wait while it is cancelled. */
  plan?: (cancelled: boolean) => void;
  /** Which plan this Cloud is on now (the Admin's signed request). */
  planTier?: (tier: string) => void;
  /** Tests: the clock watch to use instead of the home's own (which measures over the network and is registered for wakes). */
  clock?: CloudClock;
}

export function createCloudSignedHost(deps: CloudSignedHostDeps): { cloudHealth: CloudHealth | null; cloudSigned: ReturnType<typeof createCloudSignedRoutes> | null } {
  // Each completed storage pass the health read sees is kept for the diagnose read's growth figures (perf/storage-history.ts).
  const history = deps.cloudHome ? createStorageHistory({ dataDir: deps.health.dataDir }) : null;
  const storage = deps.health.storage;
  const health = storage && history ? { ...deps.health, storage: () => { const report = storage(); try { history.note(report); } catch {} return report; } } : deps.health;
  const cloudHealth = deps.cloudHome ? createCloudHealth({ ...health, box: deps.box }) : null;
  const diagnose = cloudHealth ? createCloudDiagnose({ health: cloudHealth, storage: storage ?? (() => null), history, dataDir: deps.health.dataDir, ...(process.env.HOME ? { home: process.env.HOME } : {}) }) : null;
  // The home's clock against its Admin and two hosts of its own (server/cloud-clock.ts); wakes reach it through cloud-power.ts.
  const clock = deps.cloudHome ? deps.clock ?? createCloudClock({ origins: clockSources(deps.cloudHome.adminOrigin), kick: clockKicker(), log: (line) => console.warn(line), skewS: CLOUD_PAIRING_SKEW_S }) : null;
  if (clock && !deps.clock) registerCloudClock(clock);
  const cloudSigned = deps.cloudHome && cloudHealth
    ? createCloudSignedRoutes({ secret: deps.cloudHome.bootstrapSecret, sessions: deps.sessions, team: deps.cloudHome.team, health: cloudHealth, power: deps.power, box: deps.box, clock,
      ...(deps.cloudHome.team && deps.teamAdmin ? { teamAdmin: deps.teamAdmin } : {}), ...(deps.cloudHome.team && deps.invited ? { invited: deps.invited } : {}), ...(deps.cloudHome.team && deps.memberBrowserOff ? { memberBrowserOff: deps.memberBrowserOff } : {}),
      ...(deps.cloudHome.team && deps.memberLeft ? { memberLeft: deps.memberLeft } : {}), ...(deps.cloudHome.team && deps.policyChanged ? { policyChanged: deps.policyChanged } : {}), ...(deps.plan ? { plan: deps.plan } : {}), ...(deps.planTier ? { planTier: deps.planTier } : {}), diagnose })
    : null;
  return { cloudHealth, cloudSigned };
}
