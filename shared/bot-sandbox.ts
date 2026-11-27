// The bots' sandbox (server/bot-box) as a self-hosted server's admin sees it in Settings: GET /api/config `botSandbox`,
// sent only by a server in the published server image or one told OMB_BOT_BOX=required.

/**
 * `on`: every bot spawn runs in the sandbox. `off`: bots run beside the server, as its own user, able to read its
 * settings and keys. `refusing`: the sandbox is required here but could not start, or its self-check failed a check
 * that must pass, so bots' commands are refused (never run unconfined).
 */
export type BotSandboxState = "on" | "off" | "refusing";

/** Why it is not on: `switched-off` (OMB_BOT_BOX=0, which the installer's --no-sandbox sets), `not-linux`, `no-bwrap`
 * (the image has no bubblewrap), `userns-refused` (the host or the container's settings do not let it make its
 * namespaces: the host was not prepared), `start-failed` (it was found but could not open its gates),
 * `self-check-failed` (it started, and its own self-check failed a check that must pass). */
export type BotSandboxReason = "switched-off" | "not-linux" | "no-bwrap" | "userns-refused" | "not-cloud" | "start-failed" | "self-check-failed";

export interface BotSandboxStatus {
  state: BotSandboxState;
  reason: BotSandboxReason | null;
  /** OMB_BOT_BOX=required: the installer's compose.box.yaml says the sandbox may never be skipped. */
  required: boolean;
  /** The sandbox's own self-check, a few seconds after start: null until it ran. `failed` holds every check that did not
   * pass; `warned` is the part of it that only warns (BOX_WARN_ONLY_CHECKS). */
  checks: { passed: number; total: number; failed: string[]; warned?: string[] } | null;
}

/**
 * Self-check lines that only warn: a failure is shown, and never stops an install or refuses a bot's command. The
 * installer keeps the same list (deploy/install.sh SANDBOX_WARN_ONLY; scripts/server-installer.test.ts checks they match).
 * `nested-userns-blocked`: bots can make user namespaces of their own inside the sandbox (docs/bot-box.md, Limits).
 */
export const BOX_WARN_ONLY_CHECKS: readonly string[] = ["keyring-denied", "hostname-private", "cpu-list-readable", "fly-api-hidden", "egress-public-allowed", "nested-userns-blocked"];

/** The failed checks that must pass. */
export function mustPassFailures(failed: readonly string[]): string[] {
  return failed.filter((id) => !BOX_WARN_ONLY_CHECKS.includes(id));
}

/** The `botSandbox` field of GET /api/config: absent where the server shows no sandbox line. */
export function botSandboxField(status: BotSandboxStatus | null): { botSandbox?: BotSandboxStatus } {
  return status ? { botSandbox: status } : {};
}
