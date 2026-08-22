import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import {
  classifyCursorError,
  createCursorAgentDriver,
  CursorAgentDriver,
  decodeCursorAuthStatus,
  decodeCursorAuthText,
  decodeCursorModelCatalog,
  decodeCursorModelText,
  STATIC_CURSOR_MODELS,
} from "./cursor.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("decodeCursorAuthStatus", () => {
  it("reads isAuthenticated from live CLI JSON", () => {
    expect(decodeCursorAuthStatus({ isAuthenticated: true })).toBe(true);
    expect(decodeCursorAuthStatus({ isAuthenticated: false })).toBe(false);
  });

  it("accepts sibling field names without inventing a yes from a missing flag", () => {
    expect(decodeCursorAuthStatus({ authenticated: true })).toBe(true);
    expect(decodeCursorAuthStatus({ loggedIn: false })).toBe(false);
    expect(decodeCursorAuthStatus({ auth: { isAuthenticated: true } })).toBe(true);
    expect(decodeCursorAuthStatus({ email: "user@example.com" })).toBeNull();
    expect(decodeCursorAuthStatus("logged in")).toBeNull();
  });
});

describe("decodeCursorAuthText", () => {
  it("recognizes the documented status output without confusing logged-out text", () => {
    expect(decodeCursorAuthText("✓ Login successful! Logged in")).toBe(true);
    expect(decodeCursorAuthText("Not logged in")).toBe(false);
    expect(decodeCursorAuthText("Cursor Agent CLI")).toBeNull();
  });
});

describe("decodeCursorModelCatalog", () => {
  it("merges live ids onto the static cloud set", () => {
    const catalog = decodeCursorModelCatalog({
      default: "composer-2.5",
      models: [
        { id: "composer-2.5", name: "Composer 2.5" },
        { id: "cursor-live", displayName: "Cursor Live" },
        { id: "bad id" },
        "gpt-5.3-codex",
      ],
    });
    expect(catalog?.default).toBe("composer-2.5");
    expect(catalog?.options.slice(0, STATIC_CURSOR_MODELS.options.length)).toEqual(STATIC_CURSOR_MODELS.options);
    expect(catalog?.options).toContainEqual({ id: "cursor-live", label: "Cursor Live" });
    expect(catalog?.options.some((option) => option.id === "bad id")).toBe(false);
  });

  it("reads { data: [...] } and a bare array", () => {
    expect(decodeCursorModelCatalog({ data: [{ id: "extra-one", label: "Extra One" }] })?.options).toContainEqual({
      id: "extra-one",
      label: "Extra One",
    });
    expect(decodeCursorModelCatalog(["composer-2.5", "brand-new"])?.options).toContainEqual({
      id: "brand-new",
      label: "Brand New",
    });
  });

  it("returns null for an unusable payload so the static fallback can win", () => {
    expect(decodeCursorModelCatalog(null)).toBeNull();
    expect(decodeCursorModelCatalog({ models: [] })).toBeNull();
    expect(decodeCursorModelCatalog({ hello: "world" })).toBeNull();
  });
});

describe("decodeCursorModelText", () => {
  it("parses slug-label lines and (default)/(current) markers", () => {
    const catalog = decodeCursorModelText(`
Available models

auto - Auto (default)
composer-2.5 - Composer 2.5 (current)
cursor-text - Cursor Text
`);
    expect(catalog?.default).toBe("auto");
    expect(catalog?.options).toContainEqual({ id: "cursor-text", label: "Cursor Text" });
    expect(catalog?.options).toContainEqual({ id: "composer-2.5", label: "Composer 2.5" });
  });

  it("falls back to the first parsed id when static default is absent", () => {
    const catalog = decodeCursorModelText("cursor-only - Cursor Only");
    expect(catalog?.default).toBe("cursor-only");
  });
});

describe("classifyCursorError", () => {
  it("maps auth and subscription failures onto provider codes", () => {
    expect(classifyCursorError({ code: -32000, message: "Authentication required" })).toBe("invalid_credentials");
    expect(classifyCursorError(new Error("not logged in"))).toBe("invalid_credentials");
    expect(classifyCursorError(new Error("upgrade your subscription"))).toBe("inactive_subscription");
    expect(classifyCursorError(new Error("model not found"))).toBeUndefined();
  });
});

describe("CursorAgentDriver", () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_AUTH;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    delete process.env.XAI_API_KEY;
    for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
  });

  it("defaults to the unambiguous cursor-agent binary and declares cross-platform setup", () => {
    expect(CursorAgentDriver.decodeConfig(undefined)).toEqual({
      cli: "cursor-agent",
      fullAuto: false,
      workspace: undefined,
    });
    expect(CursorAgentDriver.driverKind).toBe("cursorAgent");
    expect(CursorAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("cursor.com/install"),
      linux: expect.stringContaining("cursor.com/install"),
      win32: expect.stringContaining("cursor.com/install"),
    });
    expect(CursorAgentDriver.install?.signInCommand).toBe("cursor-agent login");
  });

  it("refreshes the catalog from `cursor-agent models` on the instance CLI", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const driver = createCursorAgentDriver();
    const instance = await driver.create({
      instanceId: "cursor-catalog",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(instance.models.options.some((option) => option.id === "cursor-live")).toBe(true);
      expect(instance.models.default).toBe("auto");
    } finally {
      await instance.dispose();
    }
  });

  it("treats CURSOR_API_KEY as signed in without asking the CLI", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-key",
      displayName: "Cursor",
      environment: { CURSOR_API_KEY: "key-from-env" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
    }
  });

  it("reads isAuthenticated from `cursor-agent status --format json`", async () => {
    chmodSync(FAKE_CLI, 0o755);
    process.env.FAKE_ACP_AUTH = "0";
    const loggedOut = await CursorAgentDriver.create({
      instanceId: "cursor-status-out",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await loggedOut.snapshot()).authenticated).toBe(false);
    } finally {
      await loggedOut.dispose();
    }

    delete process.env.FAKE_ACP_AUTH;
    const loggedIn = await CursorAgentDriver.create({
      instanceId: "cursor-status-in",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await loggedIn.snapshot()).authenticated).toBe(true);
    } finally {
      await loggedIn.dispose();
    }
  });

  it("spawns `agent [--force] [--model …] acp` and keeps Cursor credentials", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "omb-cursor-"));
    scratchDirs.push(scratch);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.CURSOR_API_KEY = "cursor-should-keep";
    process.env.XAI_API_KEY = "xai-should-not-leak";

    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-argv",
      displayName: "Cursor",
      environment: { CURSOR_API_KEY: "cursor-should-keep" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-cursor", text: "hi", model: "gpt-5.3-codex" });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv).toEqual(["--force", "--model", "gpt-5.3-codex", "acp"]);
      expect(seen.env.CURSOR_API_KEY).toBe("cursor-should-keep");
      expect(seen.env.XAI_API_KEY).toBeUndefined();

      const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
      expect(applied).toEqual([
        { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "gpt-5.3-codex" } },
      ]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("omits --force when fullAuto is off and still completes a turn", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "omb-cursor-safe-"));
    scratchDirs.push(scratch);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;

    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-safe",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-cursor-safe", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["acp"]);
      expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "cursorAgent")).toBe(true);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("keeps going when session/set_model is missing and argv already pinned the model", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    process.env.FAKE_ACP_MODE = "no-session-config";
    const instance = await CursorAgentDriver.create({
      instanceId: "cursor-old",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-cursor-old", text: "hi", model: "gpt-5.3-codex" });
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      recorder.stop();
      await instance.dispose();
      delete process.env.FAKE_ACP_MODE;
    }
  });
});
