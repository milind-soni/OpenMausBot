// Builds a throwaway reseller fleet by running the real `openmausbot fleet` command line over a recording machine whose files are mirrored into a temp root.
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { launchVerificationServer, type VerificationServer } from "../../scripts/control-omb.ts";
import { parseArgs, type CliOptions } from "../cli.ts";
import { runFleetCommand, type FleetDeps, type FleetInput } from "../fleet-cli.ts";
import { fleetLayout, type FleetLayout } from "../fleet.ts";
import { fleetMachine } from "./fleet-machine.ts";

export const RESELLER = {
  domain: "reseller.test",
  name: "Acme AI",
  currency: "USD",
  accent: "#C2510A",
  tagline: "Teams that ship",
  supportUrl: "https://help.acme-ai.test/support",
  alphaHost: "ai.alpha-corp.test",
  licenseKey: "fixture-key",
  rates: { wholesaleWorkspace: "5.00", wholesaleUser: "2.00", retailWorkspace: "20.00", retailUser: "9.00" },
} as const;

export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

const FLEET_SCRIPT = "/usr/lib/node_modules/openmausbot/cli.js";

export interface FleetRun {
  code: number;
  out: string[];
  err: string[];
}

export interface ResellerFleet {
  root: string;
  layout: FleetLayout;
  paths: { logo: string; licenseKey: string };
  files: Map<string, string>;
  calls: string[];
  deps: FleetDeps;
  /** Runs one `openmausbot fleet ...` command line through the real argument parser and `runFleetCommand`. */
  fleet(tokens: string[], overrides?: Partial<FleetInput>): Promise<FleetRun>;
  remove(): Promise<void>;
}

function fleetInput(options: CliOptions, root: string): FleetInput {
  const keyFile = options.licenseKeyFile;
  const licenseKey = options.licenseKey ?? (keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined);
  return {
    action: options.fleetAction as FleetInput["action"],
    slug: options.slug,
    domain: options.domain,
    operator: options.operator,
    admins: options.admins ?? [],
    members: options.members ?? [],
    brandFile: options.brandFile,
    anthropicKeyFile: options.anthropicKeyFile,
    cap: options.cap,
    licenseKey,
    licenseKeyFile: options.licenseKeyFile,
    host: options.host,
    resellerName: options.resellerName,
    currency: options.currency,
    brandDefault: options.brandDefault,
    brandPatch: options.brandPatch,
    brandClear: options.brandClear,
    logoSource: options.logoSource,
    faviconSource: options.faviconSource,
    month: options.month,
    csv: options.csv,
    detail: options.detail,
    ratesPatch: options.ratesPatch,
    memory: options.memory,
    dryRun: options.dryRun ?? false,
    yes: options.yes ?? false,
    keepData: options.keepData ?? false,
    userAction: options.fleetUserAction,
    email: options.email,
    chatOnly: options.chatOnly,
    node: process.execPath,
    script: FLEET_SCRIPT,
    root,
  };
}

export function fleetCommandInput(tokens: string[], root: string): FleetInput {
  const parsed = parseArgs(["fleet", ...tokens], {});
  if ("error" in parsed) throw new Error(`fleet ${tokens.join(" ")}: ${parsed.error}`);
  return fleetInput(parsed, root);
}

