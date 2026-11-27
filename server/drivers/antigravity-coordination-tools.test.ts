// A native Antigravity CLI thread whose servers are over the CLI's session tool budget even at their shortest, as a bot
// with the person's own servers beside OpenMausBot's: the CLI drops the session's largest tools first, so the session's
// lists must leave out tools themselves, never a coordination tool, on session/new, on session/resume after a restart, on
// a turn in the live session and after a model switch.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_LIST as BROWSER_TOOLS } from "../browser/tools.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { DATA_TOOLS } from "../data/tools.ts";
import { fitToolList } from "../mcp-tool-schema.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { AGENTS_ENV_HEADER, TOOL_SHARE_HEADER } from "../routes/own-mcp-http-path.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { cliDrops } from "../testing/cli-tool-drop.ts";
import { recordEvents } from "../testing/events.ts";
import { EXECUTOR_LIKE_TOOLS } from "../testing/executor-like-tools.ts";
import { whopLikeCatalog } from "../testing/whop-like-catalog.ts";
import { workspaceAppsLikeCatalog } from "../testing/workspace-apps-like-catalog.ts";
import {
  ANTIGRAVITY_CLI_TOOL_BUDGET, ANTIGRAVITY_CLI_TOOL_LIMIT, COORDINATION_TOOLS, definitionListBytes, fitToolListToShare, toolListFloorBytes, toolsForShareProfile, type ListedTool,
} from "../tool-list-budget.ts";
import { TOOL_LIST_SHARE_ENV, toolsForSessionShare } from "../tool-list-share.ts";
import { TOOL_SCHEMA_PROFILE_ENV, toolSchemaProfile } from "../tool-schema-profile.ts";
import { agentsToolList } from "./agents-mcp.ts";
import { AntigravityDriver } from "./antigravity.ts";

vi.hoisted(() => { process.env.OMB_ANTIGRAVITY_NATIVE_CLI = "1"; });

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const HARNESS = "http://127.0.0.1:8799";
const BOT = { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "synthetic-comms", OMB_BOT_ID: "shop", OMB_THREAD_ID: "t-shop", OMB_CHIEF_OF_STAFF: "0", OMB_COMPUTER_SELECTION: "1" };
const gemini = toolSchemaProfile("gemini")!;

/** What each server really lists: OpenMausBot's own catalogs, and the person's servers after the gemini profile. */
const LISTS: Record<string, readonly ListedTool[]> = {
  agents: agentsToolList(BOT).listed as ListedTool[],
  browser: BROWSER_TOOLS,
  data: DATA_TOOLS as readonly ListedTool[],
  composio: fitToolList(workspaceAppsLikeCatalog(), gemini) as ListedTool[],
  shop: fitToolList(whopLikeCatalog().slice(0, 30), gemini) as ListedTool[],
  ts: fitToolList(EXECUTOR_LIKE_TOOLS, gemini) as ListedTool[],
};

type Sent = { name: string; headers?: Array<{ name: string; value: string }>; env?: Array<{ name: string; value: string }> };
const header = (server: Sent, name: string) => server.headers?.find((entry) => entry.name === name)?.value;
const envOf = (server: Sent) => Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value]));

/** Each list as the CLI is shown it under the servers a session setup sent, every relay answering (and recording) its own. */
function shown(sent: Sent[]): Record<string, ListedTool[]> {
  return Object.fromEntries(sent.map((server) => {
    const tools = LISTS[server.name]!;
    if (server.name === "agents") {
      const settings = JSON.parse(Buffer.from(header(server, AGENTS_ENV_HEADER)!, "base64url").toString("utf8")) as Record<string, string>;
      return [server.name, [...toolsForShareProfile(tools, settings[TOOL_SCHEMA_PROFILE_ENV])]];
    }
    const own = header(server, TOOL_SHARE_HEADER);
    return [server.name, own !== undefined ? [...toolsForShareProfile(tools, own)] : toolsForSessionShare(tools, envOf(server)) as ListedTool[]];
  }));
}
const flat = (lists: Record<string, ListedTool[]>) => Object.entries(lists).flatMap(([server, tools]) => tools.map((tool) => ({ ...tool, name: `${server}/${tool.name}` })));

const scratch: string[] = [];
const instances: ProviderInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

async function start(executable: string, dump: string, rpc: string) {
  ensureDirs();
  const instance = await AntigravityDriver.create({
    instanceId: "antigravity-coordination", displayName: "Antigravity", enabled: true, config: { cli: executable, fullAuto: false },
    environment: {
      FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-4-neon,gemini-4-pro", FAKE_ACP_AGENT_NAME: "Antigravity ACP Server",
      FAKE_ACP_VERSION: "1.5.18", FAKE_ACP_MODES: "default,plan", FAKE_ACP_DUMP: dump, FAKE_ACP_DUMP_PROMPT: "1", FAKE_ACP_RPC_APPEND_FILE: rpc,
    },
  });
  instances.push(instance);
  return instance;
}

