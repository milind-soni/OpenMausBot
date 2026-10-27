import { describe, expect, it } from "vitest";

import { aiSignInKey, rankAis } from "./ai-ranking.ts";

type Row = { id: string; driverKind: string; snapshot?: { freeFallback?: boolean } };
const row = (id: string, driverKind: string, snapshot?: Row["snapshot"]): Row => ({ id, driverKind, ...(snapshot ? { snapshot } : {}) });
const ids = (rows: readonly Row[]) => rows.map((entry) => entry.id);

// The default fleet's own order: grok, kimi, droid, cursor, claude, codex, chatgpt, antigravity, opencodeGo, …
const grok = row("grok", "grokAgent");
const kimi = row("kimi", "kimiAgent");
const droid = row("droid", "droidAgent");
const claude = row("claude", "claudeAgent");
const codex = row("codex", "codex");
const chatgpt = row("chatgpt", "codex");
const antigravity = row("antigravity", "antigravityAgent");
const openCodeFree = row("opencodeGo", "opencodeGo", { freeFallback: true });
const openCode = row("opencodeGo", "opencodeGo");
const xai = row("xai", "grok");
const gemini = row("gemini", "geminiAgent");

describe("one ranking of the AIs a new person has", () => {
  it("puts a Claude account first, then a ChatGPT plan, then Gemini, then Grok, then the rest in config order", () => {
    expect(ids(rankAis([grok, kimi, droid, claude, codex, chatgpt, antigravity, openCodeFree])))
      .toEqual(["claude", "codex", "chatgpt", "antigravity", "grok", "kimi", "droid", "opencodeGo"]);
    expect(ids(rankAis([xai, gemini, kimi]))).toEqual(["gemini", "xai", "kimi"]);
  });

  it("keeps OpenCode on free models only last, and a signed-in OpenCode among the rest", () => {
    expect(ids(rankAis([openCodeFree, kimi]))).toEqual(["kimi", "opencodeGo"]);
    expect(ids(rankAis([openCode, kimi]))).toEqual(["opencodeGo", "kimi"]);
    expect(ids(rankAis([openCodeFree]))).toEqual(["opencodeGo"]);
  });

  it("never reorders the list it is given", () => {
    const list = [grok, claude];
    rankAis(list);
    expect(ids(list)).toEqual(["grok", "claude"]);
    expect(rankAis([])).toEqual([]);
  });
});

describe("a sign-in, as a test result's key", () => {
  it("changes when the sign-in changes, and only then", () => {
    const signedIn = { state: "available", authenticated: true, account: { email: "a@example.test" } };
    expect(aiSignInKey(signedIn)).toBe(aiSignInKey({ ...signedIn, version: "2.0.0" }));
    expect(aiSignInKey(signedIn)).not.toBe(aiSignInKey({ ...signedIn, account: { email: "b@example.test" } }));
    expect(aiSignInKey(signedIn)).not.toBe(aiSignInKey({ ...signedIn, authenticated: false }));
    expect(aiSignInKey({ state: "available", authenticated: true, freeFallback: true }))
      .not.toBe(aiSignInKey({ state: "available", authenticated: true }));
  });
});
