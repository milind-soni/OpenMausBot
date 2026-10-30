import { describe, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { loadEnvironmentId } from "./environment.ts";
import {
  VPS_CONTAINER_LABEL,
  VPS_ENVIRONMENT_LABEL,
  VPS_MANAGED_LABEL,
  listManagedVpsComputers,
  removeManagedVpsComputer,
  vpsContainerName,
  type ManagedVpsOwner,
  type VpsCommandRunner,
} from "./vps-computer.ts";

const CONFIG: AppConfig = { vps: { sshAlias: "production-vps" } };
const OWNER: ManagedVpsOwner = { botId: "bot-current", name: "Research", inUse: false };
const LOCAL_ENVIRONMENT_ID = loadEnvironmentId(DATA_DIR);

function labels(name: string, environmentId: string | null = LOCAL_ENVIRONMENT_ID): Record<string, string> {
  return {
    [VPS_MANAGED_LABEL]: "1",
    [VPS_CONTAINER_LABEL]: name,
    ...(environmentId ? { [VPS_ENVIRONMENT_LABEL]: environmentId } : {}),
  };
}

interface ContainerFixture {
  id: string;
  name: string;
  state?: string;
  running?: boolean;
  labels?: Record<string, string>;
}

function inventoryRunner(initial: ContainerFixture[]) {
  let containers = [...initial];
  let removeFailure: Error | null = null;
  const calls: string[][] = [];
  const runner: VpsCommandRunner = async (args) => {
    const command = args.slice(2);
    calls.push(command);
    if (command[0] === "container" && command[1] === "ls") {
      return { stdout: containers.map((container) => container.id.slice(0, 12)).join("\n"), stderr: "" };
    }
    if (command[0] === "container" && command[1] === "inspect") {
      const requested = command.slice(2);
      return {
        stdout: JSON.stringify(containers
          .filter((container) => requested.some((id) => container.id.startsWith(id)))
          .map((container) => ({
            Id: container.id,
            Name: `/${container.name}`,
            Config: {
              Env: ["VNC_PW=must-not-leak"],
              Labels: container.labels ?? labels(container.name),
            },
            State: { Status: container.state ?? "running", Running: container.running ?? true },
            NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.9" } } },
          }))),
        stderr: "",
      };
    }
    if (command[0] === "rm") {
      if (removeFailure) throw removeFailure;
      const ref = command[2];
      containers = containers.filter((container) => container.name !== ref && container.id !== ref);
      return { stdout: `${ref}\n`, stderr: "" };
    }
    throw new Error(`unexpected command: ${command.join(" ")}`);
  };
  return {
    calls,
    runner,
    failRemove(error: Error) {
      removeFailure = error;
    },
  };
}

describe("managed VPS inventory", () => {
  it("does nothing when no SSH alias is configured", async () => {
    const fake = inventoryRunner([]);

    await expect(listManagedVpsComputers({}, [OWNER], fake.runner)).resolves.toEqual({
      configured: false,
      available: false,
      vpsAliases: [],
      problem: null,
      instances: [],
    });
    expect(fake.calls).toEqual([]);
  });

  it("lists current and orphaned stopped computers without waking or leaking them", async () => {
    const ownedName = vpsContainerName(OWNER.botId);
    const orphanName = vpsContainerName("deleted-bot");
    const fake = inventoryRunner([
      { id: "a".repeat(64), name: orphanName, state: "exited", running: false },
      { id: "b".repeat(64), name: ownedName, state: "running", running: true },
    ]);

    const inventory = await listManagedVpsComputers(CONFIG, [OWNER], fake.runner);

    expect(inventory).toEqual({
      configured: true,
      available: true,
      vpsAliases: ["production-vps"],
      problem: null,
      instances: [
        {
          name: ownedName,
          state: "running",
          vpsAlias: "production-vps",
          ownerBotId: OWNER.botId,
          ownerName: OWNER.name,
          orphaned: false,
          inUse: false,
        },
        {
          name: orphanName,
          state: "exited",
          vpsAlias: "production-vps",
          ownerBotId: null,
          ownerName: null,
          orphaned: true,
          inUse: false,
        },
      ],
    });
    expect(fake.calls.map((call) => call.slice(0, 2))).toEqual([
      ["container", "ls"],
      ["container", "inspect"],
    ]);
    expect(fake.calls.some((call) => ["run", "start", "stop", "exec"].includes(call[0]!))).toBe(false);
    expect(JSON.stringify(inventory)).not.toMatch(/\b[ab]{64}\b|VNC_PW|172\.17\.0\.9/);
  });

  it("keeps local legacy owners but excludes foreign and ownerless legacy rows", async () => {
    const legacyOwner: ManagedVpsOwner = { botId: "legacy-current", name: "Legacy", inUse: false };
    const foreignOwner: ManagedVpsOwner = { botId: "foreign-current", name: "Foreign", inUse: false };
    const legacyName = vpsContainerName(legacyOwner.botId);
    const legacyOrphanName = vpsContainerName("legacy-deleted");
    const foreignName = vpsContainerName(foreignOwner.botId);
    const foreignOrphanName = vpsContainerName("foreign-deleted");
    const foreignEnvironmentId = "11111111-2222-4333-8444-555555555555";
    const fake = inventoryRunner([
      { id: "1".repeat(64), name: legacyName, labels: labels(legacyName, null) },
      { id: "2".repeat(64), name: legacyOrphanName, labels: labels(legacyOrphanName, null) },
      { id: "3".repeat(64), name: foreignName, labels: labels(foreignName, foreignEnvironmentId) },
      { id: "4".repeat(64), name: foreignOrphanName, labels: labels(foreignOrphanName, foreignEnvironmentId) },
    ]);

    const inventory = await listManagedVpsComputers(CONFIG, [legacyOwner, foreignOwner], fake.runner);

    expect(inventory.available).toBe(true);
    expect(inventory.instances).toEqual([{
      name: legacyName,
      state: "running",
      vpsAlias: "production-vps",
      ownerBotId: legacyOwner.botId,
      ownerName: legacyOwner.name,
      orphaned: false,
      inUse: false,
    }]);

    await expect(removeManagedVpsComputer(CONFIG, [legacyOwner, foreignOwner], foreignName, foreignName, fake.runner))
      .rejects.toMatchObject({ status: 404 });
    await expect(removeManagedVpsComputer(CONFIG, [legacyOwner, foreignOwner], legacyOrphanName, legacyOrphanName, fake.runner))
      .rejects.toMatchObject({ status: 404 });
    expect(fake.calls.some((call) => call[0] === "rm")).toBe(false);
  });

  it("lists every configured alias and tags each computer with its server", async () => {
    const alphaName = vpsContainerName(OWNER.botId);
    const betaName = vpsContainerName("second-bot");
    const second: ManagedVpsOwner = { botId: "second-bot", name: "Second", inUse: false };
    const fixtures: Record<string, ContainerFixture[]> = {
      "alpha-vps": [{ id: "a".repeat(64), name: alphaName }],
      "beta-vps": [{ id: "b".repeat(64), name: betaName }],
    };
    const runner: VpsCommandRunner = async (args) => {
      const alias = String(args[1]).replace("ssh://", "");
      const containers = fixtures[alias];
      if (!containers) throw new Error(`unknown host ${alias}`);
      const command = args.slice(2);
      if (command[0] === "container" && command[1] === "ls") {
        return { stdout: containers.map((container) => container.id.slice(0, 12)).join("\n"), stderr: "" };
      }
      if (command[0] === "container" && command[1] === "inspect") {
        const requested = command.slice(2);
        return {
          stdout: JSON.stringify(containers
            .filter((container) => requested.some((id) => container.id.startsWith(id)))
            .map((container) => ({
              Id: container.id,
              Name: `/${container.name}`,
              Config: { Labels: container.labels ?? labels(container.name) },
              State: { Status: container.state ?? "running", Running: container.running ?? true },
            }))),
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command.join(" ")}`);
    };

    const inventory = await listManagedVpsComputers(CONFIG, [OWNER, second], runner, ["alpha-vps", "beta-vps"]);
    expect(inventory.vpsAliases).toEqual(["alpha-vps", "beta-vps"]);
    expect(inventory.available).toBe(true);
    expect(inventory.instances.map((instance) => [instance.vpsAlias, instance.name, instance.ownerBotId]))
      .toEqual([
        ["alpha-vps", alphaName, OWNER.botId],
        ["beta-vps", betaName, second.botId],
      ]);

    // One unreachable server names itself in the problem and does not hide the reachable one.
    const partial = await listManagedVpsComputers(CONFIG, [OWNER], runner, ["alpha-vps", "missing-vps"]);
    expect(partial.available).toBe(false);
    expect(partial.problem).toMatch(/missing-vps/);
    expect(partial.instances.map((instance) => instance.vpsAlias)).toEqual(["alpha-vps"]);

    // Invalid aliases are never scanned.
    const filtered = await listManagedVpsComputers(CONFIG, [OWNER], runner, ["bad alias", "-alpha"]);
    expect(filtered.configured).toBe(false);
    expect(filtered.instances).toEqual([]);
  });

  it("scans aliases concurrently so one slow host cannot stall the others", async () => {
    // Alpha's first call waits until beta's scan has begun: a serial loop would deadlock here.
    let betaStarted!: () => void;
    const betaGate = new Promise<void>((resolve) => {
      betaStarted = resolve;
    });
    const runner: VpsCommandRunner = async (args) => {
      const alias = String(args[1]).replace("ssh://", "");
      if (alias === "beta-vps") betaStarted();
      else await betaGate;
      return { stdout: "", stderr: "" };
    };

    const inventory = await Promise.race([
      listManagedVpsComputers(CONFIG, [OWNER], runner, ["alpha-vps", "beta-vps"]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("aliases were scanned serially: alpha never overlapped beta")), 5_000).unref?.();
      }),
    ]);
    expect(inventory.available).toBe(true);
    expect(inventory.vpsAliases).toEqual(["alpha-vps", "beta-vps"]);
    expect(inventory.instances).toEqual([]);
  });

  it("fails closed for transport errors or unverifiable managed identities", async () => {
    const transport: VpsCommandRunner = async () => {
      throw new Error("ssh connection timed out");
    };
    const unavailable = await listManagedVpsComputers(CONFIG, [OWNER], transport);
    expect(unavailable.available).toBe(false);
    expect(unavailable.instances).toEqual([]);
    expect(unavailable.problem).toMatch(/ssh connection timed out/);

    const bad = inventoryRunner([{
      id: "c".repeat(64),
      name: vpsContainerName(OWNER.botId),
      labels: { [VPS_MANAGED_LABEL]: "1", [VPS_CONTAINER_LABEL]: "different-name" },
    }]);
    const rejected = await listManagedVpsComputers(CONFIG, [OWNER], bad.runner);
    expect(rejected.available).toBe(false);
    expect(rejected.instances).toEqual([]);

    const truncatedId = inventoryRunner([{
      id: "f".repeat(12),
      name: vpsContainerName(OWNER.botId),
    }]);
    expect((await listManagedVpsComputers(CONFIG, [OWNER], truncatedId.runner)).available).toBe(false);
  });

  it("freshly revalidates identity and confirmation before explicit removal", async () => {
    const name = vpsContainerName(OWNER.botId);
    const fake = inventoryRunner([{ id: "d".repeat(64), name }]);

    await expect(removeManagedVpsComputer(CONFIG, [OWNER], name, "stale-name", fake.runner))
      .rejects.toMatchObject({ status: 400 });
    expect(fake.calls.some((call) => call[0] === "rm")).toBe(false);

    await expect(removeManagedVpsComputer(CONFIG, [{ ...OWNER, inUse: true }], name, name, fake.runner))
      .rejects.toMatchObject({ status: 409 });
    expect(fake.calls.some((call) => call[0] === "rm")).toBe(false);

    await expect(removeManagedVpsComputer(CONFIG, [OWNER], name, name, fake.runner)).resolves.toEqual({
      removed: true,
      name,
    });
    expect(fake.calls.at(-1)).toEqual(["rm", "-f", "d".repeat(64)]);
  });

  it("surfaces provider removal failures and never reports success", async () => {
    const name = vpsContainerName(OWNER.botId);
    const fake = inventoryRunner([{ id: "e".repeat(64), name }]);
    fake.failRemove(new Error("remote daemon refused the request"));

    await expect(removeManagedVpsComputer(CONFIG, [OWNER], name, name, fake.runner)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("remote daemon refused the request"),
    });
    const after = await listManagedVpsComputers(CONFIG, [OWNER], fake.runner);
    expect(after.instances).toHaveLength(1);
  });
});
