import { describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

vi.hoisted(() => vi.stubGlobal("window", {}));
const { activityPreview, botEngine, failedTurnCause, signedOutEngine } = await import("./failed-turn");

const engine = (patch: Partial<InstanceInfo> = {}, snapshot: Partial<InstanceInfo["snapshot"]> = {}): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  install: { command: { darwin: "x", linux: "x", win32: "x" }, signInCommand: "claude /login", server: { package: "@anthropic-ai/claude-code" } },
  authentication: { method: "paste-code" },
  models: { default: "sonnet", options: [] },
  ...patch,
  snapshot: { state: "available", authenticated: false, ...snapshot },
} as InstanceInfo);
const loginRow = { name: "error: Not logged in · Please run /login", ok: false, setup: true };

describe("failed turn text", () => {
  it("reads the engine's words out of the row, and nothing out of any other row", () => {
    expect(failedTurnCause("error: Not logged in · Please run /login")).toBe("Not logged in · Please run /login");
    expect(failedTurnCause("Bash")).toBeNull();
    expect(failedTurnCause("notice: retrying")).toBeNull();
  });

  it("says a signed-out engine is signed out instead of the CLI's /login instruction", () => {
    const claude = engine();
    expect(signedOutEngine(loginRow, claude)).toBe(claude);
    // the list says the same, without pointing "below" at a card it does not show
    expect(activityPreview(loginRow, engine())).toBe("Claude isn't signed in");
  });

  it("says Grok Build is signed out through the same rule, now that its card is the in-app code", () => {
    const grokRow = { name: "error: Grok is not signed in to your grok.com account — choose Sign in to Grok in engine setup", ok: false, setup: true };
    const grok = engine({
      instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", authentication: { method: "device-code" },
      install: { command: { darwin: "curl -fsSL https://x.ai/cli/install.sh | bash", linux: "curl -fsSL https://x.ai/cli/install.sh | bash" }, signInCommand: "grok login" },
    } as Partial<InstanceInfo>);
    expect(signedOutEngine(grokRow, grok)).toBe(grok);
    expect(activityPreview(grokRow, grok)).toBe("Grok isn't signed in");
    // no Grok CLI on this server: not a sign-in, so the row keeps the engine's words
    const missing = { ...grok, snapshot: { state: "unavailable" as const, reason: "`grok` CLI not found" } };
    expect(signedOutEngine(grokRow, missing)).toBeUndefined();
  });

  it("keeps the engine's words when there is no sign-in to offer", () => {
    // signed in again: the card is gone, so is the promise of one
    expect(activityPreview(loginRow, engine({}, { authenticated: true }))).toBe("Not logged in · Please run /login");
    // an API-key engine's card is a key row, and its own words say so
    const keyed = engine({ driverKind: "opencode", access: "api" } as Partial<InstanceInfo>, { version: "1" });
    expect(activityPreview({ ...loginRow, name: "error: Add your key in Settings → API keys" }, keyed)).toBe("Add your key in Settings → API keys");
    expect(signedOutEngine(loginRow, keyed)).toBeUndefined();
    // a failure that is not about setup is never blamed on sign-in
    expect(activityPreview({ name: "error: rate limited", ok: false }, engine())).toBe("rate limited");
    expect(activityPreview(loginRow, undefined)).toBe("Not logged in · Please run /login");
    // a too-old Claude Code gets the update offer, never a sign-in promise
    expect(activityPreview({ ...loginRow, name: "error: needs a newer Claude Code", claudeUpdate: true }, engine())).toBe("needs a newer Claude Code");
    // …even on a company-managed Claude, which chat cannot update
    expect(signedOutEngine({ ...loginRow, claudeUpdate: true }, engine({ readOnly: true }))).toBeUndefined();
  });

  it("previews a plan-limit refusal whole and leaves ordinary steps alone", () => {
    const limit = "Your Pro plan includes 2 cloud computers at once. Delete one to start another.";
    expect(activityPreview({ name: `error: ${limit}`, ok: false }, engine())).toBe(limit);
    expect(activityPreview({ name: "Bash", ok: true }, engine())).toBe("Bash");
  });

  it("finds the engine a bot's turns ran on", () => {
    const claude = engine();
    const bot = { modelSelection: { instanceId: "claude", model: "sonnet" } } as Bot;
    expect(botEngine(bot, [claude])).toBe(claude);
    expect(botEngine(undefined, [claude])).toBeUndefined();
  });
});
