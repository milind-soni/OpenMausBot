import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { DATA_DIR } from "../../config.ts";
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
import { DSH_APPROVAL_PLUGIN } from "./dsh-approval-plugin.ts";

const FAKE_CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));

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

describe("DeepSeek permission requests", () => {
  const toolCallId = "call-1";
  const params = { sessionId: "s", toolCall: { toolCallId }, options: [{ optionId: "allow-once" }] };
  const rawInput = { command: "pwd", justification: "Show the working directory" };
  const locations = [{ path: "/project" }];
  const start = { sessionUpdate: "tool_call", toolCallId, status: "in_progress", title: "bash", kind: "other", rawInput, locations };

  it.each(["completed", "failed"])("merges partial command details until the call is %s", (status) => {
    const calls = new Map();
    const filter = deepseekSupport.updateFilter!(calls);
    const request = deepseekSupport.permissionRequest!;
    expect(filter(start)).toBe(start);
    const update = { sessionUpdate: "tool_call_update", toolCallId, title: "shell" };
    expect(filter(update)).toBe(update);
    const result = request(params, calls);
    expect(result).toEqual({ ...params, toolCall: { toolCallId, title: "shell", kind: "execute", rawInput, locations } });
    expect(result.options).toBe(params.options);
    expect(params.toolCall).toEqual({ toolCallId });
    expect(request(params, new Map())).toBe(params);
    const end = { sessionUpdate: "tool_call_update", toolCallId, status };
    expect(filter(end)).toBe(end);
    expect(request(params, calls)).toBe(params);
  });

  it.each(["path", "file_path"])("includes the %s in a file tool title", (key) => {
    const calls = new Map();
    const input = { [key]: "/project/README.md", content: "Notes" };
    deepseekSupport.updateFilter!(calls)({ ...start, title: "write", kind: "edit", rawInput: input });
    expect(deepseekSupport.permissionRequest!(params, calls).toolCall)
      .toEqual({ toolCallId, title: "write /project/README.md", kind: "edit", rawInput: input, locations });
  });

  it("preserves the request's own tool call fields", () => {
    const calls = new Map();
    deepseekSupport.updateFilter!(calls)(start);
    const toolCall = { toolCallId, kind: "read", title: "read", rawInput: { path: "/file" }, locations: [] };
    expect(deepseekSupport.permissionRequest!({ ...params, toolCall }, calls).toolCall).toEqual(toolCall);
  });

  it("passes unrelated updates and unknown requests through unchanged", () => {
    const calls = new Map();
    const filter = deepseekSupport.updateFilter!(calls);
    for (const update of [{ sessionUpdate: "agent_message_chunk", toolCallId }, { sessionUpdate: "tool_call" }]) {
      expect(filter(update)).toBe(update);
    }
    expect(calls.size).toBe(0);
    expect(deepseekSupport.permissionRequest!(params, calls)).toBe(params);
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

describe("DeepSeek approval patch", () => {
  const dir = join(DATA_DIR, "engines", "dsh");
  const plugin = join(dir, "approval-preset.mjs");
  const cli = "fixture-dsh";
  let bin: string;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "omb-dsh-version-"));
    writeFileSync(join(bin, cli), '#!/usr/bin/env node\nconsole.log(process.env.FAKE_ACP_VERSION);\n', { mode: 0o755 });
    if (process.platform === "win32") writeFileSync(join(bin, cli + ".cmd"), '@node "%~dp0\\fixture-dsh" %*\r\n');
  });
  afterEach(() => Promise.all([removeTempDir(bin), removeTempDir(dir)]));

  const resolveCommand = (version: string, config: { cli: string; fullAuto: boolean }) =>
    deepseekSupport.resolveCommand!({ PATH: [bin, process.env.PATH].join(delimiter), SystemRoot: process.env.SystemRoot, FAKE_ACP_VERSION: version }, config, "deepseek");

  function expectApprovalFiles(patch: string, review: boolean) {
    expect(readFileSync(plugin, "utf8")).toBe(DSH_APPROVAL_PLUGIN);
    expect(parse(readFileSync(patch, "utf8"))).toEqual([{ insert: [
      // The real path, as a conversation's folder is named under it (the test data folder may sit behind /tmp's link).
      { id: "openmausbot-approval-preset", name: plugin, config: { review, dataDir: realpathSync(DATA_DIR) } },
    ] }]);
  }

  it.each([
    ["0.2.2-rc.2", "auto"], ["0.2.2-rc.5", "auto"], ["0.2.3-alpha.2", "auto"],
    ["0.2.2-rc.2", "ask"], ["0.2.2-rc.2", "full"], ["0.2.2-rc.2", undefined],
  ] as const)("loads only the local plugin on dsh %s in mode %s", async (version, approvalMode) => {
    const config = { cli, fullAuto: approvalMode === "full" };
    const review = approvalMode === "auto";
    const patch = join(dir, review ? "approval-review.patch.yml" : "approval-sandbox.patch.yml");
    expect(await resolveCommand(version, config)).toEqual({
      command: cli, ro: [plugin, join(dir, "approval-review.patch.yml"), join(dir, "approval-sandbox.patch.yml")],
    });
    expect(deepseekSupport.spawnArgs(config, { threadId: "t", text: "hi", approvalMode }))
      .toEqual(["--profile", "acp", "--patch", patch]);
    expectApprovalFiles(patch, review);
  });

  it("atomically replaces stale approval files and reuses them on the next launch", async () => {
    const config = { cli, fullAuto: false };
    const turn = { threadId: "t", text: "hi", approvalMode: "auto" } as const;
    const patch = join(dir, "approval-review.patch.yml");
    const files = [plugin, patch];
    const inodes = () => files.map(path => statSync(path, { bigint: true }).ino);
    mkdirSync(dir, { recursive: true });
    for (const path of files) writeFileSync(path, "stale");
    const stale = inodes();

    await resolveCommand("0.2.2-rc.2", config);
    deepseekSupport.spawnArgs(config, turn);
    expectApprovalFiles(patch, true);
    const current = inodes();
    for (const [i, inode] of current.entries()) expect(inode).not.toBe(stale[i]);
    expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);

    deepseekSupport.spawnArgs(config, turn);
    expect(inodes()).toEqual(current);
    expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["0.2.2-rc.1", "0.2.1-rc.2", "unknown", ""])(
    "uses the plain ACP profile without writing or mounting files for version %j", async (version) => {
      const config = { cli, fullAuto: false };
      expect(await resolveCommand(version, config)).toEqual({ command: cli });
      expect(deepseekSupport.spawnArgs(config, { threadId: "t", text: "hi", approvalMode: "auto" })).toEqual(["--profile", "acp"]);
      expect(existsSync(dir)).toBe(false);
    },
  );

  it("keeps the same patch and mounts when that CLI temporarily reports no version", async () => {
    const supported = { cli, fullAuto: false };
    const missing = { cli: join(dir, "missing-dsh"), fullAuto: false };
    const turn = { threadId: "t", text: "hi", approvalMode: "auto" } as const;
    const launch = await resolveCommand("0.2.2-rc.2", supported);
    expect(await resolveCommand("", supported)).toEqual(launch);
    expect(await resolveCommand("", missing)).toEqual({ command: missing.cli });
    expect(deepseekSupport.spawnArgs(missing, turn)).toEqual(["--profile", "acp"]);
    expect(deepseekSupport.spawnArgs(supported, turn)).toEqual(["--profile", "acp", "--patch", join(dir, "approval-review.patch.yml")]);
  });
});

