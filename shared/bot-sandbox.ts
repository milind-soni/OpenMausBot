// The bots' sandbox (server/bot-box) as a self-hosted server's admin sees it in Settings: GET /api/config `botSandbox`,
// sent only by a server in the published server image or one told OMB_BOT_BOX=required.

/**
 * `on`: every bot spawn runs in the sandbox. `off`: bots run beside the server, as its own user, able to read its
 * settings, keys and other bots' files. `refusing`: the sandbox is required here but could not start, so bots' commands
 * are refused until it can (never run unconfined).
 */
export type BotSandboxState = "on" | "off" | "refusing";

/** Why it is not on: `switched-off` (OMB_BOT_BOX=0, which the installer's --no-sandbox sets), `not-linux`, `no-bwrap`
 * (the image has no bubblewrap), `userns-refused` (the host or the container's settings do not let it make its
 * namespaces: the host was not prepared). */
export type BotSandboxReason = "switched-off" | "not-linux" | "no-bwrap" | "userns-refused" | "not-cloud";

export interface BotSandboxStatus {
  state: BotSandboxState;
  reason: BotSandboxReason | null;
  /** OMB_BOT_BOX=required: the installer's compose.box.yaml says the sandbox may never be skipped. */
  required: boolean;
  /** The sandbox's own self-check, a few seconds after start: null until it ran, or while the sandbox is not on. */
  checks: { passed: number; total: number; failed: string[] } | null;
}

/** The `botSandbox` field of GET /api/config: absent where the server shows no sandbox line. */
export function botSandboxField(status: BotSandboxStatus | null): { botSandbox?: BotSandboxStatus } {
  return status ? { botSandbox: status } : {};
}
