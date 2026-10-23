import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import {
  DEEPSEEK_MODELS,
  DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS,
  DEEPSEEK_MODELS_TIMEOUT_ENV,
  DeepSeekAgentDriver,
  deepseekPickerId,
  deepseekSupport,
  deepseekWireValue,
  dshHome,
  fetchDeepSeekCatalog,
  hasDeepSeekKey,
  parseDeepSeekCatalog,
} from "./deepseek.ts";

describe("DeepSeek model ids", () => {
  it("maps a picker id to dsh's JSON pair and back", () => {
    expect(deepseekWireValue("deepseek-official/deepseek-v4-pro")).toBe('["deepseek-official","deepseek-v4-pro"]');
    expect(deepseekPickerId('["deepseek-official","deepseek-v4-pro"]')).toBe("deepseek-official/deepseek-v4-pro");
  });

  it("splits on the first slash so gateway model ids keep their own slashes", () => {
    expect(deepseekWireValue("my-gateway/vendor/model-v2")).toBe('["my-gateway","vendor/model-v2"]');
    expect(deepseekPickerId('["my-gateway","vendor/model-v2"]')).toBe("my-gateway/vendor/model-v2");
  });

  it("passes an id without a provider through unchanged and rejects a non-pair", () => {
    expect(deepseekWireValue("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(deepseekPickerId("deepseek-v4-pro")).toBeNull();
    expect(deepseekPickerId('["only-one"]')).toBeNull();
    expect(deepseekPickerId('["a",1]')).toBeNull();
  });

  it("ships the three official models with V4-Flash as default", () => {
    expect(DEEPSEEK_MODELS.default).toBe("deepseek-official/deepseek-v4-flash");
    expect(DEEPSEEK_MODELS.options.map((o) => o.id)).toEqual([
      "deepseek-official/deepseek-v4-flash",
      "deepseek-official/deepseek-flash",
      "deepseek-official/deepseek-v4-pro",
    ]);
  });
});

describe("DeepSeek key detection", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTempDir(d);
  });
  const home = () => {
    const d = mkdtempSync(join(tmpdir(), "omb-dsh-"));
    dirs.push(d);
    return d;
  };

  it("honours DSH_HOME over the default ~/.dsh", () => {
    expect(dshHome({ DSH_HOME: "/x/dsh", HOME: "/h" })).toBe("/x/dsh");
    expect(dshHome({ HOME: "/h" })).toBe(join("/h", ".dsh"));
  });

  it("is authenticated on DEEPSEEK_API_KEY in the env", () => {
    expect(hasDeepSeekKey({ DEEPSEEK_API_KEY: "sk-x", DSH_HOME: home() })).toBe(true);
    expect(hasDeepSeekKey({ DEEPSEEK_API_KEY: "  ", DSH_HOME: home() })).toBe(false);
  });

  it("reads a stored key from $DSH_HOME/.credentials.yaml", () => {
    const h = home();
    writeFileSync(join(h, ".credentials.yaml"), "DEEPSEEK_API_KEY: sk-stored\n");
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(true);
  });

  it("treats an empty or commented credential as missing", () => {
    const h = home();
    writeFileSync(join(h, ".credentials.yaml"), "# DEEPSEEK_API_KEY: sk-old\nDEEPSEEK_API_KEY: \n");
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(false);
  });

  it("accepts the harness-home .env fallback", () => {
    const h = home();
    writeFileSync(join(h, ".env"), "export DEEPSEEK_API_KEY=sk-env\n");
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(true);
  });

  it("reads a stored key from dsh's version-1 refs layout", () => {
    const h = home();
    writeFileSync(join(h, ".credentials.yaml"), "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-stored\nrecords: {}\n");
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(true);
  });

  it.each([
    'DEEPSEEK_API_KEY: ""',
    "DEEPSEEK_API_KEY: ''",
    "DEEPSEEK_API_KEY:\nOTHER_KEY: x\n",
    "version: 1\nrefs:\n  DEEPSEEK_API_KEY: \"\"\n  OTHER_KEY: x\n",
    "version: 1\nrefs:\n  OTHER_KEY: x\nrecords: {}\n",
    "refs:\n  DEEPSEEK_API_KEY:\n  OTHER_KEY: x\n",
    "not: [valid",
  ])("treats an empty, quoted-empty or absent stored credential as missing: %j", (text) => {
    const h = home();
    writeFileSync(join(h, ".credentials.yaml"), text);
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(false);
  });

  it.each([
    "DEEPSEEK_API_KEY=\nOPENAI_API_KEY=sk-other\n",
    'DEEPSEEK_API_KEY=""\n',
    "DEEPSEEK_API_KEY=''\n",
    "# DEEPSEEK_API_KEY=sk-old\n",
    "DEEPSEEK_API_KEY_BACKUP=sk-x\n",
  ])("treats a blank or commented .env value as missing: %j", (text) => {
    const h = home();
    writeFileSync(join(h, ".env"), text);
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(false);
  });

  it("reads a quoted .env value", () => {
    const h = home();
    writeFileSync(join(h, ".env"), 'DEEPSEEK_API_KEY="sk-quoted" # comment\n');
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(true);
  });

  it("is not authenticated with no key anywhere", () => {
    const h = home();
    mkdirSync(join(h, "profiles"), { recursive: true });
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(false);
  });
});

