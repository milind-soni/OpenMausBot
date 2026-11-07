import { describe, expect, it } from "vitest";
import { runFleetCommand, type FleetInput } from "./fleet-cli.ts";
import { emptyRegistry, fleetLayout, type FleetWorkspace } from "./fleet.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";

const layout = fleetLayout("/");
const base: FleetInput = {
  action: "create", slug: "acme", admins: ["owner@acme.test"], members: [], dryRun: false, yes: false, keepData: false,
  node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", root: "/",
};
const entry = (slug: string, host: string, status: FleetWorkspace["status"]): FleetWorkspace => ({ slug, host, port: 8810, webhookPort: 8811, status, createdAt: "2026-09-10T08:00:00.000Z" });

function fixture(workspaces: Record<string, FleetWorkspace> = {}, options: { root?: boolean } = {}) {
  const machine = fleetMachine("/", options);
  machine.files.set(layout.registryFile, JSON.stringify({ ...emptyRegistry("example.test"), workspaces }));
  const out: string[] = [];
  const err: string[] = [];
  const io = { log: (line: string) => out.push(line), error: (line: string) => err.push(line) };
  return { ...machine, io, out, err, registry: () => JSON.parse(machine.files.get(layout.registryFile)!) };
}

describe("fleet create --host", () => {
  it("prints the custom site block and the DNS note on a dry run, and touches nothing", async () => {
    const m = fixture();
    expect(await runFleetCommand({ ...base, host: "Chat.Acme.test", dryRun: true }, m.io, m.deps)).toBe(0);
    const text = m.out.join("\n");
    expect(text).toContain("chat.acme.test {");
    expect(text).toContain("OMB_PUBLIC_URL=https://chat.acme.test");
    expect(text).toContain("# point chat.acme.test at this server");
    expect(text).not.toContain("acme.example.test");
    expect(m.calls).toEqual([]);
  });

  it("prints the default plan with no DNS note when no host is given", async () => {
    const m = fixture();
    expect(await runFleetCommand({ ...base, dryRun: true }, m.io, m.deps)).toBe(0);
    expect(m.out.join("\n")).toContain("acme.example.test {");
    expect(m.out.join("\n")).not.toContain("# point ");
  });

  it("creates the workspace on the custom host as root", async () => {
    const m = fixture({}, { root: true });
    expect(await runFleetCommand({ ...base, host: "chat.acme.test" }, m.io, m.deps)).toBe(0);
    expect(m.registry().workspaces.acme).toMatchObject({ host: "chat.acme.test", status: "running" });
    expect(m.files.get("/etc/caddy/omb.d/acme.caddy")).toMatch(/^chat\.acme\.test \{/);
    expect(m.files.get("/etc/openmausbot/instances/acme.env")).toContain("OMB_PUBLIC_URL=https://chat.acme.test\n");
    expect(m.out.at(-2)).toContain("https://chat.acme.test is ready");
    m.out.length = 0;
    expect(await runFleetCommand({ ...base, action: "list" }, m.io, m.deps)).toBe(0);
    expect(m.out[0]).toContain("https://chat.acme.test");
  });

  it("exits 2 and runs nothing when another workspace holds the host", async () => {
    for (const status of ["running", "suspended", "retained", "error", "provisioning"] as const) {
      const m = fixture({ globex: entry("globex", "chat.acme.test", status) }, { root: true });
      const before = m.files.get(layout.registryFile);
      expect(await runFleetCommand({ ...base, host: "CHAT.acme.test" }, m.io, m.deps)).toBe(2);
      expect(m.err[0]).toContain(`fleet: chat.acme.test is already the web address of workspace "globex" (${status})`);
      expect(m.calls).toEqual([]);
      expect(m.files.get(layout.registryFile)).toBe(before);
      expect([...m.files.keys()]).toEqual([layout.registryFile]);
    }
  });

  it("exits 2 and runs nothing for an address that is not a plain public name", async () => {
    for (const host of ["example.test", "initech.example.test", "localhost", "10.0.0.1", "*.acme.test", "acme.test:8443", "acme.test/x", "acme.test\n}", "acme.test."]) {
      const m = fixture({}, { root: true });
      expect(await runFleetCommand({ ...base, host }, m.io, m.deps)).toBe(2);
      expect(m.calls).toEqual([]);
      expect(m.err).toHaveLength(1);
      expect(m.err[0]).not.toContain("\n");
    }
  });

  it("refuses a custom host with a portal and a new name whose default is held, without running anything", async () => {
    const m = fixture({ chat: entry("chat", "initech.example.test", "running") }, { root: true });
    expect(await runFleetCommand({ ...base, host: "chat.acme.test", portalUrl: "https://admin.example.test" }, m.io, m.deps)).toBe(2);
    expect(m.err[0]).toContain("cannot be combined with a portal");
    expect(await runFleetCommand({ ...base, slug: "initech" }, m.io, m.deps)).toBe(2);
    expect(m.err[1]).toContain('workspace "chat"');
    expect(m.calls).toEqual([]);
  });
});
