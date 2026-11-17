// Builds the environment passed to child MCP processes spawned by mcp-gate.
// Built from an allowlist; secrets and harness-internal environment never reach the child.

const BASE_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

const WINDOWS_ALLOWLIST = new Set([
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

const PASSTHROUGH_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_SUFFIX = /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;

export function buildMcpChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  specEnv?: Record<string, string>,
  passthrough?: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const isWin = platform === "win32";

  const isAllowedBase = (key: string): boolean => {
    if (BASE_ALLOWLIST.has(key)) return true;
    if (key.startsWith("LC_")) return true;
    if (isWin) {
      const upper = key.toUpperCase();
      if (BASE_ALLOWLIST.has(upper) || WINDOWS_ALLOWLIST.has(upper)) return true;
    }
    return false;
  };

  const isBlocked = (key: string): boolean => {
    if (key.toUpperCase() === "NODE_OPTIONS") return true;
    if (key.startsWith("OMB_")) return true;
    if (SECRET_SUFFIX.test(key)) return true;
    return false;
  };

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (isAllowedBase(key) && !isBlocked(key)) {
      result[key] = value;
    }
  }

  if (Array.isArray(passthrough)) {
    for (const name of passthrough) {
      if (typeof name === "string" && PASSTHROUGH_NAME.test(name)) {
        const entry = isWin
          ? Object.entries(parentEnv).find(([k]) => k.toUpperCase() === name.toUpperCase())
          : [name, parentEnv[name]] as const;
        const val = entry ? entry[1] : undefined;
        if (val !== undefined) {
          result[name] = val;
        }
      }
    }
  }

  if (specEnv && typeof specEnv === "object") {
    for (const [key, value] of Object.entries(specEnv)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
  }

  for (const key of Object.keys(result)) {
    if (key.startsWith("OMB_GATE_")) {
      delete result[key];
    }
  }

  return result;
}
