import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadBrand } from "./brand.ts";
import { BRAND_FIELDS, brandSchema, MAX_LOGO_CHARS } from "./brand-schema.ts";
import {
  brandCreateNotes,
  brandInputFromBody,
  defaultBrandPath,
  effectiveBrand,
  omitBrandAssets,
  overrideBrandPath,
  planCreateBrand,
  planFleetBrand,
  redactPrintedSteps,
  resolveCreateBrandJson,
  workspaceBrandPath,
} from "./fleet-brand.ts";
import type { FleetInput } from "./fleet-cli.ts";
import { planFleetAction } from "./fleet-cli.ts";
import { createPlan, fleetLayout, type FleetStep } from "./fleet.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { dataUri, PNG, RESELLER, resellerRegistry, workspace } from "./testing/fleet-brand-fixtures.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";

const layout = fleetLayout("/");
const registryFile = layout.registryFile;
const base: FleetInput = { action: "list", admins: [], members: [], dryRun: false, yes: false, keepData: false, node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", root: "/" };

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function machineWith(registry: ReturnType<typeof resellerRegistry>, extra: Record<string, string> = {}) {
  const machine = fleetMachine("/");
  machine.files.set(registryFile, JSON.stringify(registry));
  for (const [path, content] of Object.entries(extra)) machine.files.set(path, content);
  return machine;
}

const writes = (steps: FleetStep[]) => steps.flatMap((step) => (step.kind === "write" ? [step] : []));
const writeAt = (steps: FleetStep[], path: string) => writes(steps).find((step) => step.path === path);

describe("the brand schema", () => {
  it("has exactly the fields the fleet can set or clear", () => {
    expect(Object.keys(brandSchema.shape).sort()).toEqual([...BRAND_FIELDS].sort());
  });

  it("says what to change for a bad accent, an oversized logo and an http support link", () => {
    const message = (value: unknown) => brandSchema.safeParse({ name: "Acme", ...(value as object) }).error?.issues[0]?.message;
    expect(message({ accent: "blue" })).toBe("accent must be a 6-digit hex colour such as #C2510A");
    expect(message({ logo: `data:image/png;base64,${"A".repeat(MAX_LOGO_CHARS)}` })).toBe(`logo must be under ${MAX_LOGO_CHARS} characters (inline a small SVG or link an https:// image)`);
    expect(message({ supportUrl: "http://help.acme.test" })).toBe("supportUrl must be an https:// URL");
  });
});

describe("which brand a workspace shows", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>][] = [
    ["the reseller's name when nothing else is set", {}, {}, { name: "Acme Chat" }],
    ["the default's fields over the reseller's name", { name: "Acme Assistant", accent: "#112233" }, {}, { name: "Acme Assistant", accent: "#112233" }],
    ["the workspace override over the default", { name: "Acme Assistant", accent: "#112233" }, { name: "Blue Team", tagline: "Hi" }, { name: "Blue Team", accent: "#112233", tagline: "Hi" }],
    ["the default again once the override is cleared", { tagline: "Ask us" }, {}, { name: "Acme Chat", tagline: "Ask us" }],
  ];
  it.each(cases)("is %s", (_label, brandDefault, override, expected) => {
    expect(effectiveBrand(RESELLER, brandDefault, override)).toEqual(expected);
  });
});

