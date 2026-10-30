import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOX_DENY_ENV } from "../../bot-box/boot.ts";
import { botBox, BoxRunner, BOX_EGRESS_PORT } from "../../bot-box/box.ts";
import type { BoxRequest } from "../../bot-box/plan.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { engineInstallRoots } from "../../engine-roots.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { forgetToolCountLimits } from "../../tool-count-limit.ts";
import { GrokAgentDriver } from "./grok.ts";
import { createOpenCodeDriver, resetOpenCodeModelCache } from "./opencode-go.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, "..", "..", "testing", "fake-acp-cli.ts");
const FAKE_MCP = join(HERE, "..", "..", "testing", "fake-mcp-server.ts");

const fixtures: Array<{ scratch: string; instance: ProviderInstance; recorder: EventRecorder }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const entry of fixtures.splice(0)) {
    entry.recorder.stop();
    await entry.instance.dispose();
    await removeTempDir(entry.scratch);
  }
  resetOpenCodeModelCache();
  forgetToolCountLimits();
});

async function open(driver: ReturnType<typeof createOpenCodeDriver>, instanceId: string, environment: (scratch: string) => Record<string, string>) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-cloud-"));
  const instance = await driver.create({
    instanceId, displayName: instanceId, enabled: true,
    config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
    environment: { HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: join(scratch, "data"), ...environment(scratch) },
  });
  const recorder = recordEvents(instance.adapter);
  fixtures.push({ scratch, instance, recorder });
  const run = async (threadId: string, input: Record<string, unknown> = {}) => {
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hello", ...input });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    return { done, events: recorder.events.filter((event) => event.turnId === turnId) };
  };
  return { scratch, run };
}

describe("the keys saved for OpenCode inside the Cloud bot box", () => {
  const setup = {
    dataDir: "/data/.openmausbot", home: "/data", codeRoots: ["/app"], engineRoots: engineInstallRoots("/data/.openmausbot"),
    bridges: [{ name: "egress", port: BOX_EGRESS_PORT, socket: "/data/.openmausbot/box/egress.sock" }],
  };
  const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge: { socat: null, bridgeScript: "/app/box-bridge.js", node: "/usr/bin/node" }, setup, denyEnv: BOX_DENY_ENV });

  /** Each bot spawn's box request as production builds it; the box itself is skipped so the fake engine still runs. */
  const boxRequests = () => {
    const requests: BoxRequest[] = [];
    vi.spyOn(botBox, "wrap").mockImplementation((request) => { requests.push(request); return null; });
    return requests;
  };

  it("passes an unlisted provider key and the OpenCode key to OpenCode's box, and neither to another engine's", async () => {
    const requests = boxRequests();
    const savedForOpenCode = { NANO_GPT_API_KEY: "nano-secret", OPENCODE_API_KEY: "go-secret" };
    const opencode = await open(createOpenCodeDriver(async () => ({ default: "", options: [] })), "opencodeGo", () => savedForOpenCode);
    expect((await opencode.run("t-nano")).done).toMatchObject({ ok: true });
    const boxed = runner.wrap(requests.at(-1)!).env;
    expect(boxed).toMatchObject(savedForOpenCode);

    const riding = { NANO_GPT_API_KEY: process.env.NANO_GPT_API_KEY, OPENCODE_API_KEY: process.env.OPENCODE_API_KEY };
    Object.assign(process.env, savedForOpenCode);
    try {
      const grok = await open(GrokAgentDriver as unknown as ReturnType<typeof createOpenCodeDriver>, "grok", () => ({}));
      expect((await grok.run("t-grok")).done).toMatchObject({ ok: true });
      const other = runner.wrap(requests.at(-1)!);
      expect(other.env.NANO_GPT_API_KEY).toBeUndefined();
      expect(other.env.OPENCODE_API_KEY).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(riding)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it("leaves the OpenCode key raw, the form OpenCode reads, and names both keys among the unbrokered", async () => {
    const requests = boxRequests();
    await (await open(createOpenCodeDriver(async () => ({ default: "", options: [] })), "opencodeGo", () => ({
      NANO_GPT_API_KEY: "nano-secret", OPENCODE_API_KEY: "go-secret",
    }))).run("t-raw");
    const broker = { port: 18080, mintForProcess: () => ({ token: "omb_t0_token" }), revoke: () => {} };
    const brokered = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge: { socat: null, bridgeScript: "/app/box-bridge.js", node: "/usr/bin/node" }, setup, denyEnv: BOX_DENY_ENV, broker })
      .wrap(requests.at(-1)!);
    expect(brokered.env).toMatchObject({ OPENCODE_API_KEY: "go-secret", NANO_GPT_API_KEY: "nano-secret" });
    expect(brokered.unbrokered).toEqual(expect.arrayContaining(["OPENCODE_API_KEY", "NANO_GPT_API_KEY"]));
  });
});