describe("DeepSeek ACP support", () => {
  it("spawns dsh in its ACP profile and selects model + variants over the wire", () => {
    expect(deepseekSupport.driverKind).toBe("deepseekAgent");
    expect(deepseekSupport.displayName).toBe("DeepSeek Harness");
    expect(deepseekSupport.defaultCli).toBe("dsh");
    expect(deepseekSupport.spawnArgs({ cli: "dsh", fullAuto: false }, {} as never)).toEqual(["--profile", "acp"]);
    expect(deepseekSupport.selectModel).toEqual({ configId: "model" });
    expect(deepseekSupport.modelVariants).toBe(true);
    expect(deepseekSupport.resumeMethod).toBe("resume");
    expect(deepseekSupport.resolveModelsOnCreate).toBe(false);
    expect(deepseekSupport.credentialEnv).toEqual(["DEEPSEEK_API_KEY"]);
    expect(deepseekSupport.authFailure).toBe("continue");
    expect(deepseekSupport.pickAuthMethod([], {})).toBeNull();
    expect(deepseekSupport.install?.command?.darwin).toBe("npm install -g @deepseek-ai/dsh");
    expect(deepseekSupport.install?.command?.win32).toBe("npm install -g @deepseek-ai/dsh");
    expect(deepseekSupport.install?.needsNode).toBe(true);
    // Keyless means "paste a key in Settings", never "sign in in Terminal".
    expect(deepseekSupport.install?.settings).toBe("connections");
  });

  it("is authenticated exactly when a DeepSeek key is reachable", () => {
    expect(deepseekSupport.isAuthenticated({ DEEPSEEK_API_KEY: "sk-x", DSH_HOME: "/nonexistent/dsh" }, { cli: "dsh", fullAuto: false }, "deepseek")).toBe(true);
    expect(deepseekSupport.isAuthenticated({ DSH_HOME: "/nonexistent/dsh" }, { cli: "dsh", fullAuto: false }, "deepseek")).toBe(false);
  });

  it("resolves the turn model to the wire pair", () => {
    expect(deepseekSupport.resolveTurnModel?.("deepseek-official/deepseek-v4-pro", {})).toBe('["deepseek-official","deepseek-v4-pro"]');
    expect(deepseekSupport.resolveTurnModel?.(undefined, {})).toBeUndefined();
  });

  it("falls back to the catalog default when offered, else the session's current model", () => {
    const session = {
      configOptions: [{
        id: "model",
        currentValue: '["deepseek-official","deepseek-flash"]',
        options: [
          { group: "deepseek-official", options: [
            { value: '["deepseek-official","deepseek-flash"]' },
            { value: '["deepseek-official","deepseek-v4-flash"]' },
          ] },
        ],
      }],
    };
    expect(deepseekSupport.fallbackModel?.(session, "deepseek-official/deepseek-v4-flash")).toBe('["deepseek-official","deepseek-v4-flash"]');
    expect(deepseekSupport.fallbackModel?.(session, "deepseek-official/deepseek-v4-pro")).toBe('["deepseek-official","deepseek-flash"]');
    expect(deepseekSupport.fallbackModel?.({}, "deepseek-official/deepseek-v4-pro")).toBeNull();
  });

  it("puts the persona ahead of the prompt text", () => {
    expect(deepseekSupport.buildPromptText?.({ system: "You are Maus.", text: "hi" } as never)).toBe("You are Maus.\n\nhi");
    expect(deepseekSupport.buildPromptText?.({ system: "", text: "hi" } as never)).toBe("hi");
  });
});

