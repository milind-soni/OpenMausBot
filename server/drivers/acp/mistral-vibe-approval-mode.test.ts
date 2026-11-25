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
import { MistralVibeAgentDriver, mistralVibeSupport } from "./mistral-vibe.ts";

const FAKE_CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
// vibe-acp 3.1.2's advertised modes.
const VIBE_MODES = "ask,accept-edits,auto-approve";

describe("Mistral Vibe approval mode", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-vibe-mode-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string>) {
    instance = await MistralVibeAgentDriver.create({
      instanceId: "vibe-mode-fixture", displayName: "Mistral (Vibe)", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
      environment: {
        HOME: scratch, USERPROFILE: scratch, VIBE_HOME: join(scratch, ".vibe"), MISTRAL_API_KEY: "fixture-key",
        VIBE_KEYCHAIN_SERVICE: "omb-test-no-such-entry",
        FAKE_ACP_DUMP: join(scratch, "launch.json"),
        FAKE_ACP_RPC_DUMP: join(scratch, "rpc.json"),
        ...environment,
      },
    });
    recorder = recordEvents(instance.adapter);
  }

  const methods = (): string[] => JSON.parse(readFileSync(join(scratch, "rpc.json"), "utf8"));
  const setModes = (): unknown[] => (JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8")) as Array<{ method: string; params: unknown }>)
    .filter((call) => call.method === "session/set_mode").map((call) => call.params);

  async function turn(approvalMode: ApprovalMode, resumeCursor?: string) {
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "vibe-chat", text: "hello", cwd: scratch, approvalMode, resumeCursor });
    return recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
  }

  it.each(["ask", "auto", "full", "custom"] as const)("sends set_mode ask before the prompt at %s", async (approvalMode) => {
    await create({ FAKE_ACP_SESSION_MODES: VIBE_MODES });
    await expect(turn(approvalMode)).resolves.toMatchObject({ ok: true });
    const rpc = methods();
    expect(rpc.indexOf("session/new")).toBeLessThan(rpc.indexOf("session/set_mode"));
    expect(rpc.indexOf("session/set_mode")).toBeLessThan(rpc.indexOf("session/prompt"));
    expect(setModes()).toEqual([{ sessionId: "fake-acp-session", modeId: "ask" }]);
  });

  it("sends it again on a restored session and on each turn of a live one", async () => {
    await create({ FAKE_ACP_SESSION_MODES: VIBE_MODES });
    await expect(turn("ask", "saved-vibe-session")).resolves.toMatchObject({ ok: true });
    expect(methods()).toContain("session/load");
    await expect(turn("ask")).resolves.toMatchObject({ ok: true });
    expect(setModes()).toEqual([
      { sessionId: "saved-vibe-session", modeId: "ask" },
      { sessionId: "saved-vibe-session", modeId: "ask" },
    ]);
  });

  it("sends ask when Vibe advertises no modes", async () => {
    await create({});
    await expect(turn("ask")).resolves.toMatchObject({ ok: true });
    expect(setModes()).toEqual([{ sessionId: "fake-acp-session", modeId: "ask" }]);
  });

  it("fails the turn before the prompt when Vibe does not offer ask", async () => {
    await create({ FAKE_ACP_SESSION_MODES: "accept-edits,auto-approve" });
    await expect(turn("ask")).resolves.toMatchObject({ ok: false });
    expect(methods()).not.toContain("session/set_mode");
    expect(methods()).not.toContain("session/prompt");
    expect(recorder!.events.some((event) => event.type === "runtime.error" && event.message.includes('"ask" mode'))).toBe(true);
  });

  it.each([-32602, -32603])("rethrows a set_mode rejection with code %i", async (code) => {
    const request = async () => { throw Object.assign(new Error("refused"), { code }); };
    await expect(mistralVibeSupport.configureSession!({
      request, sessionId: "s", instanceId: "i", env: {}, config: { cli: "vibe-acp", fullAuto: false }, turn: { approvalMode: "ask" },
      sessionModels: [], configOptions: [], notice: () => {},
    } as unknown as Parameters<NonNullable<typeof mistralVibeSupport.configureSession>>[0])).rejects.toThrow(/session\/set_mode: refused/);
  });

  it("still prompts when the CLI has no session/set_mode", async () => {
    await create({ FAKE_ACP_MODE: "no-session-config" });
    await expect(turn("ask")).resolves.toMatchObject({ ok: true });
    expect(methods()).toContain("session/set_mode");
    expect(methods()).toContain("session/prompt");
  });
});
