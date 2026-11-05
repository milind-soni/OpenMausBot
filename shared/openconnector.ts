// OpenConnector (openconnector.dev), the self-hosted app catalog, as a first-class Apps card. It manages one
// `openconnector` MCP server entry (plus, optionally, the local process serving it) so the MCP gate, each bot's
// server selection and a Team Cloud's scopes treat it like any other server.

/** The MCP server name bots see the OpenConnector tools under. */
export const OPENCONNECTOR_SERVER = "openconnector";

/** Where a single-file OpenConnector listens by default (its `--port` flag changes it). */
export const OPENCONNECTOR_DEFAULT_URL = "http://127.0.0.1:3000/mcp";

/** What runs the local process when the person asks OpenMausBot to manage it; resolved on PATH, never a fixed path. */
export const OPENCONNECTOR_DEFAULT_COMMAND = "openconnector";

/** GET /api/openconnector. Never a secret. */
export interface OpenConnectorStatus {
  /** `taken`: an MCP server named openconnector that this card did not set up; `blocked`: the organization's policy
   * refuses it; `error`: the managed process kept failing its health check. */
  state: "not-connected" | "connecting" | "connected" | "error" | "taken" | "blocked";
  /** The OpenConnector MCP address the card connects to. */
  url: string;
  /** Its host, as the card shows it. */
  host: string;
  /** OpenMausBot starts, health-checks and restarts the local process. */
  managed: boolean;
  /** The program OpenMausBot starts it with (`managed` only). Not a secret. */
  command: string;
  /** Its arguments, one entry each. */
  args: string[];
  /** The managed process is thought to be alive. */
  running: boolean;
  /** The managed process's pid, when known. */
  pid: number | null;
  /** Tools the last check found. */
  tools?: number;
  /** Why the organization's policy refuses it (`blocked`), or the last health-check error (`error`). */
  message?: string;
}

export function isOpenConnectorStatus(value: unknown): value is OpenConnectorStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<OpenConnectorStatus>;
  return typeof status.state === "string" && typeof status.url === "string" && typeof status.host === "string"
    && typeof status.managed === "boolean" && typeof status.running === "boolean"
    && typeof status.command === "string" && Array.isArray(status.args);
}
