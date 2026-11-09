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
});
