import { describe, expect, it } from "vitest";
import { runFleetCommand, type FleetDeps, type FleetInput } from "./fleet-cli.ts";
import { emptyRegistry } from "./fleet.ts";

// A machine that records what the CLI would do to it. Nothing here touches
// the real filesystem, systemd, nftables or Caddy.
function machine(options: { root?: boolean; files?: Record<string, string>; failing?: string[] } = {}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const calls: string[] = [];
  const deps: FleetDeps = {
    isRoot: () => options.root ?? false,
    run: async (argv) => {
      calls.push(`run ${argv.join(" ")}`);
      const failing = options.failing?.some((prefix) => argv.join(" ").startsWith(prefix));
      if (argv[0] === "systemctl" && argv[1] === "is-active") return { code: 0, output: "active\n" };
      return failing ? { code: 1, output: "Failed to start: boom secret-token\n" } : { code: 0, output: "" };
    },
    readText: (path) => files.get(path) ?? null,
    writeText: (path, content, mode) => { calls.push(`write ${path} ${mode.toString(8)}`); files.set(path, content); },
    mkdir: (path, mode) => { calls.push(`mkdir ${path} ${mode.toString(8)}`); },
    appendOnce: (path, line) => { calls.push(`append ${path} ${line}`); },
    remove: (path) => { calls.push(`remove ${path}`); files.delete(path); },
    health: async (url) => { calls.push(`health ${url}`); return !options.failing?.includes("health"); },
  };
  return { deps, calls, files };
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) }, out, err };
};

const base: FleetInput = {
  action: "list", admins: [], members: [], dryRun: false, yes: false, keepData: false,
  node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", root: "/",
};
const registryFile = "/etc/openmausbot/fleet.json";
const withRegistry = (workspaces = {}) => ({ [registryFile]: JSON.stringify({ ...emptyRegistry("agentada.cc"), workspaces }) });

