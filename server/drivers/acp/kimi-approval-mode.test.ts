import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalMode } from "../../../shared/approval-mode.ts";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { KimiAgentDriver } from "./kimi.ts";

const FAKE_CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
// kimi-code 2.4.1's advertised modes; it reports "default" even when config.toml runs it in yolo or auto.
const KIMI_MODES = "default,plan,auto,yolo";

describe("Kimi approval mode", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-kimi-mode-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string>) {
    instance = await KimiAgentDriver.create({
      instanceId: "kimi-mode-fixture", displayName: "Kimi", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
      environment: {
        HOME: scratch, USERPROFILE: scratch, KIMI_CODE_HOME: join(scratch, ".kimi-code"),
        OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
        FAKE_ACP_DUMP: join(scratch, "launch.json"),
        FAKE_ACP_RPC_DUMP: join(scratch, "rpc.json"),
        ...environment,
      },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  const methods = (): string[] => JSON.parse(readFileSync(join(scratch, "rpc.json"), "utf8"));
  const setModes = (): unknown[] => (JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8")) as Array<{ method: string; params: unknown }>)
    .filter((call) => call.method === "session/set_mode").map((call) => call.params);

  async function turn(approvalMode: ApprovalMode, resumeCursor?: string) {
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "kimi-chat", text: "hello", cwd: scratch, approvalMode, resumeCursor });
    return recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
  }

  it.each(["ask", "edits", "auto", "full"] as const)("sends set_mode default before the prompt at %s although Kimi reports default", async (approvalMode) => {
    await create({ FAKE_ACP_SESSION_MODES: KIMI_MODES });
    await expect(turn(approvalMode)).resolves.toMatchObject({ ok: true });
    const rpc = methods();
    expect(rpc.indexOf("session/new")).toBeLessThan(rpc.indexOf("session/set_mode"));
    expect(rpc.indexOf("session/set_mode")).toBeLessThan(rpc.indexOf("session/prompt"));
    expect(setModes()).toEqual([{ sessionId: "fake-acp-session", modeId: "default" }]);
  });

  it("sends it again on a restored session and on each turn of a live one", async () => {
    await create({ FAKE_ACP_SESSION_MODES: KIMI_MODES });
    await expect(turn("ask", "saved-kimi-session")).resolves.toMatchObject({ ok: true });
    expect(methods()).toContain("session/load");
    await expect(turn("auto")).resolves.toMatchObject({ ok: true });
    expect(setModes()).toEqual([
      { sessionId: "saved-kimi-session", modeId: "default" },
      { sessionId: "saved-kimi-session", modeId: "default" },
    ]);
  });

  it("still prompts when the CLI has no session/set_mode", async () => {
    await create({ FAKE_ACP_MODE: "no-session-config" });
    await expect(turn("ask")).resolves.toMatchObject({ ok: true });
    const rpc = methods();
    expect(rpc).toContain("session/set_mode");
    expect(rpc).toContain("session/prompt");
  });
});