describe("a native Antigravity CLI thread over the session's tool budget", () => {
  it("the case is real: left to the CLI, a session this size loses coordinate_bots", () => {
    const lists = Object.values(LISTS);
    expect(lists.reduce((sum, tools) => sum + toolListFloorBytes(tools), 0)).toBeGreaterThan(ANTIGRAVITY_CLI_TOOL_BUDGET + 8_000);
    // Every tool kept and each list at its shortest: what the app showed before it chose what to leave out.
    const share = Math.floor(ANTIGRAVITY_CLI_TOOL_BUDGET / lists.length);
    const unchosen = Object.fromEntries(Object.entries(LISTS).map(([server, tools]) => [server, fitToolListToShare(tools, share).tools]));
    expect(cliDrops(flat(unchosen), ANTIGRAVITY_CLI_TOOL_BUDGET + definitionListBytes(flat(unchosen)) - definitionListBytes(Object.values(unchosen).flat())))
      .toContain("agents/coordinate_bots");
  });

  it("keeps every coordination tool on session/new, after a model switch, on session/resume after a restart, and in the live session after it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-agy-coordination-"));
    scratch.push(directory);
    const executable = join(directory, "antigravity");
    writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ACP)} "$@"\n`);
    chmodSync(executable, 0o755);
    const dump = join(directory, "dump.json");
    const rpc = join(directory, "rpc.jsonl");
    const integrations = {
      agents: { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { ...BOT } },
      browser: { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_BROWSER: "synthetic-browser" } },
      data: { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "data"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_DATA: "synthetic-data" } },
      composio: { command: process.execPath, args: [SPAWNED_PROXIES.connectors], env: { OMB_BOT_ID: "shop", OMB_CONNECTOR_UPSTREAM_URL: "https://connectors.invalid/mcp" } },
      custom: { shop: { command: "npx", args: ["-y", "shop-mcp"], env: {} }, ts: { command: "npx", args: ["-y", "ts-mcp"], env: {} } },
    };
    // The thread's own calls: a session the driver opens elsewhere to read the model catalog is not one.
    const setups = () => readFileSync(rpc, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; cwd: string })
      .filter((call) => call.cwd === realpathSync(directory)).map((call) => call.method)
      .filter((method) => method === "session/new" || method === "session/resume" || method === "session/set_model");
    const sentNow = () => JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Sent[];

    let instance = await start(executable, dump, rpc);
    let recorder = recordEvents(instance.adapter);
    const turn = async (text: string, extra: { model?: string; resumeCursor?: string } = {}) => {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-shop", text, cwd: directory, integrations, ...extra });
      expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
    };
    const note = () => (JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8")) as Array<{ text?: string }>)
      .map((block) => block.text ?? "").find((text) => text.startsWith("[Tools left out]"));
    // `relaysAnswered` false: the turn was set up before any relay had answered and recorded its list, as only this fake
    // allows (the CLI lists every server's tools on session setup, before the prompt), so it can name only OpenMausBot's own.
    const check = (sent: Sent[], relaysAnswered = true) => {
      expect(sent.map((server) => server.name).sort()).toEqual(Object.keys(LISTS).sort());
      const lists = shown(sent);
      // The turn names what the lists left out, server by server, so the bot knows what it cannot call.
      const left = Object.entries(LISTS).filter(([server]) => relaysAnswered || ["agents", "browser", "data"].includes(server)).flatMap(([server, tools]) => {
        const kept = new Set(lists[server]!.map((tool) => tool.name));
        return tools.filter((tool) => !kept.has(tool.name)).map((tool) => `${server}/${tool.name}`);
      });
      const named = note() ?? "";
      for (const tool of left) {
        const [server, name] = tool.split("/");
        expect(named).toMatch(new RegExp(`(?:: |; )${server}: (?:[^;]*, )?${name}(?:[,;.]|$)`));
      }
      if (relaysAnswered && !left.length) expect(note()).toBeUndefined();
      for (const name of COORDINATION_TOOLS) expect(named).not.toMatch(new RegExp(`\\b${name}\\b`));
      for (const name of COORDINATION_TOOLS) expect(lists.agents!.map((tool) => tool.name)).toContain(name);
      // Counted as the CLI counts them, each tool by its own name.
      const all = Object.values(lists).flat();
      expect(definitionListBytes(all)).toBeLessThanOrEqual(ANTIGRAVITY_CLI_TOOL_LIMIT);
      expect(cliDrops(all, ANTIGRAVITY_CLI_TOOL_LIMIT)).toEqual([]);
      return lists;
    };

    // session/new: nothing recorded yet, so the person's servers are sized by a reserve.
    await turn("hello");
    expect(setups()).toEqual(["session/new"]);
    check(sentNow(), false);
    const sessionId = (recorder.events.find((event) => event.type === "session.started") as { sessionId: string }).sessionId;

    // A model switch in the same live session: its servers are the ones session/new sent.
    await turn("on the other model", { model: "gemini-4-pro", resumeCursor: sessionId });
    expect(setups().filter((method) => method !== "session/set_model")).toEqual(["session/new"]);
    check(sentNow());

    // A restart: session/resume with every relay's record in place, so every share is sized again.
    await instance.dispose();
    instances.splice(0);
    instance = await start(executable, dump, rpc);
    recorder = recordEvents(instance.adapter);
    await turn("after the restart", { resumeCursor: sessionId });
    expect(setups().filter((method) => method !== "session/set_model")).toEqual(["session/new", "session/resume"]);
    const resumed = sentNow();
    expect(Number(envOf(resumed.find((server) => server.name === "shop")!)[TOOL_LIST_SHARE_ENV])).toBeGreaterThan(0);
    const lists = check(resumed);

    // A third turn in the resumed live session: no new setup, the same lists.
    await turn("third", { resumeCursor: sessionId });
    expect(setups().filter((method) => method !== "session/set_model")).toEqual(["session/new", "session/resume"]);
    expect(shown(sentNow())).toEqual(lists);
  }, 120_000);
});
