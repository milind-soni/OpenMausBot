import { describe, expect, it } from "vitest";

import { defaultBrandPath, overrideBrandPath, workspaceBrandPath } from "./fleet-brand.ts";
import { planFleetAction, runFleetCommand, type FleetInput } from "./fleet-cli.ts";
import { fleetLayout } from "./fleet.ts";
import { dataUri, HTML_NAMED_PNG, ICO, PNG, resellerRegistry, SVG, workspace } from "./testing/fleet-brand-fixtures.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";

const layout = fleetLayout("/");
const base: FleetInput = { action: "brand", admins: [], members: [], dryRun: false, yes: false, keepData: false, node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", root: "/" };

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) }, out, err };
};

const workspaces = () => [workspace("acme", "running", 0), workspace("beta", "suspended", 1), workspace("gamma", "provisioning", 2), workspace("delta", "retained", 3), workspace("eps", "error", 4)];

function fleet(options: { root?: boolean } = {}) {
  const machine = fleetMachine("/", options);
  machine.files.set(layout.registryFile, JSON.stringify(resellerRegistry(workspaces())));
  for (const slug of ["acme", "beta"]) machine.files.set(`${layout.instancesDir}/${slug}.env`, `OMB_BRAND_FILE=${workspaceBrandPath(layout, slug)}\n`);
  machine.bytes.set("/srv/logo.png", PNG);
  machine.bytes.set("/srv/mark.svg", SVG);
  machine.bytes.set("/srv/icon.ico", ICO);
  machine.bytes.set("/srv/page.png", HTML_NAMED_PNG);
  return machine;
}

const merged = (machine: ReturnType<typeof fleet>, slug: string) => JSON.parse(machine.files.get(workspaceBrandPath(layout, slug))!);

describe("fleet brand --default", () => {
  it("writes the default and a merged file for every running or suspended workspace, and skips the rest with a note", async () => {
    const machine = fleet();
    const log = io();
    const code = await runFleetCommand({ ...base, brandDefault: true, brandPatch: { name: "Acme Assistant", accent: "#C2510A" }, logoSource: "/srv/logo.png", faviconSource: "/srv/icon.ico" }, log.io, machine.deps);
    expect(code).toBe(0);
    expect(JSON.parse(machine.files.get(defaultBrandPath(layout))!)).toEqual({ name: "Acme Assistant", accent: "#C2510A", logo: dataUri("image/png", PNG), favicon: dataUri("image/x-icon", ICO) });
    for (const slug of ["acme", "beta"]) expect(merged(machine, slug)).toMatchObject({ name: "Acme Assistant", accent: "#C2510A", logo: dataUri("image/png", PNG) });
    for (const slug of ["gamma", "delta", "eps"]) expect(machine.files.has(workspaceBrandPath(layout, slug))).toBe(false);
    expect(log.out).toContain("skipped gamma: it is provisioning; run `openmausbot fleet brand gamma` once it is running again");
    expect(log.out).toContain("skipped delta: it is retained; run `openmausbot fleet brand delta` once it is running again");
    expect(log.out).toContain("skipped eps: it is error; run `openmausbot fleet brand eps` once it is running again");
    expect(log.out.at(-1)).toContain("applied to 2 workspaces");
    expect(machine.calls.filter((call) => call.startsWith("systemctl"))).toEqual([]);
  });

  it("leaves a workspace's own override on top, and gives its fields back on clear", async () => {
    const machine = fleet();
    await runFleetCommand({ ...base, brandDefault: true, brandPatch: { name: "Acme Assistant", tagline: "Ask us" } }, io().io, machine.deps);
    await runFleetCommand({ ...base, slug: "acme", brandPatch: { name: "Blue Team", tagline: "Only blue" } }, io().io, machine.deps);
    expect(merged(machine, "acme")).toEqual({ name: "Blue Team", tagline: "Only blue" });
    expect(merged(machine, "beta")).toEqual({ name: "Acme Assistant", tagline: "Ask us" });

    await runFleetCommand({ ...base, brandDefault: true, brandPatch: { tagline: "Ask anything" } }, io().io, machine.deps);
    expect(merged(machine, "acme")).toEqual({ name: "Blue Team", tagline: "Only blue" });
    expect(merged(machine, "beta")).toEqual({ name: "Acme Assistant", tagline: "Ask anything" });

    await runFleetCommand({ ...base, slug: "acme", brandClear: ["tagline", "name"] }, io().io, machine.deps);
    expect(merged(machine, "acme")).toEqual({ name: "Acme Assistant", tagline: "Ask anything" });

    await runFleetCommand({ ...base, brandDefault: true, brandClear: ["name", "tagline"] }, io().io, machine.deps);
    expect(merged(machine, "acme")).toEqual({ name: "Acme Chat" });
    expect(JSON.parse(machine.files.get(defaultBrandPath(layout))!)).toEqual({});
    expect(JSON.parse(machine.files.get(overrideBrandPath(layout, "acme"))!)).toEqual({});
  });

  it("plans the same steps a second time", async () => {
    const machine = fleet();
    const input: FleetInput = { ...base, brandDefault: true, brandPatch: { name: "Acme Assistant" }, logoSource: "/srv/mark.svg" };
    const first = planFleetAction(input, machine.deps);
    expect(await runFleetCommand(input, io().io, machine.deps)).toBe(0);
    expect(planFleetAction(input, machine.deps)).toEqual(first);
  });

  it("changes nothing when any target would end up invalid", async () => {
    const machine = fleet();
    machine.files.set(overrideBrandPath(layout, "beta"), '{"accent":"blue"}');
    const log = io();
    const before = new Map(machine.files);
    expect(await runFleetCommand({ ...base, brandDefault: true, brandPatch: { name: "Acme Assistant" } }, log.io, machine.deps)).toBe(2);
    expect(log.err[0]).toContain("beta.override.json: accent: accent must be a 6-digit hex colour");
    expect(machine.files).toEqual(before);
    expect(machine.calls).toEqual([]);
  });

  it("changes nothing on an invalid patch", async () => {
    const machine = fleet();
    const before = new Map(machine.files);
    for (const patch of [{ brandPatch: { accent: "#12" } }, { brandPatch: { supportUrl: "http://help.acme.test" } }, { brandPatch: { name: "" } }, { logoSource: "/srv/page.png" }, { logoSource: "/srv/missing.png" }, { faviconSource: "/srv/page.png" }]) {
      const log = io();
      expect(await runFleetCommand({ ...base, brandDefault: true, ...patch }, log.io, machine.deps), JSON.stringify(patch)).toBe(2);
      expect(log.out).toEqual([]);
    }
    expect(machine.files).toEqual(before);
  });
});