describe("a model that takes a limited number of tools", () => {
  const toolsFile = (scratch: string, name: string, count: number) => {
    const file = join(scratch, `${name}.json`);
    writeFileSync(file, JSON.stringify(Array.from({ length: count }, (_, index) => ({ name: `${name}_${index}`, inputSchema: { type: "object", properties: {} } }))));
    return { command: process.execPath, args: ["--experimental-strip-types", FAKE_MCP], env: { FAKE_MCP_TOOLS_FILE: file } };
  };
  const prompts = (scratch: string) => readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n")
    .map((line) => (JSON.parse(line) as { method: string }).method).filter((method) => method.startsWith("session/prompt"));

  it("retries a refused turn once with every server's list trimmed to fit, then starts the next turn trimmed", async () => {
    const f = await open(createOpenCodeDriver(async () => ({ default: "", options: [] })), "opencodeGo", (scratch) => ({
      FAKE_ACP_MODELS: "opencode/beam-free", FAKE_ACP_TOOL_LIMIT: "30", FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
    }));
    const custom = { big: toolsFile(f.scratch, "big", 40), small: toolsFile(f.scratch, "small", 10) };
    const first = await f.run("t-limit", { model: "opencode/beam-free", integrations: { custom } });
    expect(first.done).toMatchObject({ ok: true });
    expect(first.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(first.events.some((event) => event.type === "runtime.error")).toBe(false);
    // 30 less OpenCode's own 24 leaves 6, three for each server.
    expect(first.events.find((event) => event.type === "item.completed")).toMatchObject({ text: "tools: big=3,small=3" });
    expect(prompts(f.scratch)).toEqual(["session/prompt", "session/prompt.tool-limit", "session/prompt"]);

    const next = await f.run("t-limit-2", { model: "opencode/beam-free", integrations: { custom } });
    expect(next.done).toMatchObject({ ok: true });
    expect(prompts(f.scratch)).toHaveLength(4);
  });

  it("retries only once, then says in plain words what to turn off", async () => {
    const f = await open(createOpenCodeDriver(async () => ({ default: "", options: [] })), "opencodeGo", (scratch) => ({
      FAKE_ACP_MODELS: "opencode/beam-free", FAKE_ACP_RPC_FAILURE_FILE: join(scratch, "failure.json"), FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
    }));
    writeFileSync(join(f.scratch, "failure.json"), JSON.stringify({
      code: -32603, message: "Internal error: Invalid value for 'tools': maximum number of items is 128.", data: { service: "session", errorName: "APIError" },
    }));
    const { done, events } = await f.run("t-limit-twice", { model: "opencode/beam-free" });
    expect(done).toMatchObject({ ok: false });
    expect(prompts(f.scratch)).toEqual(["session/prompt", "session/prompt.error", "session/prompt", "session/prompt.error"]);
    expect(events.filter((event) => event.type === "runtime.error")).toEqual([expect.objectContaining({
      message: expect.stringContaining("this model takes at most 128 tools and this bot offers more, even with its tool lists trimmed"),
    })]);
  });
});
