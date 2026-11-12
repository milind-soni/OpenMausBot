import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { OmpAgentDriver, resolveOmpModels } from "./omp.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const MODELS = "fixture/alpha,fixture/beta";
const VARIANTS = JSON.stringify({
  "fixture/beta": { id: "thinking", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
});

describe("OMP ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-omp-contract-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    instance = await OmpAgentDriver.create({
      instanceId: `omp-contract-${Math.random().toString(36).slice(2)}`,
      displayName: "OMP",
      enabled: true,
      environment: {
        FAKE_ACP_MODELS: MODELS,
        FAKE_ACP_AUTH_METHOD: "agent",
        FAKE_ACP_IMAGE_CAPABILITY: "1",
        FAKE_ACP_VERSION: "omp/18.13.1",
        FAKE_ACP_DUMP: join(scratch, "launch.json"),
        FAKE_ACP_RPC_DUMP: join(scratch, "rpc.json"),
        ...environment,
      },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  it("is a built-in custom engine in fresh and existing fleets", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "ompAgent")).toBe(true);
    expect(instanceConfigs({}).omp?.driver).toBe("ompAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).omp?.driver).toBe("ompAgent");
    expect(OmpAgentDriver.metadata).toMatchObject({ displayName: "OMP", access: "custom" });
  });

  it("discovers more than 128 models without switching each one or keeping a discovery session", async () => {
    const models = Array.from({ length: 130 }, (_, index) => `fixture/model-${index}`);
    const dump = join(scratch, "discovery.json");
    const rpc = join(scratch, "discovery-rpc.json");
    const catalog = await resolveOmpModels({
      ...process.env,
      FAKE_ACP_MODELS: models.join(","),
      FAKE_ACP_DUMP: dump,
      FAKE_ACP_RPC_DUMP: rpc,
      PI_CODING_AGENT_SESSION_DIR: join(scratch, "persons-sessions"),
    }, { cli: FAKE_CLI });

    expect(catalog.default).toBe("agent-default");
    expect(catalog.options.map((option) => option.id)).toEqual(["agent-default", ...models]);
    expect(catalog.options.every((option) => option.custom)).toBe(true);
    expect(JSON.parse(readFileSync(rpc, "utf8"))).not.toContain("session/set_config_option");
    const launch = JSON.parse(readFileSync(dump, "utf8"));
    expect(launch.argv).toEqual(["acp"]);
    expect(launch.env.PI_CODING_AGENT_SESSION_DIR).not.toBe(join(scratch, "persons-sessions"));
    expect(existsSync(launch.env.PI_CODING_AGENT_SESSION_DIR)).toBe(false);
  });

  it("reads each model's thinking options for a small catalog", async () => {
    const catalog = await resolveOmpModels({ ...process.env, FAKE_ACP_MODELS: MODELS, FAKE_ACP_VARIANTS: VARIANTS }, { cli: FAKE_CLI });
    expect(catalog.options.find((option) => option.id === "fixture/beta")?.variants).toEqual([
      { id: "low", label: "Low" }, { id: "high", label: "High" },
    ]);
  });

  it("starts nothing when the instance is created", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("runs `omp acp` with its local credentials and the picked model", async () => {
    const { instance, recorder } = await create({ ANTHROPIC_API_KEY: "engine-fixture-key", OPENCODE_API_KEY: "workspace-fixture-key" });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "omp-chat", text: "hello", model: "fixture/beta", approvalMode: "ask",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);

    expect(recorder.events.every((event) => event.provider === "ompAgent")).toBe(true);
    expect(JSON.parse(readFileSync(join(scratch, "rpc.json"), "utf8"))).toContain("authenticate");
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual(["acp"]);
    expect(launch.env.ANTHROPIC_API_KEY).toBe("engine-fixture-key");
    expect(launch.env.OPENCODE_API_KEY).toBeUndefined();
    const promptRows = readFileSync(join(scratch, "launch.json.prompts.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(promptRows.at(-1)!)).toMatchObject({ model: "fixture/beta" });
  });

  it("turns OMP's session/request_permission into an approval card and answers with the person's choice", async () => {
    const answer = join(scratch, "permission.txt");
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: answer });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "omp-permission", text: "edit", model: "agent-default", approvalMode: "ask",
    });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("ompAgent");
    expect(await instance.adapter.respondToRequest("omp-permission", ask.requestId!, { behavior: "deny" })).toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(readFileSync(answer, "utf8")).toBe("reject");
  });
});
