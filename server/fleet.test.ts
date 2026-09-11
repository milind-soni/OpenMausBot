import { describe, expect, it } from "vitest";
import {
  allocatePort,
  applySignIn,
  assertSlug,
  caddySite,
  createPlan,
  deletePlan,
  describeSteps,
  emptyRegistry,
  fenceRules,
  fleetLayout,
  initPlan,
  initialConfig,
  instanceEnv,
  parseRegistry,
  resumePlan,
  suspendPlan,
  templateUnit,
  upgradePlan,
  type FleetStep,
  type FleetWorkspace,
} from "./fleet.ts";

const layout = fleetLayout("/");
const now = new Date("2026-09-10T08:00:00Z");
const argvOf = (steps: FleetStep[]) => steps.flatMap((step) => (step.kind === "run" ? [step.argv.join(" ")] : []));
const writesOf = (steps: FleetStep[]) => steps.flatMap((step) => (step.kind === "write" ? [step.path] : []));

describe("fleet naming", () => {
  it("accepts DNS-label workspace names and refuses the rest", () => {
    for (const ok of ["acme", "globex-2", "a1"]) expect(() => assertSlug(ok)).not.toThrow();
    for (const bad of ["Acme", "-acme", "a", "acme_inc", "a".repeat(32), "acme.co", "../etc"]) expect(() => assertSlug(bad)).toThrow("not a workspace name");
  });

  it("allocates loopback ports in strides and skips ones already taken", () => {
    const registry = emptyRegistry("agentada.cc");
    expect(allocatePort(registry)).toEqual({ port: 8810, next: 8820 });
    registry.workspaces.acme = { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" };
    registry.nextPort = 8810;
    expect(allocatePort(registry)).toEqual({ port: 8820, next: 8830 });
    expect(() => parseRegistry('{"version":2}')).toThrow("registry");
    expect(parseRegistry(JSON.stringify(registry)).workspaces.acme?.port).toBe(8810);
  });
});

describe("rendered files", () => {
  it("renders one template unit for every workspace, hardened and parameterised by slug", () => {
    const unit = templateUnit({ node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", layout });
    expect(unit).toContain("User=omb-%i");
    expect(unit).toContain("EnvironmentFile=/etc/openmausbot/instances/%i.env");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/openmausbot/cli.js serve --port ${OMB_PORT} --data-dir ${OMB_DATA_DIR} --public-url ${OMB_PUBLIC_URL} --label %i --no-pair");
    for (const line of ["PrivateTmp=yes", "NoNewPrivileges=yes", "ProtectSystem=strict", "ReadWritePaths=/var/lib/openmausbot/%i"]) expect(unit).toContain(line);
    expect(templateUnit({ node: "/usr/bin/node", script: "/src/server/cli.ts", layout })).toContain("--experimental-strip-types /src/server/cli.ts");
  });

  it("fences each workspace's loopback ports to its own user, Caddy and root", () => {
    const rules = fenceRules([
      { slug: "globex", host: "globex.x", port: 8820, webhookPort: 8821, status: "running", createdAt: "" },
      { slug: "acme", host: "acme.x", port: 8810, webhookPort: 8811, status: "running", createdAt: "" },
    ]);
    expect(rules).toContain("add table inet openmausbot\nflush table inet openmausbot");
    expect(rules.indexOf("omb-acme")).toBeLessThan(rules.indexOf("omb-globex"));
    expect(rules).toContain("oif lo tcp dport { 8810, 8811 } meta skuid != { omb-acme, caddy, root } reject");
    expect(fenceRules([])).not.toContain("reject");
  });

  it("serves a running workspace and answers 503 for a suspended one", () => {
    const running = caddySite({ host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running" });
    expect(running).toContain("acme.agentada.cc {");
    expect(running).toContain("reverse_proxy 127.0.0.1:8811");
    expect(running).toContain("reverse_proxy 127.0.0.1:8810 {");
    expect(running).toContain("flush_interval -1");
    expect(caddySite({ host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "suspended" })).toContain('respond "This workspace is suspended." 503');
  });

  it("writes the environment, the first config and the sign-in edits the server reads live", () => {
    const workspace: FleetWorkspace = { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" };
    expect(instanceEnv({ workspace, dataDir: "/var/lib/openmausbot/acme/.openmausbot", licenseKey: "omb1.k" })).toBe(
      "OMB_DATA_DIR=/var/lib/openmausbot/acme/.openmausbot\nOMB_PORT=8810\nOMB_WEBHOOK_PORT=8811\nOMB_PUBLIC_URL=https://acme.agentada.cc\nOMB_LICENSE_KEY=omb1.k\n",
    );
    expect(JSON.parse(initialConfig({ admins: ["ada@example.test"], members: ["@acme.test"], anthropicKey: "sk-ant-x", monthlyCapUsd: 50 }))).toEqual({
      signIn: { admins: ["ada@example.test"], members: ["@acme.test"] }, anthropic: { key: "sk-ant-x" }, budgets: { monthlyUsd: 50 },
    });
    const added = applySignIn('{"anthropic":{"key":"k"},"signIn":{"admins":["ada@example.test"]}}', "add", "Bob@Acme.test", true);
    expect(JSON.parse(added.config)).toEqual({ anthropic: { key: "k" }, signIn: { admins: ["ada@example.test"], members: ["bob@acme.test"] } });
    expect(added.summary).toContain("chat and approvals");
    const removed = applySignIn(added.config, "remove", "bob@acme.test", false);
    expect(JSON.parse(removed.config).signIn).toEqual({ admins: ["ada@example.test"], members: [] });
    expect(() => applySignIn(added.config, "remove", "nobody@acme.test", false)).toThrow("not on the list");
    expect(() => applySignIn("{}", "add", "not an email", false)).toThrow("email");
  });
});

describe("plans", () => {
  it("initialises the server once: folders, registry, templates, fence, the Caddy import, and reloads", () => {
    const { steps, registry } = initPlan({ domain: "AgentAda.cc", node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", layout });
    expect(registry).toEqual({ version: 1, domain: "agentada.cc", nextPort: 8810, workspaces: {} });
    expect(writesOf(steps)).toEqual(["/etc/openmausbot/fleet.json", "/etc/systemd/system/openmausbot@.service", "/etc/openmausbot/fence.nft", "/etc/systemd/system/openmausbot-fence.service"]);
    expect(steps.find((step) => step.kind === "append-once")).toEqual({ kind: "append-once", path: "/etc/caddy/Caddyfile", line: "import /etc/caddy/omb.d/*.caddy" });
    expect(argvOf(steps)).toEqual(["systemctl daemon-reload", "systemctl enable --now openmausbot-fence.service", "systemctl reload caddy"]);
    expect(() => initPlan({ domain: "not a domain", node: "n", script: "s", layout })).toThrow("domain name");
    // with an operator, the agent unit is written and started, and the registry remembers who
    const withAgent = initPlan({ domain: "agentada.cc", node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", operator: "maus", layout });
    expect(withAgent.registry.operator).toBe("maus");
    const agent = withAgent.steps.find((step) => step.kind === "write" && step.path === "/etc/systemd/system/openmausbot-fleet.service");
    expect(agent).toMatchObject({ content: expect.stringContaining("fleet agent --socket /run/openmausbot/fleet.sock --group maus") });
    expect(agent).toMatchObject({ content: expect.stringContaining("RuntimeDirectory=openmausbot") });
    expect(argvOf(withAgent.steps)).toContain("systemctl enable --now openmausbot-fleet.service");
    expect(() => initPlan({ domain: "agentada.cc", node: "n", script: "s", operator: "Not A User", layout })).toThrow("Unix user");
  });

  it("creates a workspace as its own account with private data, a fenced port, a unit and a site", () => {
    const registry = emptyRegistry("agentada.cc");
    const plan = createPlan({ registry, slug: "acme", seed: { admins: ["ada@example.test"], members: [] }, licenseKey: "omb1.k", memoryMax: "1G", now, layout });
    expect(plan.workspace).toEqual({ slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: now.toISOString() });
    expect(plan.registry.nextPort).toBe(8820);
    expect(argvOf(plan.steps)).toEqual([
      "useradd --system --create-home --home-dir /var/lib/openmausbot/acme --shell /usr/sbin/nologin --user-group omb-acme",
      "nft -f /etc/openmausbot/fence.nft",
      "systemctl daemon-reload",
      "systemctl enable --now openmausbot@acme.service",
      "systemctl reload caddy",
    ]);
    const config = plan.steps.find((step) => step.kind === "write" && step.path.endsWith("/acme/.openmausbot/config.json"));
    expect(config).toMatchObject({ mode: 0o600, owner: "omb-acme" });
    const env = plan.steps.find((step) => step.kind === "write" && step.path === "/etc/openmausbot/instances/acme.env");
    expect(env).toMatchObject({ mode: 0o600 });
    // root keeps the environment file: it carries the licence key
    expect(env).not.toHaveProperty("owner");
    expect(plan.steps.find((step) => step.kind === "write" && step.path.endsWith("limits.conf"))).toMatchObject({ content: "[Service]\nMemoryMax=1G\n" });
    expect(plan.steps.find((step) => step.kind === "health")).toMatchObject({ url: "http://127.0.0.1:8810/api/health" });
    // the health wait sits between starting the unit and exposing it through Caddy
    const sequence = plan.steps.flatMap((step) => (step.kind === "run" ? [step.argv[0] === "systemctl" ? step.argv.slice(0, 2).join(" ") : step.argv[0]] : step.kind === "health" ? ["health"] : []));
    expect(sequence).toEqual(["useradd", "nft", "systemctl daemon-reload", "systemctl enable", "health", "systemctl reload"]);
    expect(plan.steps.at(-1)).toMatchObject({ kind: "note", text: expect.stringContaining("https://acme.agentada.cc is ready") });
    expect(() => createPlan({ registry: plan.registry, slug: "acme", seed: { admins: ["x@y.test"], members: [] }, layout })).toThrow("already exists");
    expect(() => createPlan({ registry, slug: "beta", seed: { admins: [], members: [] }, layout })).toThrow("at least one admin");
    expect(() => createPlan({ registry, slug: "beta", seed: { admins: ["x@y.test"], members: [] }, memoryMax: "lots", layout })).toThrow("--memory");
  });

  it("suspends, resumes, deletes and upgrades with the registry kept in step", () => {
    const created = createPlan({ registry: emptyRegistry("agentada.cc"), slug: "acme", seed: { admins: ["a@b.test"], members: [] }, now, layout });
    const suspended = suspendPlan({ registry: created.registry, slug: "acme", layout });
    expect(suspended.registry.workspaces.acme?.status).toBe("suspended");
    expect(argvOf(suspended.steps)).toEqual(["systemctl disable --now openmausbot@acme.service", "systemctl reload caddy"]);
    expect(suspended.steps.find((step) => step.kind === "write" && step.path.endsWith("acme.caddy"))).toMatchObject({ content: expect.stringContaining("503") });
    const resumed = resumePlan({ registry: suspended.registry, slug: "acme", layout });
    expect(resumed.registry.workspaces.acme?.status).toBe("running");
    expect(argvOf(resumed.steps)).toEqual(["systemctl enable --now openmausbot@acme.service", "systemctl reload caddy"]);
    const kept = deletePlan({ registry: resumed.registry, slug: "acme", keepData: true, layout });
    expect(kept.registry.workspaces).toEqual({});
    expect(argvOf(kept.steps)).toContain("userdel omb-acme");
    expect(argvOf(deletePlan({ registry: resumed.registry, slug: "acme", keepData: false, layout }).steps)).toContain("userdel --remove omb-acme");
    expect(() => deletePlan({ registry: kept.registry, slug: "acme", keepData: true, layout })).toThrow('no workspace "acme"');
    const two = createPlan({ registry: created.registry, slug: "globex", seed: { admins: ["g@x.test"], members: [] }, now, layout }).registry;
    expect(argvOf(upgradePlan({ registry: suspendPlan({ registry: two, slug: "globex", layout }).registry }))).toEqual(["npm install -g openmausbot@latest", "systemctl restart openmausbot@acme.service"]);
  });

  it("describes a plan as lines a root shell can run, quoting only what needs it", () => {
    const lines = describeSteps([
      { kind: "mkdir", path: "/var/lib/openmausbot/acme/.openmausbot", mode: 0o700, owner: "omb-acme" },
      { kind: "write", path: "/etc/openmausbot/instances/acme.env", content: "OMB_PORT=8810\n", mode: 0o600 },
      { kind: "run", argv: ["useradd", "--comment", "Acme Inc", "omb-acme"], why: "the account" },
      { kind: "append-once", path: "/etc/caddy/Caddyfile", line: "import /etc/caddy/omb.d/*.caddy" },
      { kind: "note", text: "done" },
    ]);
    expect(lines).toEqual([
      "install -d -m 700 -o omb-acme -g omb-acme /var/lib/openmausbot/acme/.openmausbot",
      "cat > /etc/openmausbot/instances/acme.env <<'OMB_EOF'",
      "OMB_PORT=8810",
      "OMB_EOF",
      "chmod 600 /etc/openmausbot/instances/acme.env",
      "useradd --comment 'Acme Inc' omb-acme   # the account",
      "grep -qxF 'import /etc/caddy/omb.d/*.caddy' /etc/caddy/Caddyfile || printf '\\n%s\\n' 'import /etc/caddy/omb.d/*.caddy' >> /etc/caddy/Caddyfile",
      "# done",
    ]);
  });
});
