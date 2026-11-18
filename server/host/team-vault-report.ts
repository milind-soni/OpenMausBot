// The team's Vault as its admins see it on the Admin's Apps page (`GET /api/cloud/team/admin` `vault`).
// Security invariant: names and states only; never a value, a token or a header, and never a member's own secret, which
// the caller leaves out by reading the Vault as the team (TEAM_READER).
import type { BitwardenStatus, LoginBots, OnePasswordStatus } from "../../shared/logins.ts";
import type { TeamVaultSummary } from "../cloud-team-admin.ts";
import { onePasswordFailure, type VaultProviderFailure } from "../onepassword.ts";
import { isTeamBot } from "./connection-health-host.ts";

const SECRETS_MAX = 500;
const BOTS_MAX = 200;

type ReportBot = { id: string; name: string; hidden?: boolean; movedTo?: unknown; defaultBot?: { person?: string } };

export function teamVaultReport(input: {
  secrets: ReadonlyArray<{ name: string; createdAt: number; bots: LoginBots }>;
  bots: readonly ReportBot[];
  onePassword: OnePasswordStatus;
  /** Absent where Bitwarden is not offered. */
  bitwarden?: { status: BitwardenStatus; failure?: VaultProviderFailure };
}): TeamVaultSummary {
  const team = input.bots.filter(isTeamBot);
  const usedBy = (bots: LoginBots) => team.filter((bot) => bots === "all" || bots.includes(bot.id)).map((bot) => bot.name).slice(0, BOTS_MAX);
  const { onePassword } = input;
  return {
    secrets: input.secrets.slice(0, SECRETS_MAX).map((secret) => ({ name: secret.name, addedAt: new Date(secret.createdAt).toISOString(), usedBy: usedBy(secret.bots) })),
    providers: [{
      kind: "1password", connected: onePassword.connected,
      label: onePassword.connected ? (onePassword.vaults ?? []).map((vault) => vault.title).join(", ") : "",
      ...(onePassword.connected && onePassword.error ? { lastError: onePasswordFailure(onePassword.error) } : {}),
    }, ...(input.bitwarden ? [{
      kind: "bitwarden" as const, connected: input.bitwarden.status.connected, label: input.bitwarden.status.connected ? input.bitwarden.status.server ?? "" : "",
      ...(input.bitwarden.status.connected && input.bitwarden.failure ? { lastError: input.bitwarden.failure } : {}),
    }] : [])],
  };
}
