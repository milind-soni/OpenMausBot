// Exercise real provider adapters against the existing scripted ACP peer.
// These tests prove OMB's flags/settings and handling of residual requests,
// not a native engine's risk classifier or a model's willingness to use tools.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ApprovalMode } from "../../../shared/approval-mode.ts";
import { ensureDirs } from "../../config.ts";
import type { ProviderDriver } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import type { AcpConfig } from "./core.ts";
import { CustomAcpDriver } from "./custom.ts";
import { DroidAgentDriver } from "./droid.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { HermesAgentDriver } from "./hermes.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { createOpenCodeDriver } from "./opencode-go.ts";
import { QwenAgentDriver } from "./qwen.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const OpenCodeDriver = createOpenCodeDriver(async () => ({
  default: "opencode/fixture-model",
  options: [{ id: "opencode/fixture-model", label: "Fixture model" }],
}));

describe("remaining ACP approval mappings", () => {
  // Engines that own an approval ladder spell the turn's level on argv, so the
  // expected command line varies per mode; every other row keeps one fixed argv
  // and steers the whole ladder through OMB. The instance below always stores
  // fullAuto: true, so a mode with no entry here is the proof that the legacy
  // instance flag on its own never adds a bypass flag.
  const cases: {
    driver: ProviderDriver<AcpConfig>;
    argv: string[];
    native?: Partial<Record<ApprovalMode, string[]>>;
  }[] = [
    { driver: OpenCodeDriver, argv: ["acp"] },
    { driver: GeminiAgentDriver, argv: ["--acp"], native: { full: ["--yolo"] } },
    { driver: QwenAgentDriver, argv: ["--acp"], native: { full: ["--yolo"], auto: ["--approval-mode", "auto"] } },
    { driver: KimiAgentDriver, argv: ["acp"] },
    { driver: HermesAgentDriver, argv: ["acp"] },
    { driver: DroidAgentDriver, argv: ["exec", "-o", "acp"] },
    { driver: CustomAcpDriver, argv: [] },
  ];
  it.each(cases)("$driver.driverKind preserves residual requests across Full → Auto → Ask", async ({ driver, argv, native }) => {
    ensureDirs();
    const scratch = mkdtempSync(join(tmpdir(), "omb-approval-matrix-"));
    const dump = join(scratch, "spawn.json");
    const rpcDump = join(scratch, "rpc.json");
    const instance = await driver.create({
      instanceId: `approval-matrix-${driver.driverKind}`,
      displayName: "Approval fixture",
      enabled: true,
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        HERMES_HOME: join(scratch, ".hermes"),
        KIMI_CODE_HOME: join(scratch, ".kimi"),
        OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
        FAKE_ACP_MODE: "permission",
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_RPC_DUMP: rpcDump,
        OPENCODE_API_KEY: "fixture-only",
        OPENCODE_PERMISSION: '{"external_directory":"ask"}',
      },
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    const pidOf = () => JSON.parse(readFileSync(dump, "utf8")).pid as number;
    try {
      // The residual request reaches the user at every level, including the
      // ones an engine claims natively. Full is unsupported on most rows here
      // and must stay interactive even though the instance stored
      // fullAuto=true; where Full is supported the flag tracks the turn's own
      // mode, so the legacy instance value still cannot outrank Ask or Auto.
      for (const approvalMode of ["full", "auto", "ask"] as const) {
        const pidBefore = existsSync(dump) ? pidOf() : null;
        const methodsBefore = existsSync(rpcDump) ? (JSON.parse(readFileSync(rpcDump, "utf8")) as string[]).length : 0;
        const { turnId } = await instance.adapter.sendTurn({
          threadId: "approval-matrix-thread",
          text: "Exercise one provider permission request.",
          cwd: scratch,
          approvalMode,
          ...(approvalMode === "full" ? {} : { resumeCursor: "fake-acp-session" }),
        });
        const opened = await recorder.until((event) => event.type === "request.opened" && event.turnId === turnId);
        expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });
        expect(recorder.events.some((event) => event.type === "turn.completed" && event.turnId === turnId)).toBe(false);
        const respawned = pidOf() !== pidBefore;
        // a pooled child never rewrites its spawn dump, so argv and env are
        // evidence only for a turn that really spawned a process
        if (respawned) {
          expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual([...argv, ...(native?.[approvalMode] ?? [])]);
          if (driver === OpenCodeDriver) {
            const permission = JSON.parse(JSON.parse(readFileSync(dump, "utf8")).env.OPENCODE_PERMISSION);
            expect(permission).toMatchObject({ external_directory: approvalMode === "full" ? "allow" : "ask" });
            if (approvalMode === "full") expect(permission).toMatchObject({ "*": "allow", read: "allow", bash: "allow", edit: "allow" });
            else expect(permission).toEqual({ external_directory: "ask" });
          }
        }
        // Agent processes are pooled per spawn contract: a turn whose mode
        // changed the contract respawns (fresh dump pid) and must establish
        // its session — session/new for the cursorless full turn, the
        // cursor's session/load otherwise. A reused pooled child skips
        // establishment and prompts the live session instead. A respawn
        // rewrites the rpc dump, a reuse appends to it, so only the methods
        // past the pre-turn baseline are this turn's.
        const methods = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
        const turnMethods = respawned ? methods : methods.slice(methodsBefore);
        if (respawned) {
          expect(turnMethods).toContain(approvalMode === "full" ? "session/new" : "session/load");
        } else {
          expect(turnMethods).toContain("session/prompt");
          expect(turnMethods).not.toContain("session/new");
          expect(turnMethods).not.toContain("session/load");
        }
        if (driver === DroidAgentDriver) {
          const settings = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
          expect(settings[0]).toEqual({
            method: "session/set_mode",
            params: { sessionId: "fake-acp-session", modeId: "normal" },
          });
        }
        expect(await instance.adapter.respondToRequest("approval-matrix-thread", opened.requestId!, { behavior: "deny" }))
          .toBe("rejected");
        expect(await recorder.until((event) => event.type === "request.resolved" && event.turnId === turnId))
          .toMatchObject({ behavior: "deny", source: "user" });
        await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      }
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });
});
