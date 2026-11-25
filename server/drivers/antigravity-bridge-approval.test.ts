import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { BRIDGE_CLI_ENV, TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { unbridgeableFile, unbridgeableVersions } from "./antigravity-bridge-memory.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const WINDOWS = process.platform === "win32";
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const instance of instances.splice(0)) await instance.dispose();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

/** As native Antigravity 1.5.14 and 1.5.16 ask: name mcp_agents_<tool>, title Run mcp_agents_<tool>, kind other. */
const native = (tool: string, rawInput: object, extra: object = {}) => ({
  toolCallId: "call_1", name: `mcp_agents_${tool}`, title: `Run mcp_agents_${tool}`, kind: "other", rawInput: { ...rawInput, toolSummary: "x" }, ...extra,
});
const ONCE = [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }];

interface Asked {
  card: boolean;
  answer: string;
  opened?: { tool?: string; summary?: string; commandLine?: string; allowSession?: boolean };
  errors: string[];
  completed: boolean;
}

describe.skipIf(WINDOWS)("an Antigravity permission request on a turn whose agents tools are bridged", () => {
  async function asked(name: string, options: {
    /** "auto" is an instance set to full access with no level on the turn: the driver answers alone. */
    approvalMode: "edits" | "full" | "auto";
    toolCall: object;
    permissionOptions?: object[];
    bridged?: boolean;
    decidedCli?: string;
    mountData?: boolean;
    version?: string;
  }): Promise<Asked> {
    const directory = mkdtempSync(join(tmpdir(), "omb-agy-bridge-"));
    scratch.push(directory);
    const executable = join(directory, "antigravity");
    writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ACP)} "$@"\n`);
    chmodSync(executable, 0o755);
    const answer = join(directory, "answer");
    writeFileSync(answer, "none");
    ensureDirs();
    const instance = await AntigravityDriver.create({
      instanceId: `agy-bridge-${name}`, displayName: "Antigravity", enabled: true, config: { cli: executable, fullAuto: options.approvalMode === "auto" },
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_AGENT_NAME: "Antigravity ACP Server", FAKE_ACP_VERSION: options.version ?? "1.5.16", FAKE_ACP_AGENT_VERSION: options.version ?? "1.5.16",
        FAKE_ACP_MODES: "default,plan", FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: answer,
        FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify(options.toolCall), FAKE_ACP_PERMISSION_OPTIONS: JSON.stringify(options.permissionOptions ?? ONCE),
      },
    });
    instances.push(instance);
    const bridged = options.bridged !== false;
    const agents = { command: process.execPath, args: ["-e", ""], env: { [TOOL_BRIDGE_ENV]: bridged ? "1" : "0", ...(bridged ? { [BRIDGE_CLI_ENV]: options.decidedCli ?? executable } : {}) } };
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: name, text: "hello", ...(options.approvalMode === "auto" ? {} : { approvalMode: options.approvalMode }), cwd: directory, integrations: { agents, ...(options.mountData ? { data: { command: process.execPath, args: ["-e", ""], env: {} } } : {}) } });
    const first = await recorder.until((event) => event.turnId === turnId && (event.type === "request.opened" || event.type === "turn.completed"));
    if (first.type === "request.opened") await instance.adapter.respondToRequest(name, (first as { requestId: string }).requestId, { behavior: "deny" });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000).then(() => true, () => false);
    const opened = recorder.events.find((event) => event.type === "request.opened") as Asked["opened"];
    const errors = recorder.events.flatMap((event) => event.type === "runtime.error" ? [String((event as { message?: unknown }).message)] : []);
    return { card: opened !== undefined, answer: readFileSync(answer, "utf8"), opened, errors, completed: done };
  }

  it("judges use_tool as the tool it names: a command the never-list stops gets the card a direct call gets, even on full access", async () => {
    vi.stubEnv("OMB_SAFETY_FLOOR", "1");
    expect(unbridgeableVersions()).toEqual([]);
    const direct = await asked("floor-direct", { approvalMode: "auto", toolCall: native("vm_exec", { command: "rm -rf ~" }) });
    const wrapped = await asked("floor-wrapped", { approvalMode: "auto", toolCall: native("use_tool", { name: "vm_exec", arguments: { command: "rm -rf ~" } }) });
    expect(direct).toMatchObject({ card: true, opened: { tool: "other", summary: "rm -rf ~", commandLine: "rm -rf ~" } });
    expect(wrapped).toMatchObject({ card: true, opened: { tool: "other", summary: "rm -rf ~", commandLine: "rm -rf ~" } });
    expect(wrapped.opened?.allowSession).toBeUndefined();
    expect(direct.opened?.allowSession).toBe(true);
  }, 90_000);

  it("answers a harmless use_tool on full access once, never for the session", async () => {
    const result = await asked("use-full", {
      approvalMode: "auto", toolCall: native("use_tool", { name: "list_threads" }),
      permissionOptions: [{ optionId: "always", kind: "allow_always" }, { optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
    });
    expect(result).toMatchObject({ card: false, answer: "allow", completed: true });
  }, 90_000);

  it("cancels a use_tool offered only an always-allow, and the turn ends", async () => {
    const result = await asked("use-always-only", {
      approvalMode: "auto", toolCall: native("use_tool", { name: "list_threads", arguments: {} }),
      permissionOptions: [{ optionId: "always", kind: "allow_always" }, { optionId: "deny", kind: "reject_once" }],
    });
    expect(result).toMatchObject({ card: false, answer: "cancelled", completed: true });
  }, 90_000);

  it("cancels a use_tool offered only an always-allow at Ask too, with no card nobody could allow", async () => {
    const result = await asked("use-always-only-ask", {
      approvalMode: "edits", toolCall: native("use_tool", { name: "list_threads", arguments: {} }),
      permissionOptions: [{ optionId: "always", kind: "allow_always" }, { optionId: "deny", kind: "reject_once" }],
    });
    expect(result).toMatchObject({ card: false, answer: "cancelled", completed: true });
  }, 90_000);

  it("shows a use_tool card under the tool it names, with no allow for the session", async () => {
    const result = await asked("use-ask", { approvalMode: "edits", toolCall: native("use_tool", { name: "list_threads", arguments: { limit: 3 } }) });
    expect(result.card).toBe(true);
    expect(result.opened).toMatchObject({ tool: "other", summary: "Run mcp_agents_list_threads" });
    expect(result.opened?.allowSession).toBeUndefined();
    expect(result.answer).toBe("deny");
  }, 90_000);

  it("lets find_tool run without a card at any level", async () => {
    expect(await asked("find-ask", { approvalMode: "edits", toolCall: native("find_tool", { query: "threads" }) })).toMatchObject({ card: false, answer: "allow", completed: true });
  }, 90_000);

  it.each([
    ["the CLI's renamed server", native("4f234205_use_tool", { name: "vm_exec", arguments: { command: "ls" } })],
    ["a name and a title that disagree", native("use_tool", { name: "list_threads" }, { title: "Run mcp_agents_find_tool" })],
    ["a kind other than other", native("use_tool", { name: "list_threads" }, { kind: "edit" })],
    ["Claude's spelling", { toolCallId: "call_1", title: "mcp__agents__use_tool", kind: "other", rawInput: { name: "list_threads" } }],
    ["a server the turn did not mount, carrying use_tool's input", { toolCallId: "call_1", name: "mcp_ghost_run", title: "Run mcp_ghost_run", kind: "other", rawInput: { name: "vm_exec", arguments: { command: "ls" } } }],
    ["a later release's dotted find_tool", { toolCallId: "call_1", name: "mcp.agents.find_tool", title: "Run mcp.agents.find_tool", kind: "other", rawInput: { query: "threads" } }],
    ["an unknown name carrying use_tool's input with null arguments", { toolCallId: "call_1", name: "agents/use_tool", title: "agents/use_tool", kind: "other", rawInput: { name: "list_threads", arguments: null } }],
    ["an unknown name carrying use_tool's input", { toolCallId: "call_1", name: "agents/use_tool", title: "agents/use_tool", kind: "other", rawInput: { name: "vm_exec", arguments: { command: "ls" } } }],
  ])("refuses %s on full access and ends the turn", async (label, toolCall) => {
    const result = await asked(`refuse-${label.replaceAll(/\W+/gu, "-")}`, { approvalMode: "auto", toolCall });
    expect(result).toMatchObject({ card: false, answer: "deny", completed: true });
    expect(result.errors.some((message) => message.includes("tool bridge") && message.includes("From the next message Antigravity CLI 1.5.16 lists the agents tools directly"))).toBe(true);
    expect(unbridgeableVersions()).toEqual(["1.5.16"]);
  }, 90_000);

  it("rejects a use_tool in the recorded spelling that names no tool, and leaves its release bridged", async () => {
    const result = await asked("use-no-name", { approvalMode: "auto", version: "1.5.19", toolCall: native("use_tool", {}) });
    expect(result).toMatchObject({ answer: "deny", card: false });
    expect(result.errors.some((message) => message.includes("tool bridge"))).toBe(false);
    expect(unbridgeableVersions()).not.toContain("1.5.19");
  }, 90_000);

  it("leaves a direct agents call in another separator alone, before any bridged call", async () => {
    const attach = { toolCallId: "call_1", name: "mcp.agents.attach_file", title: "Run mcp.agents.attach_file", kind: "other", rawInput: { path: "report.csv", name: "list_threads" } };
    expect(await asked("direct-dotted", { approvalMode: "auto", version: "1.5.20", toolCall: attach })).toMatchObject({ card: false, answer: "allow", errors: [] });
    expect(unbridgeableVersions()).not.toContain("1.5.20");
  }, 90_000);

  it("leaves a mounted server's call in another separator alone", async () => {
    const sql = { toolCallId: "call_1", name: "mcp.data.data_sql", title: "Run mcp.data.data_sql", kind: "other", rawInput: { sql: "SELECT 1", name: "list_threads" } };
    expect(await asked("data-sql-dotted", { approvalMode: "auto", toolCall: sql, mountData: true })).toMatchObject({ card: false, answer: "allow", errors: [] });
  }, 90_000);

  it("still refuses and ends the turn when the record cannot be saved, and says the bridge stays on", async () => {
    const record = unbridgeableFile();
    rmSync(record, { force: true });
    mkdirSync(record, { recursive: true });
    try {
      const result = await asked("record-unsaved", { approvalMode: "auto", version: "1.5.18", toolCall: native("4f234205_use_tool", { name: "list_threads" }) });
      expect(result).toMatchObject({ card: false, answer: "deny", completed: true });
      expect(result.errors.some((message) => message.includes("stays on for Antigravity CLI 1.5.18: its record could not be saved"))).toBe(true);
    } finally {
      rmSync(record, { recursive: true, force: true });
    }
  }, 90_000);

  it("leaves a direct agents call whose input happens to have a catalog tool's name alone", async () => {
    const direct = native("attach_file", { path: "report.csv", name: "list_threads" });
    expect(await asked("direct-full", { approvalMode: "auto", toolCall: direct })).toMatchObject({ card: false, answer: "allow" });
    expect(await asked("direct-ask", { approvalMode: "edits", toolCall: direct })).toMatchObject({ card: true, opened: { allowSession: true } });
  }, 90_000);

  it("leaves another server's call whose input happens to have a catalog tool's name alone", async () => {
    const sql = { toolCallId: "call_1", name: "mcp_data_data_sql", title: "Run mcp_data_data_sql", kind: "other", rawInput: { sql: "SELECT 1", name: "list_threads", toolSummary: "x" } };
    expect(await asked("data-sql", { approvalMode: "auto", toolCall: sql, mountData: true })).toMatchObject({ card: false, answer: "allow", errors: [] });
  }, 90_000);

  it("leaves another server's find_tool to the ordinary approval", async () => {
    const other = { toolCallId: "call_1", name: "mcp_team_agents_find_tool", title: "Run mcp_team_agents_find_tool", kind: "other", rawInput: { query: "x" } };
    expect(await asked("third-party", { approvalMode: "edits", toolCall: other })).toMatchObject({ card: true, opened: { allowSession: true }, completed: true });
  }, 90_000);

  it("answers use_tool as before on a turn that is not bridged", async () => {
    expect(await asked("unbridged", { approvalMode: "auto", bridged: false, toolCall: native("use_tool", { name: "list_threads" }) })).toMatchObject({ card: false, answer: "allow" });
  }, 90_000);

  it("does not start a bridged turn on a CLI other than the one it was decided for", async () => {
    const result = await asked("changed-cli", { approvalMode: "auto", decidedCli: "/elsewhere/antigravity", toolCall: native("use_tool", { name: "list_threads" }) });
    expect(result).toMatchObject({ card: false, answer: "none", completed: true });
    expect(result.errors.some((message) => message.includes("changed while this message was being set up"))).toBe(true);
  }, 90_000);
});
