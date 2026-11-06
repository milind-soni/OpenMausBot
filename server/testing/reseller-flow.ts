// The owner's acceptance flow, one run: a fleet built by the real CLI, branded isolated workspaces, real fake-engine turns, and a billing report read from their real ledgers.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import type { FleetBillingReport } from "../../shared/fleet-billing.ts";
import { buildBillingReport } from "../fleet-billing.ts";
import { workspaceBrandPath } from "../fleet-brand.ts";
import { defaultFleetDeps, runFleetCommand } from "../fleet-cli.ts";
import { parseRegistry, workspaceDataDir, type FleetRegistry } from "../fleet.ts";
import { monthKey } from "../usage-ledger.ts";
import { removeTempDir } from "./cleanup.ts";
import { buildResellerFleet, fleetCommandInput, launchServers, RESELLER_FEATURES, stubAccountLookup, writeEnterpriseLayer, type FleetRun, type ResellerFleet } from "./reseller-fixture.ts";

export interface UsageOracle {
  groups: { key: string; turns: number; costUsd: number | null }[];
  total: { turns: number; costUsd: number | null };
}

export interface BrandBody {
  source: string;
  brand: { name: string; logo?: string; accent?: string; tagline?: string; supportUrl?: string };
  notice?: string;
}

export interface BillingRun {
  report: FleetBillingReport;
  csv: FleetRun;
}

export interface ResellerEvidence {
  month: string;
  brand: { alpha: BrandBody; beta: BrandBody; withoutEntitlement: BrandBody };
  registry: Record<string, { host: string; status: string }>;
  sites: Record<string, { caddy: string; env: string }>;
  oracle: { alpha: UsageOracle; beta: UsageOracle };
  ledgers: { alpha: string; beta: string };
  billing: BillingRun;
  deleted: { snapshotPath: string; snapshot: unknown; brandFilesLeft: string[]; billing: BillingRun };
  logs: { alpha: string; beta: string; withoutEntitlement: string; fleetRoot: string };
}

