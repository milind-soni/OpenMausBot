// A Cloud home's own installation on OpenMausBot's connected-apps service, which its plan includes. The server registers
// it the way the desktop app registers itself (electron/managed-composio.mjs), keeps the token in a 0600 file on the
// volume that no backup carries, and hands it to the one managed path (composio.setManagedBrokerAccess). A Composio
// project key the owner saves still wins: composio.connectionMode checks it first.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ensureManagedComposioCredentials,
  managedComposioAccess,
  type ManagedComposioAccess,
  type ManagedComposioCredentials,
} from "../electron/managed-composio.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { managedComposioBrokerUrl } from "../electron/managed-composio.mjs";

/** In the data folder; excluded from backups (workspace-backup-policy.ts), so a restore keeps the Cloud's own. */
export const CLOUD_CONNECTED_APPS_FILE = "connected-apps-installation.json";
/** Between attempts while the Cloud holds no token, each with up to a fifth of jitter; the last one repeats. */
export const CLOUD_CONNECTED_APPS_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];

const TOKEN = /^[0-9a-f]{64}$/;
const storedSchema = z.object({
  version: z.number(),
  brokerUrl: z.string(),
  installationId: z.string().min(1),
  token: z.string().regex(TOKEN),
});

interface Timer { unref?(): unknown }

