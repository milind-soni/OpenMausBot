// The installer's printed fleet commands are the contract: the real argument parser reads them and the real planners, over a recording machine, produce what docs/reseller promises. No apt, Node, Caddy, DNS or network.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultBrandPath, workspaceBrandPath } from "./fleet-brand.ts";
import { parseRegistry } from "./fleet.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { dataUri } from "./testing/fleet-brand-fixtures.ts";
import { emptyResellerFleet, TINY_PNG, type ResellerFleet } from "./testing/reseller-fixture.ts";
import { parseArgs } from "./cli.ts";

const INSTALL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "vps", "install.sh");
const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n';

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === "'") quoted = false; else current += char;
    } else if (char === "'") { quoted = true; started = true; }
    else if (char === "\\") { i += 1; current += line[i] ?? ""; started = true; }
    else if (char === " ") { if (started) tokens.push(current); current = ""; started = false; }
    else { current += char; started = true; }
  }
  if (started) tokens.push(current);
  return tokens;
}

describe.skipIf(process.platform === "win32")("deploy/vps/install.sh is the contract for the fleet commands", () => {
  let work: string;
  let prefix: string;
  let fleet: ResellerFleet;

  beforeEach(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "omb-reseller-contract-")));
    work = join(base, "cwd");
    prefix = join(base, "prefix");
    mkdirSync(work);
    mkdirSync(prefix);
    writeFileSync(join(work, "logo.png"), TINY_PNG);
    writeFileSync(join(work, "license.key"), "fixture-key\n", { mode: 0o600 });
    writeFileSync(join(work, "anthropic.key"), "fixture-anthropic\n", { mode: 0o600 });
    writeFileSync(join(base, "os-release"), UBUNTU);
    fleet = emptyResellerFleet();
  });

  afterEach(async () => {
    await Promise.all([removeTempDir(dirname(work)), fleet.remove()]);
  });

  const fleetLines = (args: string[]): string[][] => {
    const ran = spawnSync("sh", [INSTALL, "--dry-run", ...args], {
      cwd: work,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dirname(work), "home"), TMPDIR: dirname(work), LANG: "C", OMB_VPS_PREFIX: prefix, OMB_VPS_OS_RELEASE: join(dirname(work), "os-release") },
    });
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    return ran.stdout.split("\n")
      .filter((line) => line.startsWith("+ openmausbot fleet "))
      .map((line) => tokenize(line.slice(2)).slice(1));
  };

  const execute = async (lines: string[][]) => {
    for (const tokens of lines) {
      expect(parseArgs(tokens, {}), tokens.join(" ")).not.toHaveProperty("error");
      const run = await fleet.fleet(tokens.slice(1));
      expect(run.code, [...run.out, ...run.err].join("\n")).toBe(0);
    }
  };

  const installArgs = () => [
    "--domain", "reseller.test", "--admin", "ada@acme-ai.test", "--reseller-name", "Acme AI", "--workspace", "acme", "--host", "ai.acme-corp.test", "--cap", "50",
    "--currency", "usd", "--operator", "maus", "--logo", "logo.png", "--accent", "#C2510A", "--tagline", "Teams that ship", "--support-url", "https://help.acme-ai.test/support",
    "--license-key-file", "license.key", "--anthropic-key-file", "anthropic.key",
  ];

  it("produces the registry, brand files and Caddy site the install guide promises", async () => {
    const lines = fleetLines(installArgs());
    expect(lines.map((tokens) => tokens[1])).toEqual(["init", "brand", "create"]);
    await execute(lines);

    const registry = parseRegistry(fleet.files.get(fleet.layout.registryFile)!);
    expect(registry).toMatchObject({ domain: "reseller.test", reseller: { name: "Acme AI", currency: "USD", wholesale: { workspaceMonthMinor: 0, userMonthMinor: 0 } } });
    expect(registry.workspaces.acme).toMatchObject({ host: "ai.acme-corp.test", status: "running" });

    expect(JSON.parse(readFileSync(defaultBrandPath(fleet.layout), "utf8"))).toEqual({
      logo: dataUri("image/png", TINY_PNG), accent: "#C2510A", tagline: "Teams that ship", supportUrl: "https://help.acme-ai.test/support",
    });
    expect(JSON.parse(readFileSync(workspaceBrandPath(fleet.layout, "acme"), "utf8"))).toMatchObject({ name: "Acme AI", logo: dataUri("image/png", TINY_PNG), accent: "#C2510A" });
    for (const path of [defaultBrandPath(fleet.layout), workspaceBrandPath(fleet.layout, "acme")]) expect(statSync(path).mode & 0o777).toBe(0o644);

    expect(fleet.files.get(join(fleet.layout.caddyDir, "acme.caddy"))).toContain("ai.acme-corp.test {");
    const env = fleet.files.get(join(fleet.layout.instancesDir, "acme.env"))!;
    expect(env).toContain("OMB_PUBLIC_URL=https://ai.acme-corp.test");
    expect(env).toContain(`OMB_BRAND_FILE=${workspaceBrandPath(fleet.layout, "acme")}`);
  });

  it("serves a workspace at its default address when the install names no host", async () => {
    await execute(fleetLines(["--domain", "reseller.test", "--admin", "ada@acme-ai.test", "--reseller-name", "Acme AI"]));
    expect(parseRegistry(fleet.files.get(fleet.layout.registryFile)!).workspaces.main).toMatchObject({ host: "main.reseller.test", status: "running" });
    expect(fleet.files.get(join(fleet.layout.caddyDir, "main.caddy"))).toContain("main.reseller.test {");
  });

  it("re-running the install changes nothing about the workspace it already created, and a second create of it is refused", async () => {
    await execute(fleetLines(installArgs()));
    const first = parseRegistry(fleet.files.get(fleet.layout.registryFile)!);
    mkdirSync(join(prefix, "etc", "openmausbot"), { recursive: true });
    writeFileSync(join(prefix, "etc", "openmausbot", "fleet.json"), `{ "version": 1, "domain": "reseller.test" }\n`);

    const again = fleetLines(installArgs());
    expect(again.map((tokens) => tokens[1])).toEqual(["init", "brand", "create"]);
    expect(again[0]).toContain("--yes");
    await execute(again.slice(0, 2));
    const create = await fleet.fleet(again[2]!.slice(1));
    expect(create.code).toBe(2);
    const second = parseRegistry(fleet.files.get(fleet.layout.registryFile)!);
    expect(second.workspaces).toEqual(first.workspaces);
    expect(second.reseller).toEqual(first.reseller);
  });
});
