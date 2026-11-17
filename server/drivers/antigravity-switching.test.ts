import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareAntigravityProfile,
  handleQuotaExhaustedWithAutoSwitch,
  PROXY_ENV_KEYS,
} from "./antigravity-acp.ts";
import {
  startAntigravityWatcher,
  stopAntigravityWatcher,
  getAntigravityWatcher,
  type AntigravityRuntime,
} from "./antigravity-runtime.ts";
import { GeminiCredentialsWatcher } from "./antigravity-credentials-watcher.ts";
import { AntigravityDriver, AcpAntigravityDriver } from "./antigravity.ts";
import * as antigravityAcp from "./antigravity-acp.ts";
import type { RuntimeEvent, RuntimeEventListener } from "../contracts.ts";

describe("Antigravity Proxy & Auto Switching", () => {
  let tempDir: string;
  let fakeRuntime: AntigravityRuntime;
  const createdInstances: any[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omb-switching-test-"));
    fakeRuntime = {
      executablePath: "fake/path/to/agy_acp_server",
      harnessPath: "fake/path/to/harness",
      source: "managed",
      version: "1.4.3",
    };
  });

  afterEach(async () => {
    for (const inst of createdInstances) {
      await inst.dispose?.().catch(() => {});
    }
    createdInstances.length = 0;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("prepareAntigravityProfile with Proxy Injection", () => {
    it("dynamically injects all proxy environment variables (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, http_proxy, https_proxy, all_proxy) when account has bound proxy", async () => {
      const toolsDir = join(tempDir, ".antigravity_tools");
      const geminiDir = join(tempDir, ".gemini");
      await mkdir(toolsDir, { recursive: true });
      await mkdir(geminiDir, { recursive: true });

      const guiConfig = {
        proxy_pool: {
          enabled: true,
          proxies: [
            { id: "proxy-123", url: "http://127.0.0.1:10809", enabled: true },
          ],
          account_bindings: {
            "uuid-frank": "proxy-123",
          },
        },
      };
      const accountsIndex = {
        accounts: [
          { id: "uuid-frank", email: "frank@example.com" },
        ],
      };
      await writeFile(join(toolsDir, "gui_config.json"), JSON.stringify(guiConfig));
      await writeFile(join(toolsDir, "accounts.json"), JSON.stringify(accountsIndex));
      await writeFile(join(geminiDir, "google_accounts.json"), JSON.stringify({ active: "frank@example.com" }));

      const profile = await prepareAntigravityProfile({
        instanceId: "test-instance",
        runtime: fakeRuntime,
        profileDirectory: join(tempDir, "profile"),
        baseEnv: {},
        toolsDir,
        geminiDir,
      });

      expect(profile.assignedProxy).toBe("http://127.0.0.1:10809");
      expect(profile.activeEmail).toBe("frank@example.com");

      // Verify all 6 proxy keys are set
      for (const key of PROXY_ENV_KEYS) {
        expect(profile.environment[key]).toBe("http://127.0.0.1:10809");
      }
    });

    it("deletes all proxy environment variables (both upper and lowercase) when account has proxy disabled or not configured, even if present in baseEnv", async () => {
      const toolsDir = join(tempDir, ".antigravity_tools");
      const geminiDir = join(tempDir, ".gemini");
      await mkdir(toolsDir, { recursive: true });
      await mkdir(geminiDir, { recursive: true });

      const guiConfig = {
        proxy_pool: {
          enabled: true,
          proxies: [{ id: "proxy-123", url: "http://127.0.0.1:10809", enabled: true }],
          account_bindings: { "uuid-frank": "proxy-123" },
        },
      };
      const accountsIndex = {
        accounts: [
          { id: "uuid-frank", email: "frank@example.com", proxy_disabled: true },
        ],
      };
      await writeFile(join(toolsDir, "gui_config.json"), JSON.stringify(guiConfig));
      await writeFile(join(toolsDir, "accounts.json"), JSON.stringify(accountsIndex));
      await writeFile(join(geminiDir, "google_accounts.json"), JSON.stringify({ active: "frank@example.com" }));

      // Parent environment has residual proxy variables
      const baseEnv: Record<string, string> = {
        HTTP_PROXY: "http://parent-proxy:8080",
        HTTPS_PROXY: "http://parent-proxy:8080",
        ALL_PROXY: "http://parent-proxy:8080",
        http_proxy: "http://parent-proxy:8080",
        https_proxy: "http://parent-proxy:8080",
        all_proxy: "http://parent-proxy:8080",
      };

      const profile = await prepareAntigravityProfile({
        instanceId: "test-instance-disabled",
        runtime: fakeRuntime,
        profileDirectory: join(tempDir, "profile-disabled"),
        baseEnv,
        toolsDir,
        geminiDir,
      });

      expect(profile.assignedProxy).toBeUndefined();
      // Verify all 6 proxy keys are removed from the environment
      for (const key of PROXY_ENV_KEYS) {
        expect(profile.environment[key]).toBeUndefined();
      }
    });
  });

  describe("GeminiCredentialsWatcher parent directory creation", () => {
    it("ensures targetTokenPath parent directory is created if it does not exist before writing token", async () => {
      const geminiDir = join(tempDir, ".gemini-dir");
      const targetTokenPath = join(tempDir, "non-existent-subfolder", "nested", "acp_token.json");
      await mkdir(geminiDir, { recursive: true });

      const oauthCreds = {
        refresh_token: "test-refresh-token-123",
        scope: "email profile",
      };
      await writeFile(join(geminiDir, "oauth_creds.json"), JSON.stringify(oauthCreds));

      const watcher = new GeminiCredentialsWatcher("test-instance", undefined, {
        geminiDir,
        targetTokenPath,
        debounceMs: 50,
      });

      expect(existsSync(join(tempDir, "non-existent-subfolder", "nested"))).toBe(false);

      const syncResult = await (watcher as any).syncCredentials();
      expect(syncResult).toBe(true);
      expect(existsSync(targetTokenPath)).toBe(true);
    });
  });

  describe("handleQuotaExhaustedWithAutoSwitch", () => {
    it("calls tools API and awaits watcher token update", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const fakeWatcher = {
        waitForNewToken: vi.fn(async () => true),
      };

      const result = await handleQuotaExhaustedWithAutoSwitch(fakeWatcher, 500, "http://127.0.0.1:8045/api/accounts/switch_next");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:8045/api/accounts/switch_next",
        expect.objectContaining({ method: "POST" }),
      );
      expect(fakeWatcher.waitForNewToken).toHaveBeenCalledWith(500);
      expect(result).toBe(true);

      fetchSpy.mockRestore();
    });

    it("returns false if watcher times out", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response("error", { status: 500 });
      });

      const fakeWatcher = {
        waitForNewToken: vi.fn(async () => false),
      };

      const result = await handleQuotaExhaustedWithAutoSwitch(fakeWatcher, 50);
      expect(result).toBe(false);

      fetchSpy.mockRestore();
    });
  });

  describe("Lifecycle Management: startAntigravityWatcher & stopAntigravityWatcher", () => {
    it("manages watcher per instanceId", async () => {
      const instanceId = "instance-lifecycle-test";
      const switched = vi.fn();
      const geminiDir = join(tempDir, ".gemini-lifecycle");
      await mkdir(geminiDir, { recursive: true });

      const watcher = startAntigravityWatcher(instanceId, switched, {
        geminiDir,
      });

      expect(getAntigravityWatcher(instanceId)).toBe(watcher);

      stopAntigravityWatcher(instanceId);
      expect(getAntigravityWatcher(instanceId)).toBeUndefined();
    });
  });

  describe("AntigravityDriver 429 Retry, Event Swallowing, TurnId Remapping, and Cleanup", () => {
    it("swallows 429 runtime.error and immediate turn.completed, auto-switches, retries with remapped turnId, and cleans up activeTurns", async () => {
      let registeredListener: RuntimeEventListener | undefined;
      const baseSendTurn = vi.fn();
      const baseStopAll = vi.fn().mockResolvedValue(undefined);

      const fakeBase = {
        adapter: {
          sendTurn: baseSendTurn,
          onEvent: (l: RuntimeEventListener) => {
            registeredListener = l;
            return () => {};
          },
          stopAll: baseStopAll,
          interruptTurn: vi.fn().mockResolvedValue(undefined),
        },
        dispose: vi.fn().mockResolvedValue(undefined),
        models: { default: "test-model", options: [] },
      };

      vi.spyOn(AcpAntigravityDriver, "create").mockResolvedValue(fakeBase as any);

      let switchResolve: (value: boolean) => void = () => {};
      const switchPromise = new Promise<boolean>((resolve) => {
        switchResolve = resolve;
      });
      vi.spyOn(antigravityAcp, "handleQuotaExhaustedWithAutoSwitch").mockImplementation(async () => switchPromise);

      const driverInstance = await AntigravityDriver.create({
        instanceId: "driver-retry-test",
        displayName: "Antigravity Test",
        enabled: true,
        config: { cli: "fake", fullAuto: false },
        environment: {},
      });
      createdInstances.push(driverInstance);

      const receivedEvents: RuntimeEvent[] = [];
      driverInstance.adapter.onEvent((ev) => {
        receivedEvents.push(ev);
      });

      // 1. Initial sendTurn returns turnId-1
      baseSendTurn.mockResolvedValueOnce({ turnId: "turnId-1" });
      const initialAck = await driverInstance.adapter.sendTurn({
        threadId: "thread-1",
        text: "hello",
      });
      expect(initialAck.turnId).toBe("turnId-1");

      // 2. Subordinate emits 429 runtime.error followed immediately by turn.completed (race condition)
      expect(registeredListener).toBeDefined();

      registeredListener!({
        type: "runtime.error",
        threadId: "thread-1",
        turnId: "turnId-1",
        createdAt: new Date().toISOString(),
        acpUsageLimit: true,
      } as any);

      registeredListener!({
        eventId: "ev-comp-1",
        provider: "antigravity",
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turnId-1",
        createdAt: new Date().toISOString(),
        ok: false,
        stopReason: "error",
      } as RuntimeEvent);

      // Both events must be SWALLOWED during retrying!
      expect(receivedEvents).toHaveLength(0);

      // 3. Complete auto-switch successfully and set up retry sendTurn returning turnId-2
      baseSendTurn.mockResolvedValueOnce({ turnId: "turnId-2" });
      switchResolve(true);

      // Wait a microtask tick for async retry to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(baseStopAll).toHaveBeenCalled();
      expect(baseSendTurn).toHaveBeenCalledTimes(2);

      // 4. Retried turn emits progress with new turnId (turnId-2)
      registeredListener!({
        type: "turn.progress",
        threadId: "thread-1",
        turnId: "turnId-2",
        createdAt: new Date().toISOString(),
        text: "thinking...",
      } as any);

      // Must be remapped to original turnId-1 for upstream scheduler
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].turnId).toBe("turnId-1");

      // 5. Retried turn completes successfully
      registeredListener!({
        eventId: "ev-comp-2",
        provider: "antigravity",
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turnId-2",
        createdAt: new Date().toISOString(),
        ok: true,
        stopReason: "end_turn",
      } as RuntimeEvent);

      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[1].turnId).toBe("turnId-1");
      expect((receivedEvents[1] as any).ok).toBe(true);
    });

    it("cleans up activeTurns when a turn completes with ok: false (non-quota error)", async () => {
      let registeredListener: RuntimeEventListener | undefined;
      const baseSendTurn = vi.fn();

      const fakeBase = {
        adapter: {
          sendTurn: baseSendTurn,
          onEvent: (l: RuntimeEventListener) => {
            registeredListener = l;
            return () => {};
          },
          stopAll: vi.fn().mockResolvedValue(undefined),
          interruptTurn: vi.fn().mockResolvedValue(undefined),
        },
        dispose: vi.fn().mockResolvedValue(undefined),
        models: { default: "test-model", options: [] },
      };

      vi.spyOn(AcpAntigravityDriver, "create").mockResolvedValue(fakeBase as any);

      const driverInstance = await AntigravityDriver.create({
        instanceId: "driver-error-cleanup-test",
        displayName: "Antigravity Test",
        enabled: true,
        config: { cli: "fake", fullAuto: false },
        environment: {},
      });
      createdInstances.push(driverInstance);

      const receivedEvents: RuntimeEvent[] = [];
      driverInstance.adapter.onEvent((ev) => {
        receivedEvents.push(ev);
      });

      baseSendTurn.mockResolvedValueOnce({ turnId: "turn-err-1" });
      await driverInstance.adapter.sendTurn({
        threadId: "thread-err",
        text: "hello",
      });

      // Emit failed turn.completed (ok: false)
      registeredListener!({
        eventId: "ev-comp-err",
        provider: "antigravity",
        type: "turn.completed",
        threadId: "thread-err",
        turnId: "turn-err-1",
        createdAt: new Date().toISOString(),
        ok: false,
        stopReason: "error",
      } as RuntimeEvent);

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].turnId).toBe("turn-err-1");

      // Subsequent quota error event for the same thread should not attempt retry since activeTurns was cleaned up
      const switchSpy = vi.spyOn(antigravityAcp, "handleQuotaExhaustedWithAutoSwitch");
      registeredListener!({
        type: "runtime.error",
        threadId: "thread-err",
        turnId: "turn-err-1",
        createdAt: new Date().toISOString(),
        acpUsageLimit: true,
      } as any);

      expect(switchSpy).not.toHaveBeenCalled();
    });

    it("forwards buffered events and cleans up if auto-switch fails", async () => {
      let registeredListener: RuntimeEventListener | undefined;
      const baseSendTurn = vi.fn();

      const fakeBase = {
        adapter: {
          sendTurn: baseSendTurn,
          onEvent: (l: RuntimeEventListener) => {
            registeredListener = l;
            return () => {};
          },
          stopAll: vi.fn().mockResolvedValue(undefined),
          interruptTurn: vi.fn().mockResolvedValue(undefined),
        },
        dispose: vi.fn().mockResolvedValue(undefined),
        models: { default: "test-model", options: [] },
      };

      vi.spyOn(AcpAntigravityDriver, "create").mockResolvedValue(fakeBase as any);
      vi.spyOn(antigravityAcp, "handleQuotaExhaustedWithAutoSwitch").mockResolvedValue(false);

      const driverInstance = await AntigravityDriver.create({
        instanceId: "driver-switch-fail-test",
        displayName: "Antigravity Test",
        enabled: true,
        config: { cli: "fake", fullAuto: false },
        environment: {},
      });
      createdInstances.push(driverInstance);

      const receivedEvents: RuntimeEvent[] = [];
      driverInstance.adapter.onEvent((ev) => {
        receivedEvents.push(ev);
      });

      baseSendTurn.mockResolvedValueOnce({ turnId: "turn-fail-1" });
      await driverInstance.adapter.sendTurn({
        threadId: "thread-fail",
        text: "hello",
      });

      registeredListener!({
        type: "runtime.error",
        threadId: "thread-fail",
        turnId: "turn-fail-1",
        createdAt: new Date().toISOString(),
        acpUsageLimit: true,
      } as any);

      registeredListener!({
        eventId: "ev-comp-fail",
        provider: "antigravity",
        type: "turn.completed",
        threadId: "thread-fail",
        turnId: "turn-fail-1",
        createdAt: new Date().toISOString(),
        ok: false,
        stopReason: "error",
      } as RuntimeEvent);

      // Wait a tick for switch failure resolution
      await new Promise((r) => setTimeout(r, 50));

      // Both suppressed events must now be delivered to the caller
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[0].type).toBe("runtime.error");
      expect(receivedEvents[1].type).toBe("turn.completed");
    });

    it("does not retry turn if interruptTurn was called during quota recovery", async () => {
      let registeredListener: RuntimeEventListener | undefined;
      const baseSendTurn = vi.fn();
      const baseStopAll = vi.fn().mockResolvedValue(undefined);
      const baseInterruptTurn = vi.fn().mockResolvedValue(undefined);

      const fakeBase = {
        adapter: {
          sendTurn: baseSendTurn,
          onEvent: (l: RuntimeEventListener) => {
            registeredListener = l;
            return () => {};
          },
          stopAll: baseStopAll,
          interruptTurn: baseInterruptTurn,
        },
        dispose: vi.fn().mockResolvedValue(undefined),
        models: { default: "test-model", options: [] },
      };

      vi.spyOn(AcpAntigravityDriver, "create").mockResolvedValue(fakeBase as any);

      let switchResolve: (value: boolean) => void = () => {};
      const switchPromise = new Promise<boolean>((resolve) => {
        switchResolve = resolve;
      });
      vi.spyOn(antigravityAcp, "handleQuotaExhaustedWithAutoSwitch").mockImplementation(async () => switchPromise);

      const driverInstance = await AntigravityDriver.create({
        instanceId: "driver-interrupt-test",
        displayName: "Antigravity Test",
        enabled: true,
        config: { cli: "fake", fullAuto: false },
        environment: {},
      });
      createdInstances.push(driverInstance);

      const events: RuntimeEvent[] = [];
      driverInstance.adapter.onEvent((ev) => events.push(ev));

      baseSendTurn.mockResolvedValueOnce({ turnId: "turn-cancel-1" });
      await driverInstance.adapter.sendTurn({
        threadId: "thread-cancel",
        text: "hello",
      });

      // 429 quota error begins recovery
      registeredListener!({
        type: "runtime.error",
        threadId: "thread-cancel",
        turnId: "turn-cancel-1",
        createdAt: new Date().toISOString(),
        acpUsageLimit: true,
      } as any);

      // User interrupts turn while auto-switch is pending
      await driverInstance.adapter.interruptTurn("thread-cancel", "turn-cancel-1");
      expect(baseInterruptTurn).toHaveBeenCalledWith("thread-cancel", "turn-cancel-1");

      // Auto switch finishes
      switchResolve(true);
      await new Promise((r) => setTimeout(r, 50));

      // Must NOT resend turn because it was canceled
      expect(baseSendTurn).toHaveBeenCalledTimes(1);

      // Must emit a cancelled completion event so the caller is never left hanging
      expect(events.some((e) => e.type === "turn.completed" && e.turnId === "turn-cancel-1")).toBe(true);
    });

    it("broadcasts single event stream to multiple onEvent listeners with remapping", async () => {
      let registeredListener: RuntimeEventListener | undefined;
      const baseSendTurn = vi.fn();

      const fakeBase = {
        adapter: {
          sendTurn: baseSendTurn,
          onEvent: (l: RuntimeEventListener) => {
            registeredListener = l;
            return () => {};
          },
          stopAll: vi.fn().mockResolvedValue(undefined),
          interruptTurn: vi.fn().mockResolvedValue(undefined),
        },
        dispose: vi.fn().mockResolvedValue(undefined),
        models: { default: "test-model", options: [] },
      };

      vi.spyOn(AcpAntigravityDriver, "create").mockResolvedValue(fakeBase as any);

      const driverInstance = await AntigravityDriver.create({
        instanceId: "driver-multi-listener-test",
        displayName: "Antigravity Test",
        enabled: true,
        config: { cli: "fake", fullAuto: false },
        environment: {},
      });
      createdInstances.push(driverInstance);

      const listener1Events: RuntimeEvent[] = [];
      const listener2Events: RuntimeEvent[] = [];

      const unsub1 = driverInstance.adapter.onEvent((ev) => listener1Events.push(ev));
      const unsub2 = driverInstance.adapter.onEvent((ev) => listener2Events.push(ev));

      registeredListener!({
        eventId: "ev-1",
        provider: "antigravity",
        type: "turn.completed",
        threadId: "thread-multi",
        turnId: "turn-multi-1",
        createdAt: new Date().toISOString(),
        ok: true,
        stopReason: "end_turn",
      } as RuntimeEvent);

      expect(listener1Events).toHaveLength(1);
      expect(listener2Events).toHaveLength(1);
      expect(listener1Events[0].eventId).toBe("ev-1");
      expect(listener2Events[0].eventId).toBe("ev-1");

      unsub1();
      registeredListener!({
        eventId: "ev-2",
        provider: "antigravity",
        type: "turn.completed",
        threadId: "thread-multi",
        turnId: "turn-multi-2",
        createdAt: new Date().toISOString(),
        ok: true,
        stopReason: "end_turn",
      } as RuntimeEvent);

      expect(listener1Events).toHaveLength(1);
      expect(listener2Events).toHaveLength(2);

      unsub2();
    });
  });
});