describe("images given as files", () => {
  it("are recognised by their bytes, not their name", async () => {
    const machine = fleet();
    const log = io();
    expect(await runFleetCommand({ ...base, brandDefault: true, logoSource: "/srv/page.png" }, log.io, machine.deps)).toBe(2);
    expect(log.err[0]).toContain("/srv/page.png is not a PNG, JPEG, WebP, GIF or SVG image");
    expect(await runFleetCommand({ ...base, brandDefault: true, logoSource: "/srv/icon.ico" }, io().io, machine.deps)).toBe(2);
    expect(await runFleetCommand({ ...base, brandDefault: true, logoSource: "/srv/mark.svg", faviconSource: "/srv/mark.svg" }, io().io, machine.deps)).toBe(0);
    expect(merged(machine, "acme").logo).toBe(dataUri("image/svg+xml", SVG));
  });

  it("are refused when too large for the schema, naming the limit in kilobytes", async () => {
    const machine = fleet();
    machine.bytes.set("/srv/huge.png", Uint8Array.from([...PNG, ...new Uint8Array(300_000)]));
    const log = io();
    expect(await runFleetCommand({ ...base, brandDefault: true, logoSource: "/srv/huge.png" }, log.io, machine.deps)).toBe(2);
    expect(log.err[0]).toMatch(/^fleet: \/srv\/huge\.png is \d+ KB; the logo must be at most 219 KB for its type$/);
  });

  it("keep an https logo as typed without reading anything", async () => {
    const machine = fleet();
    machine.deps.readBytes = () => { throw new Error("must not read"); };
    expect(await runFleetCommand({ ...base, slug: "acme", logoSource: "https://cdn.acme.test/logo.svg" }, io().io, machine.deps)).toBe(0);
    expect(merged(machine, "acme").logo).toBe("https://cdn.acme.test/logo.svg");
  });
});

describe("a dry run or a plan printed without root", () => {
  it("leaves the image bytes out of the listing and writes nothing", async () => {
    const machine = fleet({ root: false });
    const before = new Map(machine.files);
    const log = io();
    expect(await runFleetCommand({ ...base, brandDefault: true, logoSource: "/srv/logo.png", faviconSource: "/srv/icon.ico", brandPatch: { name: "Acme Assistant" }, dryRun: true }, log.io, machine.deps)).toBe(0);
    const printed = log.out.join("\n");
    expect(log.out[0]).toContain("dry run");
    expect(printed).toContain("cat > /etc/openmausbot/brands/_default.json");
    expect(printed).toContain("cat > /etc/openmausbot/brands/acme.json");
    expect(printed).toContain("Acme Assistant");
    expect(printed).toContain("image of about");
    expect(printed).not.toContain(Buffer.from(PNG).toString("base64"));
    expect(printed).not.toContain(Buffer.from(ICO).toString("base64"));
    expect(machine.files).toEqual(before);
    expect(machine.calls).toEqual([]);
  });
});

describe("fleet brand for one workspace", () => {
  it("refuses a workspace that is not running or suspended", async () => {
    const machine = fleet();
    const log = io();
    expect(await runFleetCommand({ ...base, slug: "delta", brandPatch: { name: "X" } }, log.io, machine.deps)).toBe(2);
    expect(log.err[0]).toContain('workspace "delta" is retained and requires operator recovery');
  });

  it("works for a suspended workspace and notes the old environment", async () => {
    const machine = fleet();
    machine.files.set(`${layout.instancesDir}/beta.env`, "OMB_PORT=8820\n");
    const log = io();
    expect(await runFleetCommand({ ...base, slug: "beta", brandPatch: { tagline: "Back soon" } }, log.io, machine.deps)).toBe(0);
    expect(merged(machine, "beta")).toEqual({ name: "Acme Chat", tagline: "Back soon" });
    expect(log.out.some((line) => line.includes("created before this fleet had a reseller"))).toBe(true);
  });
});
