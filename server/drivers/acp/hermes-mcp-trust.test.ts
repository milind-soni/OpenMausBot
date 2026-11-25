import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import { providerToolAllowKey, providerToolConfig } from "../../provider-tool-allow.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { HermesAgentDriver } from "./hermes.ts";
import { hermesPermissionRequest } from "./hermes-mcp-trust.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

// As hermes-agent's acp_adapter/permissions.py sends `_ask_for_call`'s question for a write on an untrusted server.
const message = "MCP tool 'create_issue' on UNTRUSTED server 'linear' wants to run. This tool is write-capable (no readOnlyHint=true annotation) and may modify external state.\n\nArguments:\n  title: Fix login";
const trustAsk = (server = "linear", tool = "create_issue", scope = "once, for this session, or always") => {
  const description = `Server '${server}' is configured 'trust: untrusted'. Approve to run '${tool}' ${scope}, or deny to block it.`;
  return { toolCallId: "perm-check-1", title: `${description}: ${message}`, kind: "execute", status: "pending", rawInput: { command: message, description } };
};
const OPTIONS = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
  { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
  { optionId: "deny", kind: "reject_once", name: "Deny" },
];
const ONCE_ONLY = [OPTIONS[0], OPTIONS[3]];

describe("Hermes MCP trust asks", () => {
  it("names a rememberable ask as its MCP tool, keeping the message and options", () => {
    const params = { sessionId: "s", toolCall: trustAsk(), options: OPTIONS };
    const named = hermesPermissionRequest(params);
    expect(named.toolCall).toMatchObject({ kind: "other", title: "mcp__linear__create_issue", rawInput: { command: message } });
    expect(named.options).toBe(OPTIONS);
  });

  it("leaves one-time asks, shell asks and names that would not read back as one tool as sent", () => {
    const sent = [
      { toolCall: trustAsk("linear", "create_issue", "once"), options: ONCE_ONLY }, // past the spend limit
      { toolCall: trustAsk(), options: ONCE_ONLY },
      { toolCall: { ...trustAsk(), kind: "edit" }, options: OPTIONS },
      { toolCall: { kind: "execute", title: "rm -rf build", rawInput: { command: "rm -rf build", description: "recursive delete" } }, options: OPTIONS },
      { toolCall: trustAsk("my__server"), options: OPTIONS },
      { toolCall: trustAsk("linear_"), options: OPTIONS }, // mcp__linear___create_issue reads back as linear / _create_issue
      { toolCall: trustAsk("linear", "create issue"), options: OPTIONS },
      { toolCall: trustAsk("linear'"), options: OPTIONS },
    ];
    for (const params of sent) expect(hermesPermissionRequest(params)).toBe(params);
  });

  it("keys a grant for a server only Hermes's own config has, never for a device or for another engine", () => {
    const own = providerToolConfig("linear", {}, "hermesAgent");
    const key = providerToolAllowKey("hermes", "mcp__linear__create_issue", own);
    expect(key).toMatch(/^provider-tool:hermes:linear:create_issue:[0-9a-f]{16}$/);
    expect(providerToolAllowKey("hermes", "mcp__linear__create_issue", providerToolConfig("linear", {}, "hermesAgent"))).toBe(key);
    expect(providerToolAllowKey("hermes", "mcp__linear__delete_issue", own)).not.toBe(key);
    expect(providerToolAllowKey("hermes", "mcp__computer__click", providerToolConfig("computer", {}, "hermesAgent"))).toBeNull();
    expect(providerToolConfig("linear", {}, "kimiAgent")).toBeUndefined();
    expect(providerToolConfig("linear", {})).toBeUndefined();
    const configured = { command: "linear-mcp" };
    expect(providerToolConfig("linear", { linear: configured }, "hermesAgent")).toBe(configured);
  });

  it("asks as the MCP tool through the Hermes driver, and Always answers for the session only", async () => {
    ensureDirs();
    const scratch = mkdtempSync(join(tmpdir(), "omb-hermes-trust-"));
    const answer = join(scratch, "answer.txt");
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes-trust",
      displayName: "Hermes trust fixture",
      enabled: true,
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        HERMES_HOME: join(scratch, ".hermes"),
        OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
        FAKE_ACP_MODE: "permission",
        FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify(trustAsk()),
        FAKE_ACP_PERMISSION_OPTIONS: JSON.stringify(OPTIONS),
        FAKE_ACP_PERMISSION_ANSWER: answer,
      },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "hermes-trust-thread", text: "File the issue.", cwd: scratch, approvalMode: "ask" });
      const opened = await recorder.until((event) => event.type === "request.opened" && event.turnId === turnId);
      expect(opened).toMatchObject({ requestType: "permission", tool: "mcp__linear__create_issue", summary: message.slice(0, 200) });
      expect((opened as { command?: unknown }).command).toBeUndefined(); // no shell command to save with its arguments
      await instance.adapter.respondToRequest("hermes-trust-thread", opened.requestId!, { behavior: "allow", always: true });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(readFileSync(answer, "utf8")).toBe("allow_session");
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });
});
