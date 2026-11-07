// The isolated fake-engine fixture with a stand-in enterprise layer granting `whitelabel`; no real licence, engine or provider.
// The merged brand file is produced by the real fleet planner on a recording machine, then copied into the fixture's data dir.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { workspaceBrandPath } from "./fleet-brand.ts";
import { runFleetCommand, type FleetInput } from "./fleet-cli.ts";
import { fleetLayout } from "./fleet.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { dataUri, PNG, resellerRegistry } from "./testing/fleet-brand-fixtures.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";

const layout = fleetLayout("/");
const base: FleetInput = { action: "list", admins: [], members: [], dryRun: false, yes: false, keepData: false, node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", root: "/" };

function resellerFleet() {
  const machine = fleetMachine("/");
  machine.files.set(layout.registryFile, JSON.stringify(resellerRegistry()));
  machine.bytes.set("/srv/logo.png", PNG);
  const run = async (input: Partial<FleetInput>) => {
    const out: string[] = [];
    const code = await runFleetCommand({ ...base, ...input }, { log: (line) => out.push(line), error: (line) => out.push(line) }, machine.deps);
    expect(code, out.join("\n")).toBe(0);
  };
  return { run, merged: () => machine.files.get(workspaceBrandPath(layout, "acme"))! };
}

describe("a reseller's merged brand file on a running workspace", () => {
  let layerDir: string;
  let session: VerificationServer | undefined;

  beforeEach(() => {
    layerDir = mkdtempSync(join(tmpdir(), "omb-fake-layer-"));
    mkdirSync(join(layerDir, "server"));
    writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Co", features: ["whitelabel"], expiresAt: "2099-01-01" }; }\n');
  });

  afterEach(async () => {
    if (session) console.info(JSON.stringify(session.info));
    await session?.close();
    session = undefined;
    await removeTempDir(layerDir);
  });

  const brand = async () => (await fetch(`${session!.info.url}/api/brand`)).json() as Promise<any>;
  const install = (content: string) => writeFileSync(join(session!.info.dataDir, "brand.json"), content);

  it("shows the reseller's name and logo, and an edit by `fleet brand` shows on the next read without a restart", async () => {
    const fleet = resellerFleet();
    await fleet.run({ action: "create", slug: "acme", admins: ["ada@example.test"], licenseKey: "fixture-key" });
    session = await launchVerificationServer(process.env, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
    install(fleet.merged());
    expect(await brand()).toMatchObject({ source: "file", brand: { name: "Acme Chat" } });
    expect((await brand()).notice).toBeUndefined();

    await fleet.run({ action: "brand", brandDefault: true, brandPatch: { name: "Acme Assistant", accent: "#C2510A", tagline: "Ask us" }, logoSource: "/srv/logo.png" });
    install(fleet.merged());
    expect(await brand()).toMatchObject({ source: "file", brand: { name: "Acme Assistant", accent: "#C2510A", tagline: "Ask us", logo: dataUri("image/png", PNG) } });

    await fleet.run({ action: "brand", slug: "acme", brandPatch: { name: "Blue Team" } });
    install(fleet.merged());
    expect((await brand()).brand).toMatchObject({ name: "Blue Team", tagline: "Ask us", logo: dataUri("image/png", PNG) });

    await fleet.run({ action: "brand", slug: "acme", brandClear: ["name"] });
    install(fleet.merged());
    expect((await brand()).brand.name).toBe("Acme Assistant");
  }, 120_000);

  it("keeps the default brand and says why on a server whose key does not grant whitelabel", async () => {
    const fleet = resellerFleet();
    await fleet.run({ action: "create", slug: "acme", admins: ["ada@example.test"] });
    session = await launchVerificationServer(process.env);
    install(fleet.merged());
    const status = await brand();
    expect(status).toMatchObject({ source: "default", brand: { name: "OpenMausBot" } });
    expect(status.notice).toContain("not licensed for whitelabel");
  }, 120_000);
});
