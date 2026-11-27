import { describe, expect, it } from "vitest";
import { markProvisioningFailed, runFleetCommand, type FleetDeps, type FleetInput } from "./fleet-cli.ts";
import { emptyRegistry, fenceRules, MANAGED_OPENROUTER, type FleetWorkspace } from "./fleet.ts";

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
    pathExists: (path) => files.has(path),
    usage: () => ({ turns: 0, costUsd: null, billableUsd: null }),
    readText: (path, owner) => { if (owner) calls.push(`read ${path} as ${owner}`); return files.get(path) ?? null; },
    writeText: (path, content, mode, owner) => { calls.push(`write ${path} ${mode.toString(8)}${owner ? ` as ${owner}` : ""}`); files.set(path, content); },
    mkdir: (path, mode, owner) => { calls.push(`mkdir ${path} ${mode.toString(8)}${owner ? ` as ${owner}` : ""}`); },
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
  it("updates only managed OpenRouter models and rejects missing, malformed or redirected config", async () => {
    const workspace: FleetWorkspace = { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" };
    const path = "/var/lib/openmausbot/acme/.config/opencode/opencode.json";
    const cfgPath = "/var/lib/openmausbot/acme/.openmausbot/config.json";
    const config = { model: "my-own-default", provider: { unrelated: { models: { keep: {} } }, [MANAGED_OPENROUTER]: {
      npm: "@ai-sdk/openai-compatible", name: "Keep this name", options: { baseURL: "https://admin.example.test/api/gateway/acme/openrouter/v1", apiKey: "scoped-secret" }, models: { "old/model": { name: "Old" } },
    } } };
    const initialFiles = { ...withRegistry({ acme: workspace }), [path]: JSON.stringify(config), [cfgPath]: '{"defaultModelSelection":{"instanceId":"claude","model":"keep"}}', "/etc/openmausbot/instances/acme.env": "OMB_ADMIN_URL=https://admin.example.test\nOMB_ADMIN_WORKSPACE=acme\n" };
    const m = machine({ root: true, files: initialFiles });
    const output = io();
    const input: FleetInput = { ...base, action: "providers", slug: "acme", openrouterModels: ["next/model", "next/model"] };
    expect(await runFleetCommand(input, output.io, m.deps)).toBe(0);
    expect(JSON.parse(m.files.get(path)!)).toEqual({ ...config, provider: { ...config.provider, [MANAGED_OPENROUTER]: { ...config.provider[MANAGED_OPENROUTER], models: { "next/model": { name: "next/model" } } } } });
    expect(m.files.get(cfgPath)).toBe(initialFiles[cfgPath]);
    expect(m.calls).toEqual([`read ${path} as omb-acme`, `write ${path} 600 as omb-acme`]);
    expect(output.out.join("\n") + output.err.join("\n")).not.toContain("scoped-secret");
    expect(await runFleetCommand({ ...input, openrouterModels: [] }, output.io, m.deps)).toBe(0);
    expect(JSON.parse(m.files.get(path)!).provider[MANAGED_OPENROUTER].models).toEqual({});
    for (const raw of [undefined, '{"secret":"scoped-secret",', '[]', '{}', JSON.stringify({ ...config, provider: { [MANAGED_OPENROUTER]: { ...config.provider[MANAGED_OPENROUTER], options: { apiKey: "scoped-secret", baseURL: "https://other.example.test" } } } })]) {
      const bad = machine({ root: true, files: initialFiles });
      if (raw === undefined) bad.files.delete(path); else bad.files.set(path, raw);
      const log = io();
      expect(await runFleetCommand(input, log.io, bad.deps)).toBe(2);
      expect(bad.files.get(path)).toBe(raw);
      expect(bad.calls.every((call) => call.startsWith("read "))).toBe(true);
      expect(log.err.join("\n")).not.toContain("scoped-secret");
    }
  });

  it("prints the plan instead of acting when not root, and on --dry-run even as root", async () => {
    const { deps, calls } = machine();
    const { io: log, out } = io();
    expect(await runFleetCommand({ ...base, action: "init", domain: "agentada.cc" }, log, deps)).toBe(0);
    expect(out[0]).toBe("not running as root; inspect this plan, then rerun the fleet command as root without --dry-run (with --yes where required):");
    expect(out.join("\n")).toContain("cat > /etc/systemd/system/openmausbot@.service <<'OMB_EOF'");
    expect(out.join("\n")).toContain("systemctl enable --now openmausbot-fence.service");
    expect(calls).toEqual([]);

    const rooted = machine({ root: true, files: withRegistry() });
    const dry = io();
    expect(await runFleetCommand({ ...base, action: "create", slug: "acme", admins: ["ada@example.test"], dryRun: true }, dry.io, rooted.deps)).toBe(0);
    expect(dry.out[0]).toBe("dry run; inspect this plan, then rerun the fleet command as root without --dry-run (with --yes where required):");
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
    expect(calls.slice(0, 5)).toEqual([
      `write ${registryFile} 600`,
      "run useradd --system --create-home --home-dir /var/lib/openmausbot/acme --shell /usr/sbin/nologin --user-group omb-acme",
      `write ${registryFile} 600`,
      "mkdir /var/lib/openmausbot/acme/.openmausbot 700 as omb-acme",
      "write /var/lib/openmausbot/acme/.openmausbot/config.json 600 as omb-acme",
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
    expect(JSON.parse(broken.files.get(registryFile)!).workspaces.beta).toMatchObject({ status: "error", accountCreated: true });
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
    expect(ready.calls.some((call) => call.startsWith("run userdel"))).toBe(false);
    expect(JSON.parse(ready.files.get(registryFile)!).workspaces.acme).toMatchObject({ status: "retained" });
  });

  it("edits a workspace's sign-in list in place, owned by the workspace, and lists what runs", async () => {
    const dataFile = "/var/lib/openmausbot/acme/.openmausbot/config.json";
    const ready = machine({ root: true, files: { ...withRegistry({ acme: { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" } }), [dataFile]: '{"signIn":{"admins":["ada@example.test"]}}' } });
    const added = io();
    expect(await runFleetCommand({ ...base, action: "users", slug: "acme", userAction: "add", email: "Bob@Acme.test", chatOnly: true }, added.io, ready.deps)).toBe(0);
    expect(JSON.parse(ready.files.get(dataFile)!).signIn).toEqual({ admins: ["ada@example.test"], members: ["bob@acme.test"] });
    expect(ready.calls).toContain(`read ${dataFile} as omb-acme`);
    expect(ready.calls).toContain(`write ${dataFile} 600 as omb-acme`);
    expect(ready.calls.some((call) => call.startsWith("run chown"))).toBe(false);
    expect(added.out.at(-1)).toContain("bob@acme.test can sign in");
    const listed = io();
    expect(await runFleetCommand({ ...base, action: "list" }, listed.io, ready.deps)).toBe(0);
    expect(listed.out[0]).toMatch(/^acme\s+https:\/\/acme\.agentada\.cc\s+:8810\s+active$/);
  });

  it("reinitializes templates without losing the operator, reservations, ports or fence", async () => {
    const workspaces: Record<string, FleetWorkspace> = {
      alpha: { slug: "alpha", host: "alpha.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" },
      beta: { slug: "beta", host: "beta.agentada.cc", port: 8820, webhookPort: 8821, status: "suspended", createdAt: "" },
      old: { slug: "old", host: "old.agentada.cc", port: 8830, webhookPort: 8831, status: "retained", createdAt: "" },
    };
    const prior = { ...emptyRegistry("agentada.cc"), operator: "maus", nextPort: 8840, workspaces };
    const ready = machine({ root: true, files: { [registryFile]: JSON.stringify(prior) } });
    const result = io();
    expect(await runFleetCommand({ ...base, action: "init", domain: "fresh.example.test", yes: true }, result.io, ready.deps)).toBe(0);
    expect(JSON.parse(ready.files.get(registryFile)!)).toEqual({ ...prior, domain: "fresh.example.test" });
    expect(ready.files.get("/etc/openmausbot/fence.nft")).toBe(fenceRules(Object.values(workspaces)));
    expect(ready.files.get("/etc/systemd/system/openmausbot-fleet.service")).toContain("--group maus");
    expect(ready.calls).toContain("run nft -f /etc/openmausbot/fence.nft");
    expect(await runFleetCommand({ ...base, action: "init", domain: "fresh.example.test", operator: "newadmin", yes: true }, io().io, ready.deps)).toBe(0);
    expect(JSON.parse(ready.files.get(registryFile)!).operator).toBe("newadmin");
  });

  it.each(["/var/lib/openmausbot/acme", "/etc/openmausbot/instances/acme.env", "/etc/caddy/omb.d/acme.caddy", "/etc/systemd/system/openmausbot@acme.service.d"])("refuses residual customer path %s before taking action", async (path) => {
    const ready = machine({ root: true, files: { ...withRegistry(), [path]: "retained data" } });
    const result = io();
    expect(await runFleetCommand({ ...base, action: "create", slug: "acme", admins: ["a@example.test"] }, result.io, ready.deps)).toBe(2);
    expect(result.err.join("\n")).toContain("workspace path already exists");
    expect(ready.calls).toEqual([]);
    expect(ready.files.get(path)).toBe("retained data");
  });

  it("only marks a pending create failed, retaining its checkpoint", () => {
    const workspace = { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "provisioning", accountCreated: true, createdAt: "" };
    const ready = machine({ files: withRegistry({ acme: workspace }) });
    markProvisioningFailed({ ...base, action: "create", slug: "acme" }, ready.deps);
    expect(JSON.parse(ready.files.get(registryFile)!).workspaces.acme).toEqual({ ...workspace, status: "error" });
    const writes = ready.calls.length;
    markProvisioningFailed({ ...base, action: "create", slug: "acme" }, ready.deps);
    markProvisioningFailed({ ...base, action: "delete", slug: "acme" }, ready.deps);
    expect(ready.calls).toHaveLength(writes);
  });

  it.each(["provisioning", "error", "retained"])("lists a %s reservation accurately and rejects duplicate creation before residual paths", async (status) => {
    const ready = machine({ root: true, files: { ...withRegistry({ acme: { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status, createdAt: "" } }), "/etc/openmausbot/instances/acme.env": "retained" } });
    const listed = io();
    expect(await runFleetCommand(base, listed.io, ready.deps)).toBe(0);
    expect(listed.out[0]).toContain(status);
    const duplicate = io();
    expect(await runFleetCommand({ ...base, action: "create", slug: "acme", admins: ["a@example.test"] }, duplicate.io, ready.deps)).toBe(2);
    expect(duplicate.err.join("\n")).toContain('workspace "acme" already exists');
    expect(ready.calls).toEqual([]);
  });
});
