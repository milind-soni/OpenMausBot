// Names, paths and limits the connector, install.sh and the e2e share. install.sh repeats the names it needs, and a
// test holds them equal.

export const CONNECTOR_VERSION = "1.0.0";

/** Docker objects the connector owns. */
export const NAMES = {
  connector: "mausbot-connector",
  connectorNext: "mausbot-connector-next",
  home: "mausbot-home",
  dataVolume: "mausbot-data",
  stateVolume: "mausbot-connector",
  snapshotVolume: "mausbot-snapshot",
  backupPrefix: "mausbot-backup-",
} as const;

export const LABELS = {
  role: "com.mausbot.role",
  instance: "com.mausbot.instance",
  created: "com.mausbot.created",
  image: "com.mausbot.image",
  env: "com.mausbot.env",
} as const;

/** Backups the connector keeps; a newer one replaces the oldest. */
export const BACKUPS_KEPT = 3;

/** Inside the connector's container. */
export const PATHS = {
  state: process.env.MAUSBOT_STATE_DIR || "/state",
  docker: process.env.MAUSBOT_DOCKER_SOCKET || "/var/run/docker.sock",
  /** /etc/mausbot on the host, mounted read-only: the seccomp profile install.sh put there. */
  hostConfig: process.env.MAUSBOT_HOST_CONFIG_DIR || "/etc/mausbot",
  /** The connector's own copies, which install.sh installs from this image. */
  profiles: process.env.MAUSBOT_PROFILES_DIR || "/app/profiles",
  /** /var/log/mausbot on the host, mounted read-write: the audit log the server's owner reads. */
  audit: process.env.MAUSBOT_AUDIT_DIR || "/var/log/mausbot",
  /** In the container's own /tmp: `mausbot-connector job` reaches the running connector here. */
  jobs: process.env.MAUSBOT_JOBS_SOCKET || "/tmp/mausbot-jobs.sock",
} as const;

export const AUDIT_FILE = "audit.jsonl";

export const SECCOMP_FILE = "seccomp-omb-home.json";
export const APPARMOR_PROFILE = "omb-home-narrow";

/** Where the home's edge listens on the server: loopback only, reached by the connector. */
export const HOME_PORT = 8080;
/** With OMB_CLOUD_EDGE_TLS=1 the edge also serves HTTPS on the owner's domain here, published on IPv4 only: over IPv6, Docker's
 * proxy on the default bridge hands every client the bridge's address, the connector's own, so one stranger's wrong
 * pairing codes would lock out the Admin's signed pairing too. */
export const HOME_TLS_PORT = 443;

/**
 * On a stock Docker host the bot box needs our AppArmor and seccomp profiles and no masked /proc paths; the home needs
 * Docker's init, shared memory for Chrome, time to stop cleanly (its launcher kills its children at 20 s), and only the
 * four capabilities its root launcher uses. No --privileged, no added capability, no restart policy: the connector
 * restarts the home.
 */
export const HOME_CAPABILITIES = ["CHOWN", "SETUID", "SETGID", "KILL"] as const;
export const HOME_STOP_TIMEOUT_S = 30;
export const HOME_SHM_BYTES = 512 * 1024 * 1024;
export const HOME_OOM_SCORE_ADJ = -800;

/** The first home image whose launcher clears another container's data-directory lease itself. */
export const LEASE_FIXED_VERSION = [0, 1, 131] as const;

/**
 * The first home image whose launcher reads its secrets from HOME_SECRETS_FILE and drops CAP_SYS_ADMIN and CAP_SETPCAP
 * as soon as it has remounted /proc with hidepid. An older image gets its secrets in its environment and never these
 * two capabilities: it would keep CAP_SYS_ADMIN for life.
 */
export const HARDENED_LAUNCHER_VERSION = [0, 1, 145] as const;
export const HIDEPID_CAPABILITIES = ["SYS_ADMIN", "SETPCAP"] as const;

/** The home's secrets: kept out of its container's environment (docker inspect shows that) once its launcher reads the file. */
export const HOME_SECRET_ENV = [
  "OMB_CLOUD_BOOTSTRAP_SECRET", "OMB_CLOUD_BOAT_TOKEN", "OMB_CLOUD_VOICE_TOKEN", "OMB_CLOUD_DECIDER_TOKEN", "OMB_CLOUD_AI_TOKEN",
  "OMB_CLOUD_CONNECTED_APPS_GRANT", "OMB_CLOUD_X_TOKEN", "OMB_CLOUD_TUNNEL_TOKEN",
] as const;
/** In the home: a read-only folder holding only `secrets.json`, root's alone. The launcher reads it at start. */
export const HOME_SECRETS_TARGET = "/run/mausbot";
/** In the connector's state volume: the folder mounted at HOME_SECRETS_TARGET. */
export const HOME_SECRETS_DIR = "home-secrets";
export const HOME_SECRETS_FILE = "secrets.json";

export function envSeconds(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
