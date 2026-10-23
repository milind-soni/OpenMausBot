// The expected table is written out in full so any change to an engine's flags is a visible diff here.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MAX_CHAT_ROUNDS } from "../drivers/openai-chat-support.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { ENGINE_KINDS, engineCapabilities, replaysTranscriptNatively, type EngineCapabilities } from "./capabilities.ts";

const chat: EngineCapabilities = { resume: false, nativeReviewer: false, full: true, edits: false, stepCap: 64, subagents: false };
 const bare: EngineCapabilities = { resume: true, nativeReviewer: false, full: true, edits: false, subagents: false };

const EXPECTED: Record<string, EngineCapabilities> = {
  claudeAgent: { resume: true, nativeReviewer: true, full: true, edits: true, subagents: false },
  codex: { resume: true, nativeReviewer: true, full: true, edits: false, subagents: false },
  piAgent: bare,
  antigravityAgent: { resume: true, nativeReviewer: false, full: true, edits: true, subagents: false },
  grokAgent: { resume: true, nativeReviewer: true, full: true, edits: true, subagents: false },
  geminiAgent: { resume: true, nativeReviewer: false, full: true, edits: true, subagents: false },
  kimiAgent: bare,
  droidAgent: bare,
  cursorAgent: { resume: true, nativeReviewer: true, full: true, edits: false, subagents: false },
  museCode: { resume: true, nativeReviewer: false, full: true, edits: false, subagents: false },
  opencodeGo: { resume: true, nativeReviewer: false, full: true, edits: false, subagents: false },
  qwenAgent: { resume: true, nativeReviewer: true, full: true, edits: true, subagents: false },
  hermesAgent: bare,
  deepseekAgent: bare,
  clineAgent: { resume: true, nativeReviewer: false, full: true, edits: false, subagents: false },
  customAcp: bare,
  "openai-compat": chat,
  grok: chat,
  minimax: chat,
  mistral: chat,
  cerebras: chat,
  groq: chat,
  meta: chat,
};

describe("engineCapabilities", () => {
  it("has a row for every registered driver, and no row without a driver", () => {
    const registered = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    expect(registered.length).toBeGreaterThan(0);
    for (const kind of registered) {
      expect(ENGINE_KINDS, `${kind} is registered in server/drivers/builtIn.ts but has no row in server/runtime/capabilities.ts`).toContain(kind);
      expect(Object.hasOwn(EXPECTED, kind), `${kind} is registered but this test has no expected row for it`).toBe(true);
    }
    for (const kind of ENGINE_KINDS) expect(registered, `${kind} has a capability row but no registered driver`).toContain(kind);
  });

  it.each(Object.entries(EXPECTED))("%s", (kind, expected) => {
    expect(engineCapabilities(kind)).toEqual(expected);
  });

  it("answers conservatively for an unknown or absent engine, Full aside: every engine runs it", () => {
    const none: EngineCapabilities = { resume: false, nativeReviewer: false, full: true, edits: false, subagents: false };
    expect(engineCapabilities(undefined)).toEqual(none);
    expect(engineCapabilities("someFutureEngine")).toEqual(none);
    expect(engineCapabilities("constructor")).toEqual(none);
    expect(engineCapabilities("__proto__")).toEqual(none);
  });

  it("gives no engine subagents today", () => {
    for (const kind of ENGINE_KINDS) expect(engineCapabilities(kind).subagents).toBe(false);
  });

  it("leaves stepCap off engines that bound their own turns", () => {
    for (const kind of ENGINE_KINDS) {
      const caps = engineCapabilities(kind);
      if (caps.resume) expect("stepCap" in caps, `${kind} keeps a native session and needs no step cap`).toBe(false);
      else expect(caps.stepCap, `${kind} replays the transcript and needs the chat family's cap`).toBe(64);
    }
  });

  it("keeps the chat family's step cap equal to the exported round limit", () => {
    expect(engineCapabilities("openai-compat").stepCap).toBe(MAX_CHAT_ROUNDS);
  });
});

describe("replaysTranscriptNatively", () => {
  const root = fileURLToPath(new URL("../drivers/", import.meta.url));
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [join(dir, entry.name)] : []);
  const chatKinds = sources(root).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    if (!text.includes("createOpenAIChatRuntime(")) return [];
    const kind = /driverKind: "([^"]+)"/.exec(text)?.[1] ?? /DRIVER_KIND = "([^"]+)"/.exec(text)?.[1];
    expect(kind, `${file} calls createOpenAIChatRuntime but declares no readable driverKind`).toBeDefined();
    return [kind!];
  });

  it("finds the chat-completions family", () => {
    expect(chatKinds.length).toBeGreaterThanOrEqual(7);
  });

  it("is true for every driver built on createOpenAIChatRuntime, and for no other", () => {
    for (const kind of BUILT_IN_DRIVERS.map((driver) => driver.driverKind)) {
      expect(replaysTranscriptNatively(kind), kind).toBe(chatKinds.includes(kind));
    }
    expect(replaysTranscriptNatively("someFutureEngine")).toBe(false);
    expect(replaysTranscriptNatively(undefined)).toBe(false);
  });
});
