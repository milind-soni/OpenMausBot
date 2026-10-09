// A member's failed turn in a room is the same stored row a 1:1 failure is
// (server/index.ts runtime.error → "error: …" with setup/claudeUpdate; a room
// copy only adds `from`). These pin that the room reads it the same way: one
// sentence and the one next action, never the engine's raw words in a
// truncated tool pill.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { instances: [] as InstanceInfo[], bots: [] as Bot[] };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: fixture.instances, bots: fixture.bots },
    dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { RoomToolChip } = await import("./GroupView");
const { FailedTurnRow } = await import("./ChatView");

const claude = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: false },
  install: { command: { darwin: "npm i -g x", linux: "npm i -g x", win32: "npm i -g x" }, signInCommand: "claude /login", server: { package: "@anthropic-ai/claude-code" } },
  authentication: { method: "paste-code" },
  models: { default: "sonnet", options: [] },
} as InstanceInfo;
fixture.instances = [claude];
fixture.bots = [{ id: "lead", name: "Lead", modelSelection: { instanceId: "claude", model: "sonnet" } } as Bot];

const failed = (name: string, patch: Partial<NonNullable<Message["tool"]>> = {}): Message => ({
  id: "failed", role: "bot", kind: "activity", at: 1,
  from: { botId: "lead", name: "Lead", color: "blue" },
  tool: { name, ok: false, ...patch },
});
const room = (message: Message) => renderToStaticMarkup(createElement(RoomToolChip, { message, roomId: "room" }));

describe("a member's failed turn in a room", () => {
  const signedOut = failed("error: Not logged in · Please run /login", { setup: true });

  it("says the engine is signed out and offers the sign-in, not the CLI's /login text", () => {
    const markup = room(signedOut);
    expect(markup).toContain("Claude isn&#x27;t signed in yet. Sign in below, then send your message again.");
    expect(markup).toContain("Sign in to Claude");
    expect(markup).not.toContain('data-testid="tool-activity"');
    expect(markup).not.toContain("truncate font-mono");
    // the engine's own words stay one click away, never as the headline
    const details = markup.indexOf("<details");
    expect(details).toBeGreaterThan(-1);
    expect(markup.indexOf("Not logged in")).toBeGreaterThan(details);
  });

  it("is the very row a direct chat shows for the same failure", () => {
    expect(room(signedOut)).toBe(renderToStaticMarkup(createElement(FailedTurnRow, { tool: signedOut.tool!, engine: claude })));
  });

  it("shows a plan-limit refusal whole, next action included", () => {
    const limit = "Your Pro plan includes 2 cloud computers at once. Delete one to start another.";
    const markup = room(failed(`error: ${limit}`));
    expect(markup).toContain(`>${limit}</span>`);
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("error:");
  });

  it("keeps the engine's words once it is signed in again (nothing left to set up)", () => {
    fixture.instances = [{ ...claude, snapshot: { state: "available", authenticated: true } }];
    try {
      const markup = room(signedOut);
      expect(markup).toContain(">Not logged in · Please run /login</span>");
      expect(markup).not.toContain("Sign in to Claude");
    } finally {
      fixture.instances = [claude];
    }
  });
});