export interface CloudConnectedAppsOptions {
  dataDir: string;
  /** Already resolved with managedComposioBrokerUrl. */
  brokerUrl: string;
  /** composio.setManagedBrokerAccess, plus anything that tells clients. */
  apply(access: ManagedComposioAccess | null): void;
  /** OMB_CLOUD_CONNECTED_APPS_GRANT: the Admin's proof that this is a paid Cloud, which raises its daily app-event limit. */
  cloudGrant?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  retryDelaysMs?: readonly number[];
  random?: () => number;
  setTimer?: (run: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export interface CloudConnectedApps {
  /** The attempt in flight or last finished; it never rejects. */
  settled(): Promise<void>;
  stop(): void;
}

type Stored =
  | { kind: "none" }
  | { kind: "held"; credentials: ManagedComposioCredentials }
  /** Present but not this version's, or not readable now: never replaced by a new registration. */
  | { kind: "kept"; why: string };

function readStored(file: string, brokerUrl: string): Stored {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "kept", why: `it could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { kind: "none" }; }
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) {
    const version = (value as { version?: unknown } | null)?.version;
    return typeof version === "number" && version !== 1 ? { kind: "kept", why: `it is version ${version}` } : { kind: "none" };
  }
  if (parsed.data.version !== 1) return { kind: "kept", why: `it is version ${parsed.data.version}` };
  // A token goes only to the service that issued it.
  if (parsed.data.brokerUrl !== brokerUrl) return { kind: "none" };
  return { kind: "held", credentials: { composioBrokerToken: parsed.data.token, composioInstallationId: parsed.data.installationId } };
}

export function startCloudConnectedApps(options: CloudConnectedAppsOptions): CloudConnectedApps {
  const file = join(options.dataDir, CLOUD_CONNECTED_APPS_FILE);
  const log = options.log ?? (() => {});
  const delays = options.retryDelaysMs ?? CLOUD_CONNECTED_APPS_RETRY_MS;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let failures = 0;
  let timer: Timer | null = null;
  let stopped = false;
  let applied: string | null | undefined;
  let current: Promise<void> = Promise.resolve();
  const grant = options.cloudGrant?.trim() || undefined;

  const apply = (access: ManagedComposioAccess | null) => {
    const token = access?.token ?? null;
    if (stopped || token === applied) return;
    applied = token;
    try { options.apply(access); } catch (error) {
      log(`connected apps: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const retryLater = () => {
    if (stopped) return;
    const base = delays[Math.min(failures, delays.length - 1)] ?? 1_800_000;
    failures += 1;
    timer = setTimer(() => { timer = null; current = attempt(); }, Math.round(base * (1 + 0.2 * random())));
    timer.unref?.();
  };

  /** Settled once the service took the grant or refused it for good (4xx, including a service without the route);
   *  a 5xx or a network failure is tried again with the same backoff. */
  const presentGrant = async (access: ManagedComposioAccess): Promise<boolean> => {
    let status: number;
    try {
      const response = await (options.fetchImpl ?? globalThis.fetch)(`${access.url}/v1/installation/cloud`, {
        method: "PUT",
        headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: JSON.stringify({ grant }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
      await response.text().catch(() => "");
    } catch (error) {
      log(`connected apps: the Cloud plan could not be confirmed (${error instanceof Error ? error.message : String(error)}); trying again later`);
      return false;
    }
    if (status >= 500) {
      log(`connected apps: the Cloud plan could not be confirmed (HTTP ${status}); trying again later`);
      return false;
    }
    log(status < 300 ? "connected apps: Cloud plan confirmed" : `connected apps: the service did not take this Cloud's grant (HTTP ${status})`);
    return true;
  };

  const attempt = async (): Promise<void> => {
    try {
      const stored = readStored(file, options.brokerUrl);
      if (stored.kind === "kept") {
        log(`connected apps: ${CLOUD_CONNECTED_APPS_FILE} is left as it is, since ${stored.why}; trying again later`);
        retryLater();
        return;
      }
      const credentials: ManagedComposioCredentials = stored.kind === "held" ? { ...stored.credentials } : {};
      const held = credentials.composioBrokerToken;
      let saved: string | undefined;
      await ensureManagedComposioCredentials({
        brokerUrl: options.brokerUrl,
        credentials,
        fetchImpl: options.fetchImpl,
        saveCredentials: (next) => {
          writeFileAtomic(file, `${JSON.stringify({
            version: 1, brokerUrl: options.brokerUrl, installationId: next.composioInstallationId, token: next.composioBrokerToken,
          }, null, 2)}\n`, { mode: 0o600 });
          saved = next.composioBrokerToken;
        },
        log: (line) => log(line),
      });
      const token = credentials.composioBrokerToken;
      // An unsaved token would be a different installation after the next restart, its connected accounts left behind.
      const usable = typeof token === "string" && (token === held || token === saved);
      if (held && token !== held && !usable) rmSync(file, { force: true });
      const access = usable ? managedComposioAccess(options.brokerUrl, credentials) : null;
      apply(access);
      if (!usable) retryLater();
      else if (!access || !grant || await presentGrant(access)) failures = 0;
      else retryLater();
    } catch (error) {
      log(`connected apps: ${error instanceof Error ? error.message : String(error)}`);
      retryLater();
    }
  };

  // A token already on the volume serves at once; the check that follows replaces it only if the service refused it.
  const stored = readStored(file, options.brokerUrl);
  apply(stored.kind === "held" ? managedComposioAccess(options.brokerUrl, stored.credentials) : null);
  current = attempt();
  return {
    settled: () => current,
    stop: () => {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

let cloudHome: CloudConnectedApps | null = null;
/** The connected-apps service a Cloud home and a Team Cloud's members register with: the built server uses OpenMausBot's;
 * from source (development, tests) only an explicit OMB_COMPOSIO_BROKER_URL. "" for none. */
export const cloudConnectedAppsBrokerUrl = (): string => managedComposioBrokerUrl(process.env.OMB_COMPOSIO_BROKER_URL, !import.meta.url.endsWith(".ts"));

/** A Cloud home's plan includes the connected-apps service, so it registers itself. */
export function startCloudHomeConnectedApps(input: { cloudHome: boolean; dataDir: string; apply: CloudConnectedAppsOptions["apply"]; cloudGrant?: string }): void {
  if (!input.cloudHome || cloudHome) return;
  const configured = process.env.OMB_COMPOSIO_BROKER_URL;
  const brokerUrl = cloudConnectedAppsBrokerUrl();
  if (!brokerUrl) {
    if (configured?.trim()) console.warn("cloud home: connected-apps service URL rejected: HTTPS or a loopback HTTP URL is required");
    return;
  }
  cloudHome = startCloudConnectedApps({ dataDir: input.dataDir, brokerUrl, apply: input.apply, cloudGrant: input.cloudGrant, log: (line) => console.log(`cloud home: ${line}`) });
}

export function stopCloudHomeConnectedApps(): void {
  cloudHome?.stop();
  cloudHome = null;
}