describe("openmausbot fleet", () => {
  it("prints the plan instead of acting when not root, and on --dry-run even as root", async () => {
    const { deps, calls } = machine();
    const { io: log, out } = io();
    expect(await runFleetCommand({ ...base, action: "init", domain: "agentada.cc" }, log, deps)).toBe(0);
    expect(out[0]).toBe("not running as root; run these as root:");
    expect(out.join("\n")).toContain("cat > /etc/systemd/system/openmausbot@.service <<'OMB_EOF'");
    expect(out.join("\n")).toContain("systemctl enable --now openmausbot-fence.service");
    expect(calls).toEqual([]);

    const rooted = machine({ root: true, files: withRegistry() });
    const dry = io();
    expect(await runFleetCommand({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"], dryRun: true }, dry.io, rooted.deps)).toBe(0);
    expect(dry.out[0]).toBe("dry run; run these as root:");
    expect(dry.out.join("\n")).toContain("useradd --system --create-home --home-dir /var/lib/openmausbot/acme");
    expect(rooted.calls).toEqual([]);
  });

  it("refuses an npx cache as the unit's script and asks for the domain", async () => {
    const { deps } = machine({ root: true });
    const bad = io();
    expect(await runFleetCommand({ ...base, action: "init", domain: "agentada.cc", script: "/root/.npm/_npx/abc/node_modules/openmausbot/cli.js" }, bad.io, deps)).toBe(2);
    expect(bad.err[0]).toMatch(/npx|permanently/);
    const missing = io();
    expect(await runFleetCommand({ ...base, action: "init" }, missing.io, deps)).toBe(2);
    expect(missing.err[0]).toContain("--domain");
  });

  it("creates a workspace as root in order, and stops at the first failed step without repeating secrets", async () => {
    const { deps, calls, files } = machine({ root: true, files: { ...withRegistry(), "/srv/brand.json": '{"name":"Acme"}', "/srv/key.txt": "sk-ant-fixture\n" } });
    const { io: log, out } = io();
    const code = await runFleetCommand({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"], members: ["@acme.test"], brandFile: "/srv/brand.json", anthropicKeyFile: "/srv/key.txt", cap: 40, licenseKey: "omb1.k" }, log, deps);
    expect(code).toBe(0);
    expect(calls.slice(0, 4)).toEqual([
      "run useradd --system --create-home --home-dir /var/lib/openmausbot/acme --shell /usr/sbin/nologin --user-group omb-acme",
      "mkdir /var/lib/openmausbot/acme/.openmausbot 700",
      "run chown omb-acme:omb-acme /var/lib/openmausbot/acme/.openmausbot",
      "write /var/lib/openmausbot/acme/.openmausbot/config.json 600",
    ]);
    expect(JSON.parse(files.get("/var/lib/openmausbot/acme/.openmausbot/config.json")!)).toEqual({
      signIn: { admins: ["ada@example.test"], members: ["@acme.test"] }, anthropic: { key: "sk-ant-fixture" }, budgets: { monthlyUsd: 40 },
    });
    expect(files.get("/var/lib/openmausbot/acme/.openmausbot/brand.json")).toBe('{"name":"Acme"}');
    expect(files.get("/etc/openmausbot/instances/acme.env")).toContain("OMB_LICENSE_KEY=omb1.k");
    expect(calls).toContain("health http://127.0.0.1:8810/api/health");
    expect(calls.at(-1)).toBe(`write ${registryFile} 600`);
    expect(JSON.parse(files.get(registryFile)!).workspaces.acme).toMatchObject({ port: 8810, host: "acme.agentada.cc" });
    expect(out.at(-1)).toContain("https://acme.agentada.cc is ready");

    const broken = machine({ root: true, files: withRegistry(), failing: ["systemctl enable"] });
    const failed = io();
    expect(await runFleetCommand({ ...base, action: "create", slug: "beta", admins: ["b@example.test"] }, failed.io, broken.deps)).toBe(1);
    expect(failed.err[0]).toContain("could not start the workspace now and at boot");
    expect(failed.err.join("\n")).toContain("boom");
    expect(broken.calls.some((call) => call.startsWith("health"))).toBe(false);
    expect(broken.files.get(registryFile)).toBe(withRegistry()[registryFile]);
  });

  it("needs an initialised fleet, a known workspace, and --yes before deleting", async () => {
    const { deps } = machine({ root: true });
    const none = io();
    expect(await runFleetCommand({ ...base, action: "create", slug: "acme", admins: ["a@b.test"] }, none.io, deps)).toBe(2);
    expect(none.err[0]).toContain("fleet init");
    const ready = machine({ root: true, files: withRegistry({ acme: { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" } }) });
    const unknown = io();
    expect(await runFleetCommand({ ...base, action: "suspend", slug: "nope" }, unknown.io, ready.deps)).toBe(2);
    expect(unknown.err[0]).toContain('no workspace "nope"');
    const unconfirmed = io();
    expect(await runFleetCommand({ ...base, action: "delete", slug: "acme" }, unconfirmed.io, ready.deps)).toBe(2);
    expect(unconfirmed.err[0]).toContain("--yes");
    expect(ready.calls).toEqual([]);
    const confirmed = io();
    expect(await runFleetCommand({ ...base, action: "delete", slug: "acme", yes: true, keepData: true }, confirmed.io, ready.deps)).toBe(0);
    expect(ready.calls).toContain("run userdel omb-acme");
    expect(JSON.parse(ready.files.get(registryFile)!).workspaces).toEqual({});
  });

  it("edits a workspace's sign-in list in place, owned by the workspace, and lists what runs", async () => {
    const dataFile = "/var/lib/openmausbot/acme/.openmausbot/config.json";
    const ready = machine({ root: true, files: { ...withRegistry({ acme: { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" } }), [dataFile]: '{"signIn":{"admins":["ada@example.test"]}}' } });
    const added = io();
    expect(await runFleetCommand({ ...base, action: "users", slug: "acme", userAction: "add", email: "Bob@Acme.test", chatOnly: true }, added.io, ready.deps)).toBe(0);
    expect(JSON.parse(ready.files.get(dataFile)!).signIn).toEqual({ admins: ["ada@example.test"], members: ["bob@acme.test"] });
    expect(ready.calls).toContain(`run chown omb-acme:omb-acme ${dataFile}`);
    expect(added.out.at(-1)).toContain("bob@acme.test can sign in");
    const listed = io();
    expect(await runFleetCommand({ ...base, action: "list" }, listed.io, ready.deps)).toBe(0);
    expect(listed.out[0]).toMatch(/^acme\s+https:\/\/acme\.agentada\.cc\s+:8810\s+active$/);
  });
});
