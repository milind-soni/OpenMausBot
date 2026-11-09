// Changes: Created unit tests for Mola provider functions.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  molaNameFor,
  molaNameMatchesBot,
  isolatedRemoteCommand,
  MAX_REMOTE_COMMAND_LENGTH,
  molaConfigured,
  describeMolaAccount,
  verifyToken,
  getMolaViewerOrigin,
  runCommand,
} from "./mola.ts";
import type { AppConfig } from "./config.ts";

describe("Mola provider", () => {
  describe("molaNameFor", () => {
    it("generates a scoped name for a bot", async () => {
      const name = await molaNameFor("test-bot-123");
      // Pattern: ogb-<scope12>-<prefix>-<hash6>
      expect(name).toMatch(/^ogb-[a-f0-9]{12}-[a-z0-9]{1,8}-[a-f0-9]{6}$/);
    });

    it("generates consistent names for the same bot", async () => {
      const name1 = await molaNameFor("my-bot");
      const name2 = await molaNameFor("my-bot");
      expect(name1).toBe(name2);
    });

    it("generates different names for different bots", async () => {
      const name1 = await molaNameFor("bot-a");
      const name2 = await molaNameFor("bot-b");
      expect(name1).not.toBe(name2);
    });
  });

  describe("molaNameMatchesBot", () => {
    it("matches current scoped name", async () => {
      const botId = "test-bot";
      const name = await molaNameFor(botId);
      expect(await molaNameMatchesBot(botId, name)).toBe(true);
    });

    it("does not match wrong bot", async () => {
      const name = await molaNameFor("bot-a");
      expect(await molaNameMatchesBot("bot-b", name)).toBe(false);
    });
  });

  describe("isolatedRemoteCommand", () => {
    it("wraps a command in an isolated environment", () => {
      const cmd = isolatedRemoteCommand("ls -la");
      expect(cmd).toContain("exec env -i");
      expect(cmd).toContain('/bin/bash -c');
      expect(cmd).toContain("ls -la");
    });

    it("escapes single quotes in commands", () => {
      const cmd = isolatedRemoteCommand("echo 'hello'");
      expect(cmd).toContain("'\\''");
    });
  });

  describe("molaConfigured", () => {
    it("returns false when no token is configured", () => {
      const cfg: AppConfig = {};
      expect(molaConfigured(cfg)).toBe(false);
    });

    it("returns true when token is configured", () => {
      const cfg: AppConfig = { mola: { token: "test-token" } };
      expect(molaConfigured(cfg)).toBe(true);
    });
  });

  describe("describeMolaAccount", () => {
    it("reports not configured when no token", () => {
      const cfg: AppConfig = {};
      expect(describeMolaAccount(cfg)).toEqual({ configured: false });
    });

    it("reports configured when token exists", () => {
      const cfg: AppConfig = { mola: { token: "test-token" } };
      expect(describeMolaAccount(cfg)).toEqual({ configured: true });
    });
  });

  describe("verifyToken", () => {
    const originalFetch = global.fetch;
    
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.stubGlobal("fetch", originalFetch);
    });

    it("returns ok true for valid token", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const result = await verifyToken("valid-token");
      expect(result).toEqual({ ok: true });
    });

    it("returns error for 401 status", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const result = await verifyToken("invalid-token");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejected).toBe(true);
      }
    });

    it("returns error for network failure", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

      const result = await verifyToken("test-token");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("Couldn't reach");
      }
    });
  });

  describe("command length validation", () => {
    it("has a reasonable max command length", () => {
      expect(MAX_REMOTE_COMMAND_LENGTH).toBe(4_000);
    });
  });

  describe("runCommand timeout clamping", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.stubGlobal("fetch", originalFetch);
    });

    it("clamps timeout to 1-120 seconds range", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ data: { exit_code: 0, stdout: "ok", stderr: "" } }),
      };
      
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);
      
      const cfg: AppConfig = { mola: { token: "test-token" } };
      
      // Test timeout < 1 second (500ms should clamp to 1)
      await runCommand(cfg, "test-id", "echo test", { timeoutMs: 500 });
      let lastCall = vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1];
      let body = JSON.parse((lastCall[1]?.body as string) || "{}");
      expect(body.timeout).toBe(1);
      
      // Test timeout > 120 seconds (180000ms should clamp to 120)
      await runCommand(cfg, "test-id", "echo test", { timeoutMs: 180_000 });
      lastCall = vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1];
      body = JSON.parse((lastCall[1]?.body as string) || "{}");
      expect(body.timeout).toBe(120);
      
      // Test timeout in valid range (60000ms = 60 seconds)
      await runCommand(cfg, "test-id", "echo test", { timeoutMs: 60_000 });
      lastCall = vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1];
      body = JSON.parse((lastCall[1]?.body as string) || "{}");
      expect(body.timeout).toBe(60);
    });

    it("returns truncated flag when output is truncated", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ 
          data: { 
            exit_code: 0, 
            stdout: "partial output...", 
            stderr: "", 
            truncated: true 
          } 
        }),
      };
      
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);
      
      const cfg: AppConfig = { mola: { token: "test-token" } };
      const result = await runCommand(cfg, "test-id", "cat /dev/zero | head -c 10M");
      
      expect(result.truncated).toBe(true);
      expect(result.stdout).toBe("partial output...");
    });

    it("returns timedOut flag when command times out", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ 
          data: { 
            exit_code: 124, 
            stdout: "", 
            stderr: "timeout", 
            timed_out: true 
          } 
        }),
      };
      
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);
      
      const cfg: AppConfig = { mola: { token: "test-token" } };
      const result = await runCommand(cfg, "test-id", "sleep 1000");
      
      expect(result.timedOut).toBe(true);
      expect(result.ok).toBe(false);
    });
  });

  describe("getMolaViewerOrigin", () => {
    const originalEnv = process.env.MOLA_VIEWER_ORIGIN;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.MOLA_VIEWER_ORIGIN = originalEnv;
      } else {
        delete process.env.MOLA_VIEWER_ORIGIN;
      }
    });

    it("uses MOLA_VIEWER_ORIGIN env override when set", () => {
      process.env.MOLA_VIEWER_ORIGIN = "https://custom.example.com";
      expect(getMolaViewerOrigin({} as AppConfig)).toBe("https://custom.example.com");
    });

    it("derives from customDomain when configured", () => {
      delete process.env.MOLA_VIEWER_ORIGIN;
      expect(getMolaViewerOrigin({ customDomain: "app.example.com" } as AppConfig)).toBe("https://app.example.com");
      expect(getMolaViewerOrigin({ customDomain: "https://secure.example.com" } as AppConfig)).toBe("https://secure.example.com");
    });

    it("derives from cliStartup.publicUrl when configured", () => {
      delete process.env.MOLA_VIEWER_ORIGIN;
      expect(getMolaViewerOrigin({ cliStartup: { access: "public-url", publicUrl: "https://public.example.com" } } as AppConfig)).toBe("https://public.example.com");
    });

    it("prefers customDomain over publicUrl", () => {
      delete process.env.MOLA_VIEWER_ORIGIN;
      expect(
        getMolaViewerOrigin({
          customDomain: "custom.example.com",
          cliStartup: { access: "public-url", publicUrl: "https://public.example.com" },
        } as AppConfig)
      ).toBe("https://custom.example.com");
    });

    it("throws when no valid origin is configured", () => {
      delete process.env.MOLA_VIEWER_ORIGIN;
      expect(() => getMolaViewerOrigin({} as AppConfig)).toThrow(/Cannot determine viewer origin/);
      expect(() => getMolaViewerOrigin({} as AppConfig)).toThrow(/MOLA_VIEWER_ORIGIN/);
    });

    it("strips trailing slashes from URLs", () => {
      delete process.env.MOLA_VIEWER_ORIGIN;
      expect(getMolaViewerOrigin({ customDomain: "app.example.com/" } as AppConfig)).toBe("https://app.example.com");
      expect(getMolaViewerOrigin({ cliStartup: { access: "public-url", publicUrl: "https://public.example.com///" } } as AppConfig)).toBe("https://public.example.com");
    });
  });
});
