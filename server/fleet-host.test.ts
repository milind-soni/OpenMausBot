import { describe, expect, it } from "vitest";
import { createPlan, deletePlan, describeSteps, emptyRegistry, fleetLayout, parseRegistry, resumePlan, suspendPlan, type FleetRegistry, type FleetStep } from "./fleet.ts";

const layout = fleetLayout("/");
const now = new Date("2026-09-10T08:00:00Z");
const seed = { admins: ["owner@acme.test"], members: [] };
const registry = emptyRegistry("example.test");
const site = (steps: FleetStep[], slug = "acme") => steps.find((step) => step.kind === "write" && step.path === `/etc/caddy/omb.d/${slug}.caddy`);
const env = (steps: FleetStep[], slug = "acme") => steps.find((step) => step.kind === "write" && step.path === `/etc/openmausbot/instances/${slug}.env`);
const registryWrites = (steps: FleetStep[]) => steps.flatMap((step) => (step.kind === "write" && step.path === layout.registryFile ? [JSON.parse(step.content) as FleetRegistry] : []));
const notes = (steps: FleetStep[]) => steps.flatMap((step) => (step.kind === "note" ? [step.text] : []));

describe("a workspace on its own web address", () => {
  const custom = createPlan({ registry, slug: "acme", seed, host: "chat.acme.com", now, layout });

  it("serves the custom address instead of the default", () => {
    expect(custom.workspace.host).toBe("chat.acme.com");
    expect(site(custom.steps)).toMatchObject({ content: expect.stringMatching(/^chat\.acme\.com \{\n/) });
    expect((site(custom.steps) as { content: string }).content).not.toContain("acme.example.test");
    expect((env(custom.steps) as { content: string }).content).toContain("OMB_PUBLIC_URL=https://chat.acme.com\n");
    expect(describeSteps(custom.steps).join("\n")).toContain("serve https://chat.acme.com and fetch its certificate");
    expect(notes(custom.steps)).toContain("https://chat.acme.com is ready; owner@acme.test signs in with an emailed code");
  });

  it("records the address at every registry checkpoint", () => {
    const writes = registryWrites(custom.steps);
    expect(writes.map((written) => written.workspaces.acme?.status)).toEqual(["provisioning", "provisioning", "running"]);
    for (const written of writes) expect(written.workspaces.acme?.host).toBe("chat.acme.com");
    expect(parseRegistry(JSON.stringify(custom.registry)).workspaces.acme?.host).toBe("chat.acme.com");
  });

  it("says where to point the name, only for a custom address", () => {
    expect(notes(custom.steps)).toContain("point chat.acme.com at this server (an A/AAAA record); its certificate is fetched once the name resolves here");
    const plain = createPlan({ registry, slug: "acme", seed, now, layout });
    expect(notes(plain.steps).some((text) => text.startsWith("point "))).toBe(false);
    const explicit = createPlan({ registry, slug: "acme", seed, host: "acme.example.test", now, layout });
    expect(notes(explicit.steps).some((text) => text.startsWith("point "))).toBe(false);
  });

  it("leaves the default plan byte-identical to the one before custom addresses", () => {
    const plain = createPlan({ registry, slug: "acme", seed, now, layout });
    expect(plain.workspace.host).toBe("acme.example.test");
    expect(createPlan({ registry, slug: "acme", seed, host: "acme.example.test", now, layout })).toEqual(plain);
    expect(site(plain.steps)).toMatchObject({ content: expect.stringMatching(/^acme\.example\.test \{\n\tencode zstd gzip\n/) });
    expect((env(plain.steps) as { content: string }).content).toBe([
      "OMB_DATA_DIR=/var/lib/openmausbot/acme/.openmausbot", "OMB_PORT=8810", "OMB_WEBHOOK_PORT=8811", "OMB_PUBLIC_URL=https://acme.example.test", "",
    ].join("\n"));
  });

  it("lowercases the address it serves", () => {
    const plan = createPlan({ registry, slug: "acme", seed, host: "Chat.Acme.COM", now, layout });
    expect(plan.workspace.host).toBe("chat.acme.com");
    expect((site(plan.steps) as { content: string }).content).toMatch(/^chat\.acme\.com \{/);
  });

  it("refuses a bad address before it plans a single step, even when called directly", () => {
    for (const host of ["acme.com\n}", "example.test", "initech.example.test", "10.0.0.1", "*.acme.com"]) {
      expect(() => createPlan({ registry, slug: "acme", seed, host, now, layout })).toThrow();
    }
    const taken = { ...registry, workspaces: custom.registry.workspaces };
    expect(() => createPlan({ registry: taken, slug: "globex", seed, host: "chat.acme.com", now, layout })).toThrow('workspace "acme"');
    expect(() => createPlan({ registry, slug: "acme", seed: { ...seed, portalUrl: "https://admin.example.test" }, host: "chat.acme.com", now, layout })).toThrow("--host cannot be combined with a portal");
  });

  it("keeps the retained workspace's address reserved and refuses the default of an address it holds", () => {
    const retained = deletePlan({ registry: custom.registry, slug: "acme", keepData: true, now, layout }).registry;
    expect(retained.workspaces.acme).toMatchObject({ status: "retained", host: "chat.acme.com" });
    expect(() => createPlan({ registry: retained, slug: "globex", seed, host: "chat.acme.com", now, layout })).toThrow("(retained)");
    const squatting: FleetRegistry = { ...registry, workspaces: { acme: { ...custom.workspace, host: "globex.example.test" } } };
    expect(() => createPlan({ registry: squatting, slug: "globex", seed, now, layout })).toThrow('workspace "acme"');
  });

  it("shows the suspended page on the custom address and takes the site away on delete", () => {
    const suspended = suspendPlan({ registry: custom.registry, slug: "acme", now, layout });
    expect(site(suspended.steps)).toMatchObject({ content: 'chat.acme.com {\n\trespond "This workspace is suspended." 503\n}\n' });
    const resumed = resumePlan({ registry: suspended.registry, slug: "acme", now, layout });
    expect((site(resumed.steps) as { content: string }).content).toMatch(/^chat\.acme\.com \{\n\tencode zstd gzip\n/);
    for (const keepData of [true, false]) {
      const removed = deletePlan({ registry: custom.registry, slug: "acme", keepData, now, layout });
      expect(removed.steps).toContainEqual({ kind: "remove", path: "/etc/caddy/omb.d/acme.caddy" });
      expect(removed.steps.findIndex((step) => step.kind === "remove" && step.path.endsWith("acme.caddy"))).toBeLessThan(removed.steps.findIndex((step) => step.kind === "run" && step.argv[0] === "nft"));
    }
  });

  it("removes a deleted workspace's brand files and keeps a retained workspace's", () => {
    const brandFiles = [{ kind: "remove", path: "/etc/openmausbot/brands/acme.json" }, { kind: "remove", path: "/etc/openmausbot/brands/acme.override.json" }];
    const deleted = deletePlan({ registry: custom.registry, slug: "acme", keepData: false, now, layout });
    for (const step of brandFiles) expect(deleted.steps).toContainEqual(step);
    expect(deleted.steps).not.toContainEqual({ kind: "remove", path: "/etc/openmausbot/brands/_default.json" });
    const retained = deletePlan({ registry: custom.registry, slug: "acme", keepData: true, now, layout });
    for (const step of brandFiles) expect(retained.steps).not.toContainEqual(step);
  });
});
