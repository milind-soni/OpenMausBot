import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { CODEX_USAGE_LIMIT_REACHED, CODEX_USAGE_URL } from "../../shared/codex-usage-limit";
import { failedTurnTool } from "../../shared/failed-turn";
import { PROVIDER_SAFETY_GUIDANCE } from "../../shared/provider-safety";
import { en } from "@/locales";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn(), platform: "other", localReasonCode: "cua-driver-unavailable", localMessage: "" };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: null,
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: fixture.dispatch,
  }) };
});
// The real useCaptionChrome rides along: it only asks this module for the window chrome.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: fixture.platform }, localComputer: { available: false, reasonCode: fixture.localReasonCode, message: fixture.localMessage } }, ready: true }),
}));
const { ErrorRow, FailedTurnRow } = await import("./FailedTurnRow");
const { claudeUpdateTarget, activityPreview } = await import("@/lib/failed-turn");
afterAll(() => vi.unstubAllGlobals());

describe("failed turn controls", () => {
  it("explains provider safety errors without offering an ineffective Retry", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRow, { message: "Blocked by our safety systems", onRetry: () => {} }));
    expect(markup).toContain("Full access controls tool approvals, not provider safety checks");
    expect(markup).not.toContain("<button");
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout", onRetry: () => {} }))).toContain("<button");
  });
  it("shows the provider safety guidance from the catalog, word for word", () => {
    expect(en["chat.providerSafety.guidance"]).toBe(PROVIDER_SAFETY_GUIDANCE);
  });
  it("draws Retry and the next action on the 28px control step", () => {
    const retry = renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout", onRetry: () => {} }));
    const action = renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout", action: { label: "Open", onClick: () => {} } }));
    for (const markup of [retry, action]) {
      expect(markup).toContain('class="ui-button ui-button-md ');
      expect(markup).not.toContain("text-[13px]");
    }
  });
  it("directs ChatGPT plan limits to usage settings rather than repeatedly retrying", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRow, { message: "ChatGPT plan usage limit reached (subscription_sharing_usage_limit_exceeded)", onRetry: () => {} }));
    expect(markup).toContain("Manage usage");
    expect(markup).toContain("https://chatgpt.com/settings/usage");
    expect(markup).not.toContain(">Retry<");
  });
  it("sends a Codex usage limit to the account's Codex usage page, not Retry", () => {
    const codex = { instanceId: "codex", driverKind: "codex", displayName: "Codex", snapshot: { state: "available", authenticated: true } } as unknown as InstanceInfo;
    const limit = `${CODEX_USAGE_LIMIT_REACHED} This is OpenAI's limit, not your MausBot plan. It resets at 5:23 PM (UTC).`;
    const markup = renderToStaticMarkup(createElement(FailedTurnRow, { tool: failedTurnTool(limit), engine: codex, onRetry: () => {} }));
    expect(markup).toContain(limit.replaceAll("'", "&#x27;"));
    expect(markup).toContain(`href="${CODEX_USAGE_URL}"`);
    expect(markup).toContain("Manage usage");
    expect(markup).not.toContain("<button");
  });
  it("turns an expired usage-limit error into history without hiding a new refusal", () => {
    const codex = { instanceId: "codex", driverKind: "codex", displayName: "Codex",
      snapshot: { state: "available", authenticated: true } } as unknown as InstanceInfo;
    const reset = Date.now() - 60_000;
    const limit = failedTurnTool(CODEX_USAGE_LIMIT_REACHED, { limitResetsAt: reset });
    const historical = renderToStaticMarkup(createElement(FailedTurnRow, {
      tool: limit, engine: codex, messageAt: reset - 10_000,
    }));
    expect(historical).toContain("Past usage-limit notice");
    expect(historical).toContain(CODEX_USAGE_LIMIT_REACHED.replaceAll("'", "&#x27;"));
    expect(historical).not.toContain("Manage usage");

    const recent = renderToStaticMarkup(createElement(FailedTurnRow, {
      tool: limit, engine: codex, messageAt: reset + 1_000,
    }));
    expect(recent).not.toContain("Past usage-limit notice");
    expect(recent).toContain("Manage usage");

    const pending = renderToStaticMarkup(createElement(FailedTurnRow, {
      tool: failedTurnTool(CODEX_USAGE_LIMIT_REACHED, { limitResetsAt: Date.now() + 60_000 }),
      engine: codex, messageAt: Date.now() - 1_000,
    }));
    expect(pending).not.toContain("Past usage-limit notice");
    expect(pending).toContain("Manage usage");

    const unknown = renderToStaticMarkup(createElement(FailedTurnRow, {
      tool: failedTurnTool(CODEX_USAGE_LIMIT_REACHED), engine: codex, messageAt: reset - 10_000,
    }));
    expect(unknown).toContain("Manage usage");

    const auth = renderToStaticMarkup(createElement(FailedTurnRow, {
      tool: failedTurnTool("Not logged in - please sign in", { setup: true, limitResetsAt: reset }),
      engine: codex, messageAt: reset - 10_000,
    }));
    expect(auth).not.toContain("Past usage-limit notice");
    expect(auth).toContain("Not logged in");
  });
  it("opens a signed-out engine's failed turn with one sentence and the sign-in, the CLI's words under Details", () => {
    const claude = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "available", authenticated: false },
      install: { command: { darwin: "x", linux: "x", win32: "x" }, signInCommand: "claude /login", server: { package: "@anthropic-ai/claude-code" } },
      authentication: { method: "paste-code" },
      models: { default: "sonnet", options: [] },
    } as InstanceInfo;
    const markup = renderToStaticMarkup(createElement(FailedTurnRow, { tool: { name: "error: Not logged in · Please run /login", ok: false, setup: true }, engine: claude, onRetry: () => {} }));
    expect(markup).toContain(">Claude isn&#x27;t signed in yet. Sign in below, then send your message again.</span>");
    expect(markup).toContain("Sign in to Claude</button>");
    expect(markup).toMatch(/<summary[^>]*>Details<\/summary><p[^>]*>Not logged in · Please run \/login<\/p>/);
    expect(markup).not.toContain(">Retry<");
    const update = { name: "error: Claude Code 2.1.268 does not support this model", ok: false, setup: true, claudeUpdate: true };
    for (const engine of [claude, { ...claude, readOnly: true }]) {
      const row = renderToStaticMarkup(createElement(FailedTurnRow, { tool: update, engine }));
      expect(row).toContain(">Claude Code 2.1.268 does not support this model</span>");
      expect(row).not.toContain("isn&#x27;t signed in");
      expect(activityPreview(update, engine)).toBe("Claude Code 2.1.268 does not support this model");
    }
  });
  it("opens a failed turn with a technical cause on one plain line, the engine's words under Details", () => {
    const raw = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    const markup = renderToStaticMarkup(createElement(FailedTurnRow, { tool: { name: `error: ${raw}`, ok: false }, engine: undefined, onRetry: () => {} }));
    expect(markup).toContain(">The service is busy right now. Try again in a moment.</span>");
    expect(markup).toMatch(/<summary[^>]*>Details<\/summary><p[^>]*>API Error: 529/);
    expect(markup).toContain(" Retry</button>");
    const plain = renderToStaticMarkup(createElement(FailedTurnRow, { tool: { name: "error: no activity for 10 minutes — the turn was stopped", ok: false }, engine: undefined }));
    expect(plain).toContain(">no activity for 10 minutes — the turn was stopped</span>");
    expect(plain).not.toContain(">Details</summary>");
  });
  it("offers to update Claude Code for a too-old install, or hands over the command", () => {
    const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available", authenticated: true } } as InstanceInfo;
    const markup = renderToStaticMarkup(createElement(ErrorRow, {
      message: "API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required.",
      onRetry: () => {},
      setupInstance: claude,
      claudeUpdateInstance: claude,
    }));
    expect(markup).toContain("Update Claude for me");
    expect(markup).toContain("I&#x27;ll do it myself");
    expect(markup).not.toContain(">Retry<");
  });
  it("updates only a local Claude Code engine from chat", () => {
    const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude" } as InstanceInfo;
    expect(claudeUpdateTarget(claude)).toBe(claude);
    expect(claudeUpdateTarget({ ...claude, readOnly: true })).toBeUndefined();
    expect(claudeUpdateTarget({ ...claude, driverKind: "codex" })).toBeUndefined();
    expect(claudeUpdateTarget(undefined)).toBeUndefined();
  });
  it("offers the matching macOS Settings and relaunch actions only for a named CUA permission failure", () => {
    fixture.platform = "darwin";
    fixture.localMessage = "Screen Recording required";
    window.ogb = { platform: "darwin", permOpenSettings: vi.fn(), relaunch: vi.fn() } as unknown as NonNullable<Window["ogb"]>;
    const screen = renderToStaticMarkup(createElement(ErrorRow, {
      message: "OpenMausBot can't use this computer yet — embedded host failed: Screen Recording required. Relaunch OpenMausBot after granting any missing macOS permission.",
    }));
    expect(screen).toContain("Open Screen Recording Settings");
    expect(screen).toContain("Relaunch OpenMausBot");
    expect(screen).not.toContain("Open Accessibility Settings");
    fixture.localMessage = "Accessibility required";
    const accessibility = renderToStaticMarkup(createElement(ErrorRow, {
      message: "OpenMausBot can't use this computer yet — Accessibility required",
    }));
    expect(accessibility).toContain("Open Accessibility Settings");
    expect(accessibility).not.toContain("Open Screen Recording Settings");
    expect(renderToStaticMarkup(createElement(ErrorRow, {
      message: "OpenMausBot can't use this computer yet — Screen Recording required",
    }))).not.toContain("Open Screen Recording Settings");
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout" }))).not.toContain("Open Screen Recording Settings");
    fixture.localReasonCode = "remote-server";
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "OpenMausBot can't use this computer yet — Screen Recording required" }))).not.toContain("Open Screen Recording Settings");
    fixture.localReasonCode = "cua-driver-unavailable";
    fixture.platform = "other";
    fixture.localMessage = "";
    delete window.ogb;
  });
});
