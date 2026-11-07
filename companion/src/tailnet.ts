// Tailscale for the phone link, only once the person turns it on. Off, nothing here runs a Tailscale binary.
// Never log Tailscale's raw output: it can carry auth keys and node names.
import { execFile } from "node:child_process";

import { forgetTailnetName, refreshTailnetName, tailnetName, tailscaleCli, tailscaleEnvironment } from "./listener.ts";

/** The tailnet-side HTTPS port `tailscale serve` answers on; clear of the companion's 8810–8812. */
export const TAILNET_HTTPS_PORT = 8813;

export type TailnetProblem = "not-found" | "port-taken" | "serve-refused";

export interface TailnetState {
  on: boolean;
  /** `https://<name>.ts.net:8813`, served by Tailscale with its own certificate. */
  httpsOrigin: string | null;
  problem: TailnetProblem | null;
}

export type TailscaleRunner = (cli: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string }>;

const runTailscale: TailscaleRunner = (cli, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      cli,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env: tailscaleEnvironment() },
      (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? "") }),
    );
  });

/** Whose handler `tailscale serve` has on `name:port`: none, ours (proxying to the companion), or the person's own. */
export function serveOwner(statusJson: string, name: string, port: number, target: string): "none" | "ours" | "theirs" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson || "{}");
  } catch {
    return "theirs";
  }
  const tcp = Reflect.get(Object(Reflect.get(Object(parsed), "TCP")), String(port));
  const web = Reflect.get(Object(Reflect.get(Object(parsed), "Web")), `${name}:${port}`);
  if (!tcp && !web) return "none";
  const handlers = Object.values(Object(Reflect.get(Object(web), "Handlers")));
  const proxies = handlers.map((handler) => Reflect.get(Object(handler), "Proxy"));
  return proxies.length > 0 && proxies.every((proxy) => proxy === target) ? "ours" : "theirs";
}

export type TailnetLookup = (onAttempt?: (cli: string, outcome: string) => void) => Promise<{ name: string; cli: string } | null>;

const lookupTailnet: TailnetLookup = async (onAttempt) => {
  await refreshTailnetName(onAttempt);
  const name = tailnetName();
  const cli = tailscaleCli();
  return name && cli ? { name, cli } : null;
};

export function createTailnet({
  companionPort,
  httpsPort = TAILNET_HTTPS_PORT,
  run = runTailscale,
  lookup = lookupTailnet,
  forget = forgetTailnetName,
  initiallyOn = false,
}: {
  companionPort: number;
  httpsPort?: number;
  run?: TailscaleRunner;
  lookup?: TailnetLookup;
  forget?: () => void;
  initiallyOn?: boolean;
}) {
  const target = `http://127.0.0.1:${companionPort}`;
  let state: TailnetState = { on: initiallyOn, httpsOrigin: null, problem: null };
  let found: { name: string; cli: string } | null = null;

  const owner = async ({ cli, name }: { name: string; cli: string }) => {
    const status = await run(cli, ["serve", "status", "--json"], 10_000);
    return status.ok ? serveOwner(status.stdout, name, httpsPort, target) : "none";
  };

  async function on(onAttempt?: (cli: string, outcome: string) => void): Promise<TailnetState> {
    state = { on: true, httpsOrigin: null, problem: null };
    found = await lookup(onAttempt).catch(() => null);
    if (!state.on) return state;
    if (!found) {
      state = { on: true, httpsOrigin: null, problem: "not-found" };
      return state;
    }
    const existing = await owner(found);
    if (existing === "theirs") {
      state = { on: true, httpsOrigin: null, problem: "port-taken" };
      return state;
    }
    if (existing === "none") {
      const served = await run(found.cli, ["serve", "--bg", `--https=${httpsPort}`, target], 20_000);
      if (!served.ok) {
        state = { on: true, httpsOrigin: null, problem: "serve-refused" };
        return state;
      }
    }
    if (state.on) state = { on: true, httpsOrigin: `https://${found.name}:${httpsPort}`, problem: null };
    return state;
  }

  /** Removes only the serve handler this companion created; the person's own Tailscale and its other handlers stay. */
  async function off(): Promise<TailnetState> {
    const known = found;
    state = { on: false, httpsOrigin: null, problem: null };
    found = null;
    forget();
    if (known && (await owner(known)) === "ours") {
      await run(known.cli, ["serve", `--https=${httpsPort}`, "off"], 10_000);
    }
    return state;
  }

  return { on, off, state: (): TailnetState => state };
}

export type Tailnet = ReturnType<typeof createTailnet>;