describe("DeepSeek live catalog", () => {
  const SESSION_NEW = {
    sessionId: "s1",
    configOptions: [
      {
        id: "model", name: "Model", category: "model", type: "select",
        currentValue: '["deepseek-official","deepseek-v4-flash"]',
        options: [
          { group: "deepseek-official", name: "DeepSeek", options: [
            { value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro", description: "Stronger." },
          ] },
          { group: "anthropic", name: "Anthropic", options: [{ value: '["anthropic","claude-opus-4.6"]', name: "Claude Opus 4.6" }] },
          { value: "not-a-pair", name: "dropped" },
        ],
      },
      { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }] },
    ],
  };
  const PARSED = {
    default: "deepseek-official/deepseek-v4-flash",
    options: [
      { id: "deepseek-official/deepseek-v4-flash", label: "deepseek-v4-flash", provider: "DeepSeek" },
      { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek-V4-Pro", provider: "DeepSeek" },
      { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", provider: "Anthropic" },
    ],
  };

  describe("parseDeepSeekCatalog", () => {
    it("flattens provider groups into picker ids with dsh's names as labels", () => {
      expect(parseDeepSeekCatalog(SESSION_NEW)).toEqual(PARSED);
    });
    it("falls back to the first model when the current one is not offered", () => {
      const session = { ...SESSION_NEW, configOptions: [{ ...SESSION_NEW.configOptions[0], currentValue: '["gone","model"]' }] };
      expect(parseDeepSeekCatalog(session).default).toBe("deepseek-official/deepseek-v4-flash");
    });
    it("throws when dsh advertises no model option", () => {
      expect(() => parseDeepSeekCatalog({ sessionId: "s", configOptions: [] })).toThrow(/no models/);
      expect(() => parseDeepSeekCatalog({ sessionId: "s", configOptions: [{ id: "model", options: [{ value: "x" }] }] })).toThrow(/no models/);
    });
  });

  // A fake `dsh --profile acp`: newline JSON-RPC on stdio, the real initialize
  // shape, session/new from FAKE_DSH_SESSION, every request dumped to FAKE_DSH_DUMP.
  const FAKE_CLI_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_DSH_MODE || "happy";
const calls = [];
let buf = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const dump = () => { if (process.env.FAKE_DSH_DUMP) fs.writeFileSync(process.env.FAKE_DSH_DUMP, JSON.stringify(calls)); };
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    calls.push({ method: msg.method, params: msg.params });
    dump();
    if (mode === "hang") continue;
    if (mode === "exit") process.exit(0);
    if (msg.method === "initialize") {
      reply(msg.id, { protocolVersion: 1, agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
        agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: false, audio: false, embeddedContext: false }, sessionCapabilities: { close: {}, list: {}, resume: {} } },
        authMethods: [] });
    } else if (msg.method === "session/new") {
      reply(msg.id, JSON.parse(process.env.FAKE_DSH_SESSION));
    } else if (msg.method === "session/close") {
      reply(msg.id, {});
    }
  }
});
`;

  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTempDir(d);
  });

  function fakeCli(env: Record<string, string>): { cli: string; env: Record<string, string>; dump: string } {
    const home = mkdtempSync(join(tmpdir(), "omb-dsh-probe-"));
    dirs.push(home);
    const cli = join(home, "fake-dsh.ts");
    writeFileSync(cli, FAKE_CLI_SOURCE, { mode: 0o755 });
    const dump = join(home, "calls.json");
    // The spawn gets exactly this env, so PATH must survive for the `/usr/bin/env node` shebang.
    return { cli, dump, env: { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, FAKE_DSH_SESSION: JSON.stringify(SESSION_NEW), FAKE_DSH_DUMP: dump, ...env } };
  }

  it("drives initialize → session/new → session/close and returns the catalog", async () => {
    const { cli, env, dump } = fakeCli({});
    const cwd = mkdtempSync(join(tmpdir(), "omb-dsh-ws-"));
    dirs.push(cwd);
    await expect(fetchDeepSeekCatalog(cli, env, cwd)).resolves.toEqual(PARSED);
    const calls = JSON.parse(readFileSync(dump, "utf8")) as Array<{ method: string; params: any }>;
    expect(calls.map((c) => c.method)).toEqual(["initialize", "session/new", "session/close"]);
    expect(calls[0]!.params).toMatchObject({ protocolVersion: 1 });
    expect(calls[1]!.params).toEqual({ cwd, mcpServers: [] });
    expect(calls[2]!.params).toEqual({ sessionId: "s1" });
  });

  it("rejects within the timeout when dsh never answers", async () => {
    const { cli, env } = fakeCli({ FAKE_DSH_MODE: "hang", [DEEPSEEK_MODELS_TIMEOUT_ENV]: "300" });
    const started = Date.now();
    await expect(fetchDeepSeekCatalog(cli, env, tmpdir())).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("rejects when dsh exits before answering", async () => {
    const { cli, env } = fakeCli({ FAKE_DSH_MODE: "exit" });
    await expect(fetchDeepSeekCatalog(cli, env, tmpdir())).rejects.toThrow(/exited/);
  });

  it("rejects when the binary is missing", async () => {
    const { env } = fakeCli({});
    await expect(fetchDeepSeekCatalog("/nonexistent/dsh-fixture", env, tmpdir())).rejects.toThrow();
  });

  it.each(["not-a-number", "0", "-1", "2147483648"])("ignores invalid timeout %s and keeps the 60 s default", async (timeout) => {
    expect(DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS).toBe(60_000);
    const { cli, env } = fakeCli({ [DEEPSEEK_MODELS_TIMEOUT_ENV]: timeout });
    await expect(fetchDeepSeekCatalog(cli, env, tmpdir())).resolves.toEqual(PARSED);
  });

  it("is what Refresh runs, against the instance's own cli", async () => {
    const { cli, env } = fakeCli({});
    await expect(deepseekSupport.resolveModels!(env, { cli, fullAuto: false }, "deepseek")).resolves.toEqual(PARSED);
  });
});

describe("DeepSeek Harness after a provider was added in dsh since its process started", () => {
  const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
  const base = '["deepseek-official","deepseek-v4-flash"]';
  const addedPicker = "deepseek-official/deepseek-v4-pro";
  const added = '["deepseek-official","deepseek-v4-pro"]';
  const fixtures: Array<{ scratch: string; instance: ProviderInstance; recorder: ReturnType<typeof recordEvents> }> = [];
  afterEach(async () => {
    for (const entry of fixtures.splice(0)) {
      entry.recorder.stop();
      await entry.instance.dispose();
      await removeTempDir(entry.scratch);
    }
  });
  const open = async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-deepseek-stale-"));
    const modelsFile = join(scratch, "models");
    writeFileSync(modelsFile, `${base}\n`);
    const instance = await DeepSeekAgentDriver.create({
      instanceId: "deepseek-stale", displayName: "DeepSeek Harness", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: {
        HOME: scratch, USERPROFILE: scratch, DSH_HOME: join(scratch, "dsh"), DEEPSEEK_API_KEY: "sk-fixture",
        FAKE_ACP_MODELS_FILE: modelsFile, FAKE_ACP_LAUNCH_COUNT_FILE: join(scratch, "launches"),
        FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
      },
    });
    const recorder = recordEvents(instance.adapter);
    fixtures.push({ scratch, instance, recorder });
    const run = async (model: string) => {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-stale", text: "hello", model });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      return { done, events: recorder.events.filter((event) => event.turnId === turnId) };
    };
    const launches = () => Number(readFileSync(join(scratch, "launches"), "utf8"));
    const prompts = () => readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n")
      .filter((line) => (JSON.parse(line) as { method: string }).method === "session/prompt").length;
    return { run, launches, prompts, modelsFile };
  };

  it("sends the wire pair for the picker id and reports it on session.started", async () => {
    const f = await open();
    const { done, events } = await f.run("deepseek-official/deepseek-v4-flash");
    expect(done).toMatchObject({ ok: true });
    expect(events.find((event) => event.type === "session.started")).toMatchObject({ model: base });
  });

  it("never swaps a catalog model for another one: fails the stale process and retries on a fresh one", async () => {
    const f = await open();
    expect((await f.run("deepseek-official/deepseek-v4-flash")).done).toMatchObject({ ok: true });
    writeFileSync(f.modelsFile, `${base}\n${added}\n`);
    const stale = await f.run(addedPicker);
    expect(stale.done).toMatchObject({ ok: false });
    expect(stale.events.some((event) => event.type === "runtime.notice")).toBe(false);
    expect(stale.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("deepseek-v4-pro") });
    expect(f.prompts()).toBe(1);
    const retry = await f.run(addedPicker);
    expect(retry.done).toMatchObject({ ok: true });
    expect(f.launches()).toBe(2);
  });
});
