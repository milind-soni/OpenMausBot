import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareAntigravityProfile,
  handleQuotaExhaustedWithAutoSwitch,
} from "./antigravity-acp.ts";
import {
  startAntigravityWatcher,
  stopAntigravityWatcher,
  getAntigravityWatcher,
  type AntigravityRuntime,
} from "./antigravity-runtime.ts";

describe("Antigravity Proxy & Auto Switching", () => {
  let tempDir: string;
  let fakeRuntime: AntigravityRuntime;

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
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("prepareAntigravityProfile with Proxy Injection", () => {
    it("dynamically injects HTTP_PROXY, HTTPS_PROXY, ALL_PROXY when account has bound proxy", async () => {
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
      expect(profile.environment.HTTP_PROXY).toBe("http://127.0.0.1:10809");
      expect(profile.environment.HTTPS_PROXY).toBe("http://127.0.0.1:10809");
      expect(profile.environment.ALL_PROXY).toBe("http://127.0.0.1:10809");
    });

    it("does not inject proxy when proxy pool is disabled or account has proxy_disabled", async () => {
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

      const profile = await prepareAntigravityProfile({
        instanceId: "test-instance-disabled",
        runtime: fakeRuntime,
        profileDirectory: join(tempDir, "profile-disabled"),
        baseEnv: {},
        toolsDir,
        geminiDir,
      });

      expect(profile.assignedProxy).toBeUndefined();
      expect(profile.environment.HTTP_PROXY).toBeUndefined();
      expect(profile.environment.HTTPS_PROXY).toBeUndefined();
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
});
