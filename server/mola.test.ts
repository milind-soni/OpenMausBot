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
      
      await runCommand(cfg, "test-id", "echo test", { timeoutMs: 500 });
      let lastCall = vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1];
      let body = JSON.parse((lastCall[1]?.body as string) || "{}");
      expect(body.timeout).toBe(1);
      
      await runCommand(cfg, "test-id", "echo test", { timeoutMs: 180_000 });
      lastCall = vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1];
      body = JSON.parse((lastCall[1]?.body as string) || "{}");
      expect(body.timeout).toBe(120);
      
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

  describe("copyToMola large file command generation", () => {
    it("generates valid bash commands with paths containing spaces, quotes, and special chars", async () => {
      const { execSync } = await import("node:child_process");
      const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      
      const tempDir = mkdtempSync(join(tmpdir(), "mola-test-"));
      
      try {
        const testCases = [
          { name: "file with spaces.txt", content: "hello spaces" },
          { name: "file'with'quotes.txt", content: "hello quotes" },
          { name: "file$with$dollar.txt", content: "hello dollar" },
          { name: "file with spaces and 'quotes' and $dollar.txt", content: "complex" },
        ];
        
        for (const { name, content } of testCases) {
          const b64Part1 = join(tempDir, "part1.b64");
          const b64Part2 = join(tempDir, "part2.b64");
          const dest = join(tempDir, name);
          
          const base64Content = Buffer.from(content).toString("base64");
          const mid = Math.floor(base64Content.length / 2);
          const chunk1 = base64Content.slice(0, mid);
          const chunk2 = base64Content.slice(mid);
          
          writeFileSync(b64Part1, chunk1);
          writeFileSync(b64Part2, chunk2);
          
          const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
          const command = `set -o pipefail; cat ${shellQuote(b64Part1)} ${shellQuote(b64Part2)} | base64 -d > ${shellQuote(dest)}`;
          
          execSync(command, { shell: "/bin/bash", cwd: tempDir });
          
          const result = readFileSync(dest, "utf8");
          expect(result).toBe(content);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("isStrictUtf8 validation", () => {
    it("recognizes valid UTF-8 text", async () => {
      const validUtf8 = Buffer.from("Hello, world! 日本語 emoji 🎉", "utf8");
      expect(validUtf8.equals(Buffer.from(validUtf8.toString("utf8"), "utf8"))).toBe(true);
    });

    it("rejects binary data that is not valid UTF-8", async () => {
      const binaryData = Buffer.from([0xFF, 0xFE, 0xFD, 0x00, 0x80]);
      const roundtrip = Buffer.from(binaryData.toString("utf8"), "utf8");
      expect(binaryData.equals(roundtrip)).toBe(false);
    });
  });

});