describe("DeepSeek ACP support", () => {
  it("selects the model and variants over ACP", () => {
    expect(deepseekSupport.driverKind).toBe("deepseekAgent");
    expect(deepseekSupport.displayName).toBe("DeepSeek Harness");
    expect(deepseekSupport.defaultCli).toBe("dsh");
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
    expect(deepseekSupport.resolveTurnModel?.("deepseek-official/deepseek-v4-pro", {}, DEEPSEEK_MODELS)).toBe('["deepseek-official","deepseek-v4-pro"]');
    expect(deepseekSupport.resolveTurnModel?.(undefined, {}, DEEPSEEK_MODELS)).toBeUndefined();
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
      { id: "deepseek-official/deepseek-v4-flash", label: "deepseek-v4-flash", provider: "DeepSeek", variants: [{ id: "off", label: "Off" }, { id: "high", label: "High" }] },
      { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek-V4-Pro", provider: "DeepSeek" },
      { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", provider: "Anthropic" },
    ],
  };
  const DISCOVERED = { ...PARSED, options: PARSED.options.map((model) => ({ ...model, variants: PARSED.options[0].variants })) };

  describe("parseDeepSeekCatalog", () => {
    it("flattens provider groups into picker ids with dsh's names as labels", () => {
      expect(parseDeepSeekCatalog(SESSION_NEW)).toEqual(PARSED);
    });
    it("keeps reasoning choices only on the model the session actually confirmed", () => {
      const catalog = parseDeepSeekCatalog(SESSION_NEW);
      expect(catalog.options[0].variants).toEqual([{ id: "off", label: "Off" }, { id: "high", label: "High" }]);
      expect(catalog.options[1]).not.toHaveProperty("variants");
      expect(catalog.options[2]).not.toHaveProperty("variants");
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
    } else if (msg.method === "session/set_config_option") {
      const result = JSON.parse(process.env.FAKE_DSH_SESSION);
      const model = result.configOptions.find(option => option.id === "model");
      if (mode !== "refuse-model") model.currentValue = msg.params.value;
      const choices = JSON.parse(process.env.FAKE_DSH_VARIANTS || "null");
      if (choices) {
        result.configOptions = result.configOptions.filter(option => option.id !== "reasoning_effort");
        const options = choices[msg.params.value];
        if (options) result.configOptions.push({ id: "reasoning_effort", category: "thought_level", type: "select", options });
      }
      reply(msg.id, result);
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
    await expect(fetchDeepSeekCatalog(cli, env, cwd)).resolves.toEqual(DISCOVERED);
    const calls = JSON.parse(readFileSync(dump, "utf8")) as Array<{ method: string; params: any }>;
    expect(calls.map((c) => c.method)).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/close"]);
    expect(calls[0]!.params).toMatchObject({ protocolVersion: 1 });
    expect(calls[1]!.params).toEqual({ cwd, mcpServers: [] });
    expect(calls[2]!.params).toEqual({ sessionId: "s1", configId: "model", value: '["deepseek-official","deepseek-v4-pro"]' });
    expect(calls[4]!.params).toEqual({ sessionId: "s1" });
  });

  it("discovers different choices per model and leaves models without reasoning unmarked", async () => {
    const { cli, env } = fakeCli({ FAKE_DSH_VARIANTS: JSON.stringify({
      '["deepseek-official","deepseek-v4-pro"]': [{ value: "max", name: "Max" }],
    }) });
    const catalog = await fetchDeepSeekCatalog(cli, env, tmpdir());
    expect(catalog.options[0].variants).toEqual(PARSED.options[0].variants);
    expect(catalog.options[1].variants).toEqual([{ id: "max", label: "Max" }]);
    expect(catalog.options[2]).not.toHaveProperty("variants");
  });

  it("leaves a model whose switch was not confirmed without choices instead of assigning another model's", async () => {
    const { cli, env } = fakeCli({ FAKE_DSH_MODE: "refuse-model" });
    const catalog = await fetchDeepSeekCatalog(cli, env, tmpdir());
    expect(catalog.options[1]).not.toHaveProperty("variants");
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
    await expect(fetchDeepSeekCatalog(cli, env, tmpdir())).resolves.toEqual(DISCOVERED);
  });

  it("is what Refresh runs, against the instance's own cli", async () => {
    const { cli, env } = fakeCli({});
    await expect(deepseekSupport.resolveModels!(env, { cli, fullAuto: false }, "deepseek")).resolves.toEqual(DISCOVERED);
  });
});

describe("DeepSeek Harness after a provider was added in dsh since its process started", () => {
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
        FAKE_ACP_MODELS_FILE: modelsFile,
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
    const countRequests = (method: string) => readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n")
      .filter((line) => (JSON.parse(line) as { method: string }).method === method).length;
    return { run, countRequests, modelsFile };
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
    expect(f.countRequests("session/prompt")).toBe(1);
    const retry = await f.run(addedPicker);
    expect(retry.done).toMatchObject({ ok: true });
    expect(f.countRequests("initialize")).toBe(2);
  });
});

// dsh 0.2 refuses session/resume of a session still open in the same process (-32602 "session is already active"),
// so a turn whose tools changed must not resume on the live process: the message went unanswered.
describe("DeepSeek Harness when a turn's tools change", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("resumes the session in a fresh process instead of the one where it is still open", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-deepseek-active-"));
    const instance = await DeepSeekAgentDriver.create({
      instanceId: "deepseek-active", displayName: "DeepSeek Harness", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: {
        HOME: scratch, USERPROFILE: scratch, DSH_HOME: join(scratch, "dsh"), DEEPSEEK_API_KEY: "sk-fixture",
        FAKE_ACP_REJECT_LIVE_LOAD_FILE: join(scratch, "reject"), FAKE_ACP_REJECT_LIVE_LOAD_DSH: "1",
        FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
        FAKE_ACP_DUMP: join(scratch, "dump"),
      },
    });
    const recorder = recordEvents(instance.adapter);
    cleanup = async () => {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    };
    writeFileSync(join(scratch, "reject"), "1");
    const agents = (token: string) => ({ agents: { command: process.execPath, args: [FAKE_CLI], env: { OMB_COMMS_TOKEN: token } } });
    const run = async (text: string, token: string, resumeCursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-active", text, integrations: agents(token), ...(resumeCursor ? { resumeCursor } : {}) });
      return recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    };
    expect(await run("one", "token-one")).toMatchObject({ ok: true });
    const second = await run("two", "token-two", "fake-acp-session");
    expect(recorder.events.filter((event) => event.type === "runtime.error")).toEqual([]);
    expect(second).toMatchObject({ ok: true });
    const calls = readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; method: string; sessionId?: string });
    expect(calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/resume").map((call) => call.sessionId)).toEqual(["fake-acp-session"]);
    expect(calls.filter((call) => call.method === "session/prompt")).toHaveLength(2);
    expect(new Set(calls.filter((call) => call.method === "initialize").map((call) => call.pid)).size).toBe(2);
    const servers = JSON.parse(readFileSync(join(scratch, "dump.mcp.json"), "utf8")) as Array<{ name: string }>;
    const agentsServer = JSON.stringify(servers.find((server) => server.name === "agents"));
    expect(agentsServer).toContain("OMB_COMMS_TOKEN");
    expect(agentsServer).toContain("token-two");
  });
});