const json = (body: unknown, token?: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

export class ResellerFlow {
  readonly month = monthKey(new Date());

  readonly fleet: ResellerFleet;
  readonly layerDir: string;
  readonly alpha: VerificationServer;
  readonly beta: VerificationServer;
  readonly withoutEntitlement: VerificationServer;
  private readonly restoreAccounts: () => void;
  private closing: Promise<void> | undefined;

  private constructor(fleet: ResellerFleet, layerDir: string, servers: VerificationServer[], restoreAccounts: () => void) {
    this.fleet = fleet;
    this.layerDir = layerDir;
    [this.alpha, this.beta, this.withoutEntitlement] = servers as [VerificationServer, VerificationServer, VerificationServer];
    this.restoreAccounts = restoreAccounts;
  }

  static async start(signal?: AbortSignal): Promise<ResellerFlow> {
    const layerDir = writeEnterpriseLayer(RESELLER_FEATURES);
    let fleet: ResellerFleet | undefined;
    let restore: (() => void) | undefined;
    let servers: VerificationServer[] = [];
    try {
      fleet = await buildResellerFleet();
      restore = stubAccountLookup(fleet.root);
      const [entitled, plain] = await Promise.all([launchServers(2, layerDir, signal), launchServers(1, undefined, signal)]);
      servers = [...entitled, ...plain];
      return new ResellerFlow(fleet, layerDir, servers, restore);
    } catch (error) {
      restore?.();
      await Promise.all(servers.map((server) => server.close()));
      await Promise.all([layerDir, fleet?.root].map((path) => (path ? removeTempDir(path) : undefined)));
      throw error;
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.restoreAccounts();
      await Promise.all([this.alpha, this.beta, this.withoutEntitlement].map((server) => server.close()));
      await Promise.all([this.layerDir, this.fleet.root].map((path) => removeTempDir(path)));
    })();
    return this.closing;
  }

  private api = (server: VerificationServer, path: string, init: RequestInit = {}) => fetch(`${server.info.url}${path}`, init);
  private control = (server: VerificationServer, args: string[]) => runControlOmb([...args, "--url", server.info.url]) as Promise<any>;

  brandFile(slug: string): string {
    return workspaceBrandPath(this.fleet.layout, slug);
  }

  /** The merged file the fleet wrote, placed where the isolated workspace reads its brand. */
  installBrand(slug: string, server: VerificationServer): void {
    writeFileSync(join(server.info.dataDir, "brand.json"), readFileSync(this.brandFile(slug), "utf8"));
  }

  async brand(server: VerificationServer): Promise<BrandBody> {
    return (await this.api(server, "/api/brand")).json() as Promise<BrandBody>;
  }

  async oracle(server: VerificationServer): Promise<UsageOracle> {
    return (await this.api(server, "/api/usage?groupBy=user")).json() as Promise<UsageOracle>;
  }

  private async pair(server: VerificationServer, label: string): Promise<string> {
    const opened = (await (await this.api(server, "/api/auth/pairing", json({}))).json()) as { code: string };
    return ((await (await this.api(server, "/api/auth/pair", json({ code: opened.code, label }))).json()) as { token: string }).token;
  }

  private async ask(server: VerificationServer, botId: string, text: string, token?: string): Promise<void> {
    const response = await this.api(server, `/api/bots/${encodeURIComponent(botId)}/messages`, json({ text }, token));
    if (![200, 201, 202].includes(response.status)) throw new Error(`message to ${server.info.url} answered ${response.status}`);
    const settled = JSON.stringify(await this.control(server, ["wait", "--bot", botId, "--timeout", "30"]));
    if (!settled.includes("settled")) throw new Error(`turn on ${server.info.url} did not settle: ${settled}`);
  }

  /** Two paired labelled devices and the owner in alpha; the owner alone in beta. */
  async bookTurns(): Promise<void> {
    const alphaBot = (await this.control(this.alpha, ["new-bot", "--name", "Alpha probe"])).bot.id as string;
    await this.ask(this.alpha, alphaBot, "hello from the owner");
    await this.ask(this.alpha, alphaBot, "hello from Ada's phone", await this.pair(this.alpha, "Ada's phone"));
    await this.ask(this.alpha, alphaBot, "hello from Bo's tablet", await this.pair(this.alpha, "Bo's tablet"));
    const betaBot = (await this.control(this.beta, ["new-bot", "--name", "Beta probe"])).bot.id as string;
    await this.ask(this.beta, betaBot, "hello from the beta owner");
  }

  ledgerOf(server: VerificationServer): string {
    return join(server.info.dataDir, "usage", `${this.month}.jsonl`);
  }

  /** Copies each fixture's month file to the workspace's data directory in the fleet root, where the helper reads it. */
  copyLedgers(): { alpha: string; beta: string } {
    const copy = (slug: string, server: VerificationServer) => {
      const usage = join(workspaceDataDir(this.fleet.layout, slug), "usage");
      mkdirSync(usage, { recursive: true, mode: 0o700 });
      const target = join(usage, `${this.month}.jsonl`);
      copyFileSync(this.ledgerOf(server), target);
      return target;
    };
    return { alpha: copy("alpha", this.alpha), beta: copy("beta", this.beta) };
  }

  registry(): FleetRegistry {
    return parseRegistry(readFileSync(this.fleet.layout.registryFile, "utf8"));
  }

  /** The JSON report and the `fleet billing --csv --detail` command, both through the real privilege-dropped helper path. */
  async billing(): Promise<BillingRun> {
    const layout = this.fleet.layout;
    const report = await buildBillingReport({ registry: this.registry(), layout, deps: defaultFleetDeps(), month: this.month, detail: true, now: new Date() });
    const out: string[] = [];
    const err: string[] = [];
    const saved = process.env.OMB_ENTERPRISE_DIR;
    process.env.OMB_ENTERPRISE_DIR = this.layerDir;
    try {
      const input = fleetCommandInput(["billing", "--month", this.month, "--csv", "--detail", "--license-key-file", this.fleet.paths.licenseKey], this.fleet.root);
      const code = await runFleetCommand(input, { log: (line) => out.push(line), error: (line) => err.push(line) }, defaultFleetDeps());
      return { report, csv: { code, out, err } };
    } finally {
      if (saved === undefined) delete process.env.OMB_ENTERPRISE_DIR; else process.env.OMB_ENTERPRISE_DIR = saved;
    }
  }

  brandFilesOf(slug: string): string[] {
    const dir = this.fleet.layout.brandsDir;
    return existsSync(dir) ? readdirSync(dir).filter((name) => name === `${slug}.json` || name === `${slug}.override.json`) : [];
  }

  site(slug: string): { caddy: string; env: string } {
    return {
      caddy: this.fleet.files.get(join(this.fleet.layout.caddyDir, `${slug}.caddy`)) ?? "",
      env: this.fleet.files.get(join(this.fleet.layout.instancesDir, `${slug}.env`)) ?? "",
    };
  }

  async runAll(): Promise<ResellerEvidence> {
    this.installBrand("alpha", this.alpha);
    this.installBrand("beta", this.beta);
    this.installBrand("alpha", this.withoutEntitlement);
    const brand = { alpha: await this.brand(this.alpha), beta: await this.brand(this.beta), withoutEntitlement: await this.brand(this.withoutEntitlement) };
    const registry = Object.fromEntries(Object.values(this.registry().workspaces).map((entry) => [entry.slug, { host: entry.host, status: entry.status }]));
    const sites = { alpha: this.site("alpha"), beta: this.site("beta") };

    await this.bookTurns();
    const oracle = { alpha: await this.oracle(this.alpha), beta: await this.oracle(this.beta) };
    const ledgers = this.copyLedgers();
    const billing = await this.billing();

    const deleted = await this.fleet.fleet(["delete", "beta", "--yes"]);
    if (deleted.code !== 0) throw new Error(`fleet delete beta exited ${deleted.code}: ${[...deleted.out, ...deleted.err].join("\n")}`);
    const closing = join(this.fleet.layout.billingDir, "closing");
    const snapshots = existsSync(closing) ? readdirSync(closing) : [];
    const snapshotPath = snapshots.length ? join(closing, snapshots[0]!) : "";
    const afterDelete = await this.billing();

    return {
      month: this.month,
      brand,
      registry,
      sites,
      oracle,
      ledgers,
      billing,
      deleted: { snapshotPath, snapshot: snapshotPath ? JSON.parse(readFileSync(snapshotPath, "utf8")) : null, brandFilesLeft: this.brandFilesOf("beta"), billing: afterDelete },
      logs: { alpha: this.alpha.info.logPath, beta: this.beta.info.logPath, withoutEntitlement: this.withoutEntitlement.info.logPath, fleetRoot: this.fleet.root },
    };
  }
}
