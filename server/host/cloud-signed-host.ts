// A Cloud home's signed routes and the health report behind them (server/host/README.md): what the Admin reads with the
// bootstrap secret. Null on any server that is not a Cloud home. The bot box's report rides both the health report and
// its own route, `GET /api/cloud/box`.
import type { BoxReport } from "../bot-box/box.ts";
import { createCloudHealth, type CloudHealth, type CloudHealthDeps } from "../cloud-health.ts";
import type { CloudHomeConfig } from "../cloud-home.ts";
import type { CloudPower } from "../cloud-power.ts";
import { createCloudSignedRoutes } from "../routes/cloud-signed.ts";
import type { TeamAdminSummary } from "../cloud-team-admin.ts";
import type { SessionRegistry } from "../sessions.ts";

export interface CloudSignedHostDeps {
  cloudHome: CloudHomeConfig | null;
  health: Omit<CloudHealthDeps, "box">;
  sessions: Pick<SessionRegistry, "openPairing" | "attemptAllowed" | "noteFailure" | "clearFailures">;
  /** The home's power once the server listens (a late-bound singleton of index.ts). */
  power: () => Pick<CloudPower, "report" | "prepareSleep"> | null;
  box: () => BoxReport;
  /** A Team Cloud's shared connections and AI for its admins; used only when the home is a Team Cloud. */
  teamAdmin?: { summary(): Promise<TeamAdminSummary> };
  /** A Team Cloud's member left (the Admin's signed request): delete what was theirs alone. */
  memberLeft?: (email: string) => Promise<Record<string, unknown>>;
}

export function createCloudSignedHost(deps: CloudSignedHostDeps): { cloudHealth: CloudHealth | null; cloudSigned: ReturnType<typeof createCloudSignedRoutes> | null } {
  const cloudHealth = deps.cloudHome ? createCloudHealth({ ...deps.health, box: deps.box }) : null;
  const cloudSigned = deps.cloudHome && cloudHealth
    ? createCloudSignedRoutes({ secret: deps.cloudHome.bootstrapSecret, sessions: deps.sessions, team: deps.cloudHome.team, health: cloudHealth, power: deps.power, box: deps.box,
      ...(deps.cloudHome.team && deps.teamAdmin ? { teamAdmin: deps.teamAdmin } : {}),
      ...(deps.cloudHome.team && deps.memberLeft ? { memberLeft: deps.memberLeft } : {}) })
    : null;
  return { cloudHealth, cloudSigned };
}
