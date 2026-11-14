import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { MistralVibeAgentDriver, resolveMistralVibeModels, vibeSignedIn } from "./mistral-vibe.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const MODELS = "mistral-medium-3.5,zai-glm-5-3-flash,Mistral Large,Codestral";

describe("Mistral (Vibe) ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-mistral-vibe-contract-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    instance = await MistralVibeAgentDriver.create({
      instanceId: `mistral-vibe-contract-${Math.random().toString(36).slice(2)}`,
      displayName: "Mistral (Vibe)",
      enabled: true,
      environment: {
        VIBE_HOME: join(scratch, "vibe-home"),
        FAKE_ACP_AUTH_METHOD: "browser-auth",
        FAKE_ACP_IMAGE_CAPABILITY: "1",
        FAKE_ACP_AGENT_NAME: "@mistralai/mistral-vibe",
        FAKE_ACP_VERSION: "vibe-acp 3.1.1",
        FAKE_ACP_MODELS: MODELS,
        FAKE_ACP_DUMP: join(scratch, "launch.json"),
        FAKE_ACP_RPC_DUMP: join(scratch, "rpc.json"),
        ...environment,
      },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  it("is a built-in engine in fresh and existing fleets", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "mistralVibeAgent")).toBe(true);
    expect(instanceConfigs({}).mistralVibe?.driver).toBe("mistralVibeAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).mistralVibe?.driver).toBe("mistralVibeAgent");
    expect(MistralVibeAgentDriver.metadata).toMatchObject({ displayName: "Mistral (Vibe)", access: "subscription" });
  });

  it("treats a populated whoami_cache.json or MISTRAL_API_KEY as signed in", () => {
    const home = join(scratch, "vibe-home");
    mkdirSync(home, { recursive: true });
    expect(vibeSignedIn({ VIBE_HOME: home, HOME: scratch })).toBe(false);
    writeFileSync(join(home, "whoami_cache.json"), JSON.stringify({ customer_id: "cus-fixture" }));
    expect(vibeSignedIn({ VIBE_HOME: home, HOME: scratch })).toBe(true);
    expect(vibeSignedIn({ VIBE_HOME: join(scratch, "absent"), MISTRAL_API_KEY: "fixture-key" })).toBe(true);
  });

  it("treats an injected keychain probe as a sign-in marker (orchestration of the fresh sign-in)", () => {
    const env = { VIBE_HOME: join(scratch, "absent") };
    expect(vibeSignedIn(env, () => false)).toBe(false);
    expect(vibeSignedIn(env, () => true)).toBe(true);
  });

  it("reads live models from a throwaway discovery session that sets no model itself", async () => {
    const rpc = join(scratch, "discovery-rpc.json");
    const dump = join(scratch, "discovery.json");
    const catalog = await resolveMistralVibeModels({
      ...process.env,
      VIBE_HOME: join(scratch, "vibe-home"),
      FAKE_ACP_AUTH_METHOD: "browser-auth",
      FAKE_ACP_MODELS: MODELS,
      FAKE_ACP_VERSION: "vibe-acp 3.1.1",
      FAKE_ACP_DUMP: dump,
      FAKE_ACP_RPC_DUMP: rpc,
    }, { cli: FAKE_CLI });

    expect(catalog.default).toBe("mistral-medium-3.5");
    expect(catalog.options.map((option) => option.id)).toEqual(MODELS.split(","));
    expect(JSON.parse(readFileSync(rpc, "utf8"))).not.toContain("session/set_config_option");
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual([]);
  });

  it("starts nothing when the instance is created", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("runs `vibe-acp` with no arguments, the workspace key, and the picked model", async () => {
    const { instance, recorder } = await create({ MISTRAL_API_KEY: "engine-fixture-key", OPENAI_COMPAT_API_KEY: "other-engine-key" });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "mistral-vibe-chat", text: "hello", model: "zai-glm-5-3-flash", approvalMode: "ask",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);

    expect(recorder.events.every((event) => event.provider === "mistralVibeAgent")).toBe(true);
    expect(JSON.parse(readFileSync(join(scratch, "rpc.json"), "utf8"))).toContain("authenticate");
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual([]);
    expect(launch.env.MISTRAL_API_KEY).toBe("engine-fixture-key");
    expect(launch.env.OPENAI_COMPAT_API_KEY).toBeUndefined();
    const promptRows = readFileSync(join(scratch, "launch.json.prompts.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(promptRows.at(-1)!)).toMatchObject({ model: "zai-glm-5-3-flash" });
  });

  it("turns Vibe's session/request_permission into an approval card and answers with the person's choice", async () => {
    const answer = join(scratch, "permission.txt");
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: answer });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "mistral-vibe-permission", text: "edit", model: "mistral-medium-3.5", approvalMode: "ask",
    });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("mistralVibeAgent");
    expect(await instance.adapter.respondToRequest("mistral-vibe-permission", ask.requestId!, { behavior: "deny" })).toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(readFileSync(answer, "utf8")).toBe("reject");
  });
});