describe("a create without a reseller", () => {
  const registry = resellerRegistry();
  const { reseller: _gone, ...legacy } = registry;
  const seed = { admins: ["ada@example.test"], members: [], brandJson: '{"name":"Acme"}' };

  it("adds nothing to the plan: the legacy brand.json write is byte for byte as before", () => {
    const machine = machineWith(legacy, { "/srv/brand.json": '{"name":"Acme"}' });
    const steps = planFleetAction({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"], brandFile: "/srv/brand.json" }, machine.deps);
    const plain = createPlan({ registry: legacy, slug: "acme", seed, layout, now: new Date(Date.parse("2026-01-01")) });
    const strip = (list: FleetStep[]) => JSON.stringify(list, (key, value) => (key === "createdAt" || key === "content" && typeof value === "string" && value.includes("createdAt") ? "" : value));
    expect(strip(steps)).toBe(strip(plain.steps));
    expect(steps.some((step) => step.kind === "write" && step.path.includes("/brands/"))).toBe(false);
    const env = writeAt(steps, "/etc/openmausbot/instances/acme.env")!;
    expect(env.content).not.toContain("OMB_BRAND_FILE");
    expect(env.content).not.toContain("OMB_SIGNIN_SMTP");
    expect(writeAt(steps, "/var/lib/openmausbot/acme/.openmausbot/brand.json")).toMatchObject({ content: '{"name":"Acme"}', mode: 0o600, owner: "omb-acme" });
    expect(steps.filter((step) => step.kind === "note").map((step) => step.text)).toEqual(["https://acme.agentada.cc is ready; ada@example.test signs in with an emailed code"]);
  });

  it("keeps resolving, validating and refusing a brand file as before", () => {
    const deps = { readText: (path: string) => (path === "/srv/brand.json" ? '{"name":"Acme"}' : path === "/srv/bad.json" ? "{nope" : null) };
    expect(resolveCreateBrandJson({ registry: legacy, brandFile: "/srv/brand.json" }, deps)).toBe('{"name":"Acme"}');
    expect(resolveCreateBrandJson({ registry: legacy, brandJson: '{"name":"X"}' }, deps)).toBe('{"name":"X"}');
    expect(resolveCreateBrandJson({ registry: legacy }, deps)).toBeUndefined();
    expect(() => resolveCreateBrandJson({ registry: legacy, brandFile: "/srv/missing.json" }, deps)).toThrow("/srv/missing.json not found");
    expect(() => resolveCreateBrandJson({ registry: legacy, brandFile: "/srv/bad.json" }, deps)).toThrow();
    expect(planCreateBrand({ registry: legacy, layout, slug: "acme", brandFile: "/srv/brand.json" }, deps)).toEqual({ steps: [], env: [] });
    expect(brandCreateNotes({ registry: legacy })).toEqual([]);
  });
});

describe("a create with a reseller", () => {
  const registry = resellerRegistry();

  it("writes root-owned brand files and points the workspace at its merged file", () => {
    const machine = machineWith(registry, { [defaultBrandPath(layout)]: '{"tagline":"Ask us","accent":"#112233"}', "/srv/brand.json": '{"name":"Blue Team"}' });
    const steps = planFleetAction({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"], brandFile: "/srv/brand.json", licenseKey: "omb1.k" }, machine.deps);
    expect(steps.find((step) => step.kind === "mkdir" && step.path === layout.brandsDir)).toEqual({ kind: "mkdir", path: layout.brandsDir, mode: 0o755 });
    const override = writeAt(steps, overrideBrandPath(layout, "acme"))!;
    const merged = writeAt(steps, workspaceBrandPath(layout, "acme"))!;
    expect(override).toEqual({ kind: "write", path: "/etc/openmausbot/brands/acme.override.json", content: '{\n  "name": "Blue Team"\n}\n', mode: 0o644 });
    expect(merged.mode).toBe(0o644);
    expect(merged).not.toHaveProperty("owner");
    expect(JSON.parse(merged.content)).toEqual({ name: "Blue Team", tagline: "Ask us", accent: "#112233" });
    expect(writeAt(steps, "/var/lib/openmausbot/acme/.openmausbot/brand.json")).toBeUndefined();
    const env = writeAt(steps, "/etc/openmausbot/instances/acme.env")!;
    expect(env.content).toContain("OMB_BRAND_FILE=/etc/openmausbot/brands/acme.json\n");
    expect(steps.indexOf(merged)).toBeLessThan(steps.indexOf(env));
    expect(steps.indexOf(override)).toBeLessThan(steps.indexOf(merged));
  });

  it("falls back to the reseller's name with no default and no override, and rewrites a stale override", () => {
    const machine = machineWith(registry, { [overrideBrandPath(layout, "acme")]: '{"name":"Left over from a deleted workspace"}' });
    const steps = planFleetAction({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"] }, machine.deps);
    expect(JSON.parse(writeAt(steps, workspaceBrandPath(layout, "acme"))!.content)).toEqual({ name: "Acme Chat" });
    expect(JSON.parse(writeAt(steps, overrideBrandPath(layout, "acme"))!.content)).toEqual({});
  });

  it("refuses a bad override before any step, naming the field", () => {
    const machine = machineWith(registry, { "/srv/brand.json": '{"name":"Acme","accent":"blue"}', "/srv/json.txt": "{nope" });
    const create = (brandFile: string) => () => planFleetAction({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"], brandFile }, machine.deps);
    expect(create("/srv/brand.json")).toThrow("/srv/brand.json: accent: accent must be a 6-digit hex colour");
    expect(create("/srv/json.txt")).toThrow("/srv/json.txt is not valid JSON");
    expect(create("/srv/missing.json")).toThrow("/srv/missing.json not found");
  });

  it("puts the mail relay into the environment, read at plan time, and keeps it out of the registry and the printed plan", () => {
    const withSmtp = { ...RESELLER, smtp: { urlFile: "/etc/openmausbot/smtp.url", from: "Acme <login@acme.test>" } };
    const machine = machineWith(resellerRegistry([], withSmtp), { "/etc/openmausbot/smtp.url": "smtps://login%40acme.test:hunter2@smtp.acme.test:465\n" });
    const steps = planFleetAction({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"] }, machine.deps);
    const env = writeAt(steps, "/etc/openmausbot/instances/acme.env")!;
    expect(env.content).toContain("OMB_SIGNIN_SMTP_URL=smtps://login%40acme.test:hunter2@smtp.acme.test:465\n");
    expect(env.content).toContain("OMB_SIGNIN_SMTP_FROM=Acme <login@acme.test>\n");
    expect(JSON.stringify(writes(steps).filter((step) => step.path === registryFile))).not.toContain("hunter2");
    expect(JSON.stringify(redactPrintedSteps(steps))).not.toContain("hunter2");
    expect(JSON.stringify(redactPrintedSteps(steps))).toContain("OMB_SIGNIN_SMTP_URL=(read from the reseller");
  });

  it.each([
    ["is missing", null, "is missing or empty"],
    ["is empty", "  \n", "is missing or empty"],
    ["is not a URL", "hunter2", "does not hold an SMTP address"],
    ["is not smtp", "https://smtp.acme.test", "must hold an smtp:// or smtps:// address"],
    ["has a quote", "smtp://u:pa'ss@smtp.acme.test", "percent-encode"],
  ])("refuses a mail relay file that %s without printing it", (_label, content, message) => {
    const withSmtp = { ...RESELLER, smtp: { urlFile: "/etc/openmausbot/smtp.url", from: "Acme <login@acme.test>" } };
    const machine = machineWith(resellerRegistry([], withSmtp), content === null ? {} : { "/etc/openmausbot/smtp.url": content });
    let thrown = "";
    try {
      planFleetAction({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"] }, machine.deps);
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toContain(message);
    expect(thrown).not.toContain("hunter2");
  });

  it("warns on create and brand that a relay login is readable by every workspace, and stays quiet for a relay without one", () => {
    const smtp = { urlFile: "/etc/openmausbot/smtp.url", from: "Acme <login@acme.test>" };
    const registry = resellerRegistry([workspace("acme")], { ...RESELLER, smtp });
    const notesOf = (steps: FleetStep[]) => steps.flatMap((step) => (step.kind === "note" ? [step.text] : []));
    const commands = (machine: ReturnType<typeof machineWith>) => [
      notesOf(planFleetAction({ ...base, action: "create", slug: "beta", admins: ["ada@example.test"], licenseKey: "omb1.k" }, machine.deps)),
      notesOf(planFleetAction({ ...base, action: "brand", slug: "acme", brandPatch: { tagline: "Hi" } }, machine.deps)),
      notesOf(planFleetAction({ ...base, action: "brand", brandDefault: true, brandPatch: { tagline: "Hi" } }, machine.deps)),
    ];
    for (const url of ["smtps://login%40acme.test:hunter2@smtp.acme.test:465", "smtp://relay-hunter2@smtp.acme.test:587"]) {
      for (const notes of commands(machineWith(registry, { [smtp.urlFile]: `${url}\n` }))) {
        const warning = notes.find((text) => text.startsWith("warning: ") && text.includes(smtp.urlFile));
        expect(warning, url).toBeDefined();
        expect(warning).toContain("that workspace's own processes");
        expect(warning).toContain("can read it");
        expect(warning).toContain("smtp://127.0.0.1:25");
        expect(warning).toContain("pins the sender");
        expect(notes.join("\n")).not.toContain("hunter2");
      }
    }
    for (const url of ["smtp://127.0.0.1:25", "smtp://localhost:2525", "smtps://smtp.acme.test:465"]) {
      for (const notes of commands(machineWith(registry, { [smtp.urlFile]: `${url}\n` }))) expect(notes.filter((text) => text.includes(smtp.urlFile) || text.includes("password")), url).toEqual([]);
    }
  });

  it("refuses a sender address that would break the environment file", () => {
    const withSmtp = { ...RESELLER, smtp: { urlFile: "/etc/openmausbot/smtp.url", from: 'Acme "Chat" <login@acme.test>' } };
    const machine = machineWith(resellerRegistry([], withSmtp), { "/etc/openmausbot/smtp.url": "smtp://localhost:25" });
    expect(() => planFleetAction({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"] }, machine.deps)).toThrow("reseller.smtp.from");
  });

  it("explains when the brand will not apply and where sign-in mail goes", () => {
    const withSmtp = { ...RESELLER, smtp: { urlFile: "/etc/openmausbot/smtp.url", from: "login@acme.test" } };
    expect(brandCreateNotes({ registry: resellerRegistry() })).toEqual([
      "no licence key was given: Acme Chat's brand applies only on a workspace whose key grants whitelabel (pass --license-key-file)",
      "warning: sign-in codes go through the OpenMausBot account service, not Acme Chat's own mail; set reseller.smtp in fleet.json, or give each admin access with `openmausbot pair` on the server",
    ]);
    expect(brandCreateNotes({ registry: resellerRegistry(), licenseKey: "omb1.k" })).toHaveLength(1);
    expect(brandCreateNotes({ registry: resellerRegistry([], withSmtp), licenseKey: "omb1.k" })).toEqual([]);
    const machine = machineWith(resellerRegistry());
    const notes = planFleetAction({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"] }, machine.deps).flatMap((step) => (step.kind === "note" ? [step.text] : []));
    expect(notes.at(-2)).toContain("applies only on a workspace whose key grants whitelabel");
    expect(notes.at(-1)).toContain("`openmausbot pair`");
  });
});

describe("the merged file is what the server reads", () => {
  it("applies on a server entitled to whitelabel, and keeps the default brand with a notice otherwise", () => {
    const machine = machineWith(resellerRegistry([workspace("acme")]), { [defaultBrandPath(layout)]: JSON.stringify({ tagline: "Ask us", logo: dataUri("image/png", PNG) }) });
    const steps = planFleetAction({ ...base, action: "brand", slug: "acme", brandPatch: { accent: "#112233" } }, machine.deps);
    const dir = mkdtempSync(join(tmpdir(), "omb-merged-brand-"));
    dirs.push(dir);
    const file = join(dir, "acme.json");
    writeFileSync(file, writeAt(steps, workspaceBrandPath(layout, "acme"))!.content);
    const applied = loadBrand({ file, isEntitled: (feature) => feature === "whitelabel" });
    expect(applied).toMatchObject({ source: "file", brand: { name: "Acme Chat", tagline: "Ask us", accent: "#112233", logo: dataUri("image/png", PNG) } });
    expect(applied.notice).toBeUndefined();
    const refused = loadBrand({ file, isEntitled: () => false });
    expect(refused).toMatchObject({ source: "default", brand: { name: "OpenMausBot" } });
    expect(refused.notice).toContain("not licensed for whitelabel");
  });
});

describe("planning one workspace's brand", () => {
  const registry = resellerRegistry([workspace("acme"), workspace("beta", "retained", 1)]);

  it("saves the override and the merged file, and says no restart is needed", () => {
    const machine = machineWith(registry, { [defaultBrandPath(layout)]: '{"tagline":"Ask us"}', "/etc/openmausbot/instances/acme.env": "OMB_BRAND_FILE=/etc/openmausbot/brands/acme.json\n" });
    const steps = planFleetBrand({ ...base, action: "brand", slug: "acme", brandPatch: { name: "Blue Team", supportUrl: "https://help.acme.test" } }, machine.deps);
    expect(steps.map((step) => step.kind)).toEqual(["mkdir", "write", "write", "note"]);
    expect(JSON.parse(writeAt(steps, overrideBrandPath(layout, "acme"))!.content)).toEqual({ name: "Blue Team", supportUrl: "https://help.acme.test" });
    expect(JSON.parse(writeAt(steps, workspaceBrandPath(layout, "acme"))!.content)).toEqual({ name: "Blue Team", tagline: "Ask us", supportUrl: "https://help.acme.test" });
    expect(steps.at(-1)).toMatchObject({ kind: "note", text: expect.stringContaining('now shows "Blue Team"') });
  });

  it("trims values the way the server will, and clears a field back to the default", () => {
    const machine = machineWith(registry, { [defaultBrandPath(layout)]: '{"tagline":"Ask us"}', [overrideBrandPath(layout, "acme")]: '{"name":"Blue Team","tagline":"Only us"}' });
    const steps = planFleetBrand({ ...base, action: "brand", slug: "acme", brandPatch: { name: "  Red Team  " }, brandClear: ["tagline"] }, machine.deps);
    expect(JSON.parse(writeAt(steps, overrideBrandPath(layout, "acme"))!.content)).toEqual({ name: "Red Team" });
    expect(JSON.parse(writeAt(steps, workspaceBrandPath(layout, "acme"))!.content)).toEqual({ name: "Red Team", tagline: "Ask us" });
  });

  it("warns when the workspace predates the reseller and so never reads the file", () => {
    const machine = machineWith(registry, { "/etc/openmausbot/instances/acme.env": "OMB_PORT=8810\n" });
    const steps = planFleetBrand({ ...base, action: "brand", slug: "acme" }, machine.deps);
    expect(steps.some((step) => step.kind === "note" && step.text.includes("created before this fleet had a reseller"))).toBe(true);
  });

  it.each([
    ["a fleet with no reseller", () => machineWith({ ...registry, reseller: undefined }), { slug: "acme" }, "needs a reseller"],
    ["an unknown workspace", () => machineWith(registry), { slug: "ghost" }, 'no workspace "ghost"'],
    ["a retained workspace", () => machineWith(registry), { slug: "beta" }, "requires operator recovery"],
    ["a bad accent", () => machineWith(registry), { slug: "acme", brandPatch: { accent: "blue" } }, "accent: accent must be a 6-digit hex colour"],
    ["an http support link", () => machineWith(registry), { slug: "acme", brandPatch: { supportUrl: "http://help.acme.test" } }, "supportUrl must be an https:// URL"],
    ["a support link with a password", () => machineWith(registry), { slug: "acme", brandPatch: { supportUrl: "https://u:p@help.acme.test" } }, "must not carry a user name or password"],
    ["a name of 41 characters", () => machineWith(registry), { slug: "acme", brandPatch: { name: "x".repeat(41) } }, "name must be 40 characters or fewer"],
    ["setting and clearing one field", () => machineWith(registry), { slug: "acme", brandPatch: { tagline: "Hi" }, brandClear: ["tagline"] as FleetInput["brandClear"] }, "tagline is both set and cleared"],
    ["a corrupt default file", () => machineWith(registry, { [defaultBrandPath(layout)]: "{nope" }), { slug: "acme" }, "_default.json is not valid JSON"],
    ["an unknown field in the default file", () => machineWith(registry, { [defaultBrandPath(layout)]: '{"colour":"red"}' }), { slug: "acme" }, "colour"],
  ])("refuses %s", (_label, machine, patch, message) => {
    const input = { ...base, action: "brand" as const, ...patch };
    expect(() => planFleetBrand(input, machine().deps)).toThrow(message);
  });

  it("keeps an https logo as given and never reads or fetches it", () => {
    const machine = machineWith(registry);
    let reads = 0;
    machine.deps.readBytes = () => { reads += 1; return null; };
    const steps = planFleetBrand({ ...base, action: "brand", slug: "acme", logoSource: "https://cdn.acme.test/logo.svg" }, machine.deps);
    expect(JSON.parse(writeAt(steps, workspaceBrandPath(layout, "acme"))!.content).logo).toBe("https://cdn.acme.test/logo.svg");
    expect(reads).toBe(0);
    expect(() => planFleetBrand({ ...base, action: "brand", slug: "acme", logoSource: "https://u:p@cdn.acme.test/logo.svg" }, machine.deps)).toThrow("logo must not carry a user name or password");
    expect(() => planFleetBrand({ ...base, action: "brand", slug: "acme", faviconSource: "https://cdn.acme.test/icon.png" }, machine.deps)).toThrow("not fetched");
    expect(() => planFleetBrand({ ...base, action: "brand", slug: "acme", logoSource: "ftp://cdn.acme.test/logo.png" }, machine.deps)).toThrow("--logo takes an image file");
  });
});

describe("what leaves the root process", () => {
  it("drops images from a workspace view, wherever they sit", () => {
    const view = { slug: "acme", logo: "x", brand: { name: "Acme", logo: dataUri("image/png", PNG), favicon: "data:image/png;base64,AA==", accent: "#112233" } };
    expect(omitBrandAssets(view)).toEqual({ slug: "acme", brand: { name: "Acme", accent: "#112233" } });
    expect(view.brand.logo).toContain("data:image");
  });

  it("shortens images in a printed brand file and leaves every other step alone", () => {
    const logo = dataUri("image/png", PNG);
    const steps: FleetStep[] = [
      { kind: "write", path: "/etc/openmausbot/brands/acme.json", content: `${JSON.stringify({ name: "Acme", logo })}\n`, mode: 0o644 },
      { kind: "write", path: "/etc/openmausbot/fleet.json", content: `{"logo":"${logo}"}\n`, mode: 0o600 },
      { kind: "note", text: "hi" },
    ];
    const shown = redactPrintedSteps(steps);
    expect(JSON.stringify(shown[0])).not.toContain(logo);
    expect(JSON.parse((shown[0] as { content: string }).content).logo).toContain("image of about");
    expect(shown.slice(1)).toEqual(steps.slice(1));
  });

  it("builds a brand request from data URIs only and tags every refusal as a bad request", () => {
    const logo = dataUri("image/png", PNG);
    expect(brandInputFromBody(base, { name: "Acme", accent: "#112233", logo, clear: ["tagline"] }, "acme")).toMatchObject({
      action: "brand", slug: "acme", brandDefault: false, brandPatch: { name: "Acme", accent: "#112233" }, brandClear: ["tagline"], logoSource: logo,
    });
    expect(brandInputFromBody(base, {}, undefined)).toMatchObject({ brandDefault: true, slug: undefined, brandPatch: {} });
    const refused = (body: Record<string, unknown>) => { try { brandInputFromBody(base, body, "acme"); } catch (error) { return error as Error & { status?: number }; } throw new Error("accepted"); };
    for (const body of [{ logo: "/etc/passwd" }, { logo: "https://cdn.acme.test/logo.png" }, { favicon: "file:///x" }, { name: 3 }, { clear: ["colour"] }, { clear: "logo" }, { color: "red" }]) {
      expect(refused(body).status, JSON.stringify(body)).toBe(400);
    }
  });
});