/** A temp root with an empty fleet: the recording machine's writes also land as real files under it, so the billing helper and a reader see the same tree. */
export function emptyResellerFleet(): ResellerFleet {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-reseller-fleet-")));
  const layout = fleetLayout(root);
  const machine = fleetMachine(root);
  const logo = join(root, "acme-logo.png");
  const licenseKey = join(root, "license.key");
  writeFileSync(logo, TINY_PNG);
  writeFileSync(licenseKey, `${RESELLER.licenseKey}\n`, { mode: 0o600 });
  const deps: FleetDeps = {
    ...machine.deps,
    readText: (path, owner) => machine.deps.readText(path, owner) ?? (existsSync(path) ? readFileSync(path, "utf8") : null),
    pathExists: (path) => machine.deps.pathExists(path) || existsSync(path),
    readBytes: (path) => machine.deps.readBytes?.(path) ?? (existsSync(path) ? readFileSync(path) : null),
    writeText: (path, content, mode, owner) => {
      machine.deps.writeText(path, content, mode, owner);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode });
    },
    remove: (path) => {
      machine.deps.remove(path);
      rmSync(path, { force: true });
    },
  };
  return {
    root,
    layout,
    paths: { logo, licenseKey },
    files: machine.files,
    calls: machine.calls,
    deps,
    async fleet(tokens, overrides = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runFleetCommand({ ...fleetCommandInput(tokens, root), ...overrides }, { log: (line) => out.push(line), error: (line) => err.push(line) }, deps);
      return { code, out, err };
    },
    async remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The fleet exactly as the owner's acceptance flow builds it: init, default brand, one custom-address workspace, one default-address workspace, the rate card. */
export async function buildResellerFleet(): Promise<ResellerFleet> {
  const fleet = emptyResellerFleet();
  const steps: string[][] = [
    ["init", "--domain", RESELLER.domain, "--reseller-name", RESELLER.name, "--currency", RESELLER.currency],
    ["brand", "--default", "--logo", fleet.paths.logo, "--accent", RESELLER.accent, "--tagline", RESELLER.tagline, "--support-url", RESELLER.supportUrl],
    ["create", "alpha", "--admin", "owner@alpha-corp.test", "--host", RESELLER.alphaHost, "--license-key-file", fleet.paths.licenseKey],
    ["create", "beta", "--admin", "owner@beta-corp.test", "--license-key-file", fleet.paths.licenseKey],
    ["rates", "--wholesale-workspace", RESELLER.rates.wholesaleWorkspace, "--wholesale-user", RESELLER.rates.wholesaleUser, "--retail-workspace", RESELLER.rates.retailWorkspace, "--retail-user", RESELLER.rates.retailUser],
  ];
  try {
    for (const tokens of steps) {
      const run = await fleet.fleet(tokens);
      if (run.code !== 0) throw new Error(`fleet ${tokens.slice(0, 2).join(" ")} exited ${run.code}: ${[...run.out, ...run.err].join("\n")}`);
    }
  } catch (error) {
    await fleet.remove();
    throw error;
  }
  return fleet;
}

/** The folder shape core loads: `<dir>/server/index.js` exporting `register()`. */
export function writeEnterpriseLayer(features: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-reseller-layer-"));
  mkdirSync(join(dir, "server"));
  writeFileSync(join(dir, "server", "index.js"), `export async function register() { return { customer: "Fixture Reseller", features: ${JSON.stringify(features)}, expiresAt: "2099-01-01" }; }\n`);
  return dir;
}

export const RESELLER_FEATURES = ["whitelabel", "admin", "billing"];

/** Isolated fake-engine servers that all accept the fixture licence key; `layerDir` undefined launches ones with no enterprise layer at all. */
export async function launchServers(count: number, layerDir: string | undefined, signal?: AbortSignal): Promise<VerificationServer[]> {
  const enterprise = layerDir ? { dir: layerDir, licenseKey: RESELLER.licenseKey } : undefined;
  const servers = await Promise.allSettled(Array.from({ length: count }, () => launchVerificationServer(process.env, signal, undefined, undefined, enterprise)));
  const failed = servers.find((entry) => entry.status === "rejected");
  if (failed) {
    await Promise.all(servers.map((entry) => (entry.status === "fulfilled" ? entry.value.close() : undefined)));
    throw (failed as PromiseRejectedResult).reason;
  }
  return servers.map((entry) => (entry as PromiseFulfilledResult<VerificationServer>).value);
}

/**
 * Account discovery is the only synthetic part of the privilege-dropped billing helper: every `omb-<slug>` account is
 * this user, with a home under the temp root. Returns the function that puts the real `execFileSync` back.
 */
export function stubAccountLookup(root: string): () => void {
  const original = childProcess.execFileSync;
  const stub = (command: string, args?: readonly string[], options?: unknown) => {
    if (command === "/usr/bin/getent") {
      const owner = args![1]!;
      return `${owner}:x:${process.getuid!()}:${process.getgid!()}:fixture:${join(root, "var/lib/openmausbot", owner.replace(/^omb-/, ""))}:/usr/sbin/nologin\n`;
    }
    return (original as (...rest: unknown[]) => unknown)(command, args, options);
  };
  childProcess.execFileSync = stub as unknown as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  return () => {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  };
}
