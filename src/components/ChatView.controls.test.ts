import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { showThreads: true, advanced: true, menus: [] as { ariaLabel: string; items: { key: string; disabled?: boolean; heading?: string; active?: boolean }[] }[], dispatch: vi.fn(), canWrite: null as boolean | null, showToolCalls: false, platform: "other", localReasonCode: "cua-driver-unavailable", localMessage: "", model: null as ComponentProps<typeof ModelPicker> | null,
    approval: null as ComponentProps<typeof ApprovalModeSelector> | null };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.showToolCalls ? { features: { showToolCalls: true } } : null,
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: fixture.dispatch,
  }) };
});
// The real useCaptionChrome rides along: it only asks this module for the
// window chrome, and these tests render the desktop-neutral layout.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: fixture.platform }, localComputer: { available: false, reasonCode: fixture.localReasonCode, message: fixture.localMessage } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => fixture.showThreads,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
// Record every popover menu's items; the trigger still renders so the markup
// assertions elsewhere in this file see the same header.
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { ariaLabel: string; items: never[]; renderTrigger: (state: { open: boolean }) => unknown }) => {
    fixture.menus.push({ ariaLabel: props.ariaLabel, items: props.items });
    return props.renderTrigger({ open: false });
  },
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => fixture.canWrite }));
vi.mock("./CitationUI", async (importOriginal) => ({
  ...await importOriginal<typeof import("./CitationUI")>(),
  CitationSelectionToolbar: () => createElement("span", { "data-testid": "citation-toolbar" }),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: (props: ComponentProps<typeof ModelPicker>) => {
  fixture.model = props;
  return createElement("span", { "data-test-model-control": true });
} }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (props: ComponentProps<typeof ApprovalModeSelector>) => {
  fixture.approval = props;
  return createElement("span", { "data-test-approval-control": true });
} }));

const { ChatView, ErrorRow, FailedTurnRow, NewConversationInstead, claudeUpdateTarget } = await import("./ChatView");
const { activityPreview } = await import("@/lib/failed-turn");
afterAll(() => vi.unstubAllGlobals());

const bot: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};

describe("Advanced mode in the header menu", () => {
  const inspector = () => {
    fixture.menus = [];
    renderToStaticMarkup(createElement(ChatView, { bot }));
    const more = fixture.menus.find((menu) => menu.ariaLabel === "More")!;
    return more.items.find((item) => item.key === "inspector")!;
  };

  it("keeps the inspector visible but locked, labelled for Advanced mode, in Simple mode", () => {
    fixture.advanced = false;
    const item = inspector();
    expect(item.disabled).toBe(true);
    expect(item.heading).toBe("In Advanced mode");
    fixture.advanced = true;
  });

  it("leaves the inspector exactly as it was in Advanced mode", () => {
    fixture.advanced = true;
    const item = inspector();
    expect(item.disabled).toBeFalsy();
    expect(item.heading).toBeUndefined();
  });
});

describe("header name", () => {
  it("renames only from the bot's settings in Simple mode: no pencil, and the whole pill opens them", () => {
    fixture.advanced = false;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).not.toContain('aria-label="Rename Pepper"');
    // one button holds the avatar and the name together
    const pill = markup.match(/<button[^>]*data-chathead-pill="true"[^>]*>([\s\S]*?)<\/button>/);
    expect(pill?.[0]).toContain('aria-label="Open Pepper&#x27;s profile"');
    expect(pill?.[1]).toContain(">Pepper</span>");
    expect(pill?.[0]).toContain("rounded-full");
    fixture.advanced = true;
  });

  it("keeps the rename pencil in Advanced mode, inside the same pill as the avatar and name", () => {
    fixture.advanced = true;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const start = markup.indexOf('<div data-chathead-pill="true"');
    expect(start).toBeGreaterThan(-1);
    const pill = markup.slice(start, markup.indexOf("data-chathead-controls"));
    expect(pill).toContain('aria-label="Open Pepper&#x27;s profile"');
    expect(pill).toContain("Rename Pepper");
  });

  it("centres the bot in the header's middle column, with the controls in the last", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const row = markup.match(/data-chathead-row="true" class="([^"]*)"/)?.[1] ?? "";
    expect(row).toContain("@min-[30rem]/chathead:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)]");
    expect(markup).toMatch(/data-chathead-identity="true" class="[^"]*@min-\[30rem\]\/chathead:col-start-2[^"]*justify-self-center/);
    expect(markup).toMatch(/data-chathead-controls="true" class="[^"]*@min-\[30rem\]\/chathead:col-start-3/);
  });
});

describe("glass header", () => {
  it("floats the header over the transcript, which starts below it and scrolls on underneath", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const frame = markup.indexOf("data-glass-frame");
    const header = markup.indexOf('data-glass-bar="top"');
    const name = markup.indexOf("data-chathead-row");
    const scroller = markup.indexOf('class="glass-scroller ');
    expect(frame).toBeGreaterThan(-1);
    expect(frame).toBeLessThan(header);
    expect(header).toBeLessThan(name);
    expect(name).toBeLessThan(scroller);
    // The glass is tinted with the chat's own background, not the sidebar's.
    expect(markup.slice(frame, header)).toContain("[--glass-tint:var(--color-app)]");
    // The transcript is padded by the header's measured height.
    expect(markup.slice(scroller)).toMatch(/class="glass-scroller-content[^"]*"[^>]*role="log"/);
  });
});

describe("thread control placement", () => {
  it.each([true, false])("leaves All threads to the sidebar in both modes (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).not.toContain('aria-label="All threads"');
    expect(markup).toContain('data-testid="chat-more"');
    fixture.advanced = true;
  });

  it.each([true, false])("calls from the composer beside dictation, not the header (advanced %s)", (advanced) => {
    fixture.advanced = advanced;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const header = markup.slice(markup.indexOf("data-chathead-controls"), markup.indexOf("data-composer-row"));
    expect(header).not.toContain("data-call-button");
    expect(markup).not.toContain('data-call-button="header"');
    const actions = markup.slice(markup.indexOf("data-composer-actions"));
    expect(actions).toContain('data-call-button="composer"');
    expect(markup.match(/data-call-button=/g)).toHaveLength(1);
    fixture.advanced = true;
  });

  it("gives the editor its own row in a narrow chat", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).toContain("@container/composer");
    const row = /data-composer-row="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(row[1]).toContain("@max-[30rem]/composer:flex-wrap");
    const editor = /class="mention-editor ([^"]*)"/.exec(markup)!;
    expect(editor[1].split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "@max-[30rem]/composer:order-first", "@max-[30rem]/composer:basis-full"]));
  });

  it("keeps the composer inert until the deleted thread's replacement transcript arrives", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, awaitingThreadSnapshot: true } }));
    expect(markup).toMatch(/<textarea[^>]*disabled=""[^>]*aria-busy="true"/);
    expect(markup).not.toContain("Finish group setup");
  });
  it("offers trusted modes in the composer without requiring a Full bot default", () => {
    const fullBot = { ...bot, busy: false, approvalMode: "full" as const };
    expect(renderToStaticMarkup(createElement(ChatView, { bot: fullBot }))).not.toContain("Use bot’s Full access for this thread");
    window.ogb = { approvals: { setMode: vi.fn() } } as unknown as NonNullable<Window["ogb"]>;
    expect(renderToStaticMarkup(createElement(ChatView, { bot: fullBot }))).not.toContain("Use bot’s Full access for this thread");
    renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(fixture.approval?.trustedModesAvailable).toBe(true);
    fixture.approval!.onSelect("custom");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateTask", botId: "bot", threadId: "selected", patch: { approvalMode: "custom" } });
    delete window.ogb;
  });

  it("explains provider safety errors without offering an ineffective Retry", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRow, { message: "Blocked by our safety systems", onRetry: () => {} }));
    expect(markup).toContain("Full access controls tool approvals, not provider safety checks");
    expect(markup).not.toContain("<button");
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout", onRetry: () => {} }))).toContain("<button");
  });
  it("directs ChatGPT plan limits to usage settings rather than repeatedly retrying", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRow, { message: "ChatGPT plan usage limit reached (subscription_sharing_usage_limit_exceeded)", onRetry: () => {} }));
    expect(markup).toContain("Manage usage");
    expect(markup).toContain("https://chatgpt.com/settings/usage");
    expect(markup).not.toContain(">Retry<");
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
    // an update offer is not a sign-in: the row keeps the engine's words,
    // on a company-managed Claude too (chat cannot update it, so no offer
    // shows, but the row is still about the update, as the list says)
    const update = { name: "error: Claude Code 2.1.268 does not support this model", ok: false, setup: true, claudeUpdate: true };
    for (const engine of [claude, { ...claude, readOnly: true }]) {
      const row = renderToStaticMarkup(createElement(FailedTurnRow, { tool: update, engine }));
      expect(row).toContain(">Claude Code 2.1.268 does not support this model</span>");
      expect(row).not.toContain("isn&#x27;t signed in");
      expect(activityPreview(update, engine)).toBe("Claude Code 2.1.268 does not support this model");
    }
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
    // the offer replaces the plain Retry until they pick a path
    expect(markup).not.toContain(">Retry<");
  });
  it("updates only a local Claude Code engine from chat", () => {
    const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude" } as InstanceInfo;
    expect(claudeUpdateTarget(claude)).toBe(claude);
    expect(claudeUpdateTarget({ ...claude, readOnly: true })).toBeUndefined();
    expect(claudeUpdateTarget({ ...claude, driverKind: "codex" })).toBeUndefined();
    expect(claudeUpdateTarget(undefined)).toBeUndefined();
  });
  it("keeps Retry on the last failed turn after its digest, but never on an older turn", () => {
    const messages: Bot["messages"] = [
      { id: "ask", role: "user", kind: "text", at: 1, text: "Try the new model" },
      { id: "error", role: "bot", kind: "activity", at: 2, tool: { name: "error: outdated engine", ok: false } },
      { id: "digest", role: "bot", kind: "digest", at: 3, text: "no tool activity" },
    ];
    const render = () => renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, messages } }));
    expect(render()).toContain("Retry</button>");
    messages.push({ id: "next", role: "user", kind: "text", at: 4, text: "A different request" });
    expect(render()).not.toContain("Retry</button>");
  });
  it("keeps Retry on a failed turn after hanging up, when the call's record is the last row", () => {
    const messages: Bot["messages"] = [
      { id: "ask", role: "user", kind: "text", at: 1, text: "Try the new model", via: "call", callId: "c1" },
      { id: "error", role: "bot", kind: "activity", at: 2, tool: { name: "error: outdated engine", ok: false } },
      {
        id: "record", role: "bot", kind: "call", at: 3, text: "Call with Pepper · 0:42",
        call: { callId: "c1", botId: "bot", client: "ios", startedAt: 0, endedAt: 3, seconds: 42, endReason: "hung-up" },
      },
    ];
    const render = () => renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, messages } }));
    expect(render()).toContain("Retry</button>");
    expect(render()).toContain('data-testid="call-record"');
    messages.push({ id: "next", role: "user", kind: "text", at: 4, text: "A different request" });
    expect(render()).not.toContain("Retry</button>");
  });
  it.each([false, true])("keeps recovery visible and outside tool folds when tool calls are %s", (showToolCalls) => {
    fixture.showToolCalls = showToolCalls;
    const explanation = "Automatic recovery: Qwen could not start. Trying Backup · fixture-model once in this thread.";
    const messages: Bot["messages"] = [
      { id: "read", role: "bot", kind: "activity", at: 1, tool: { name: "Read", ok: true } },
      { id: "edit", role: "bot", kind: "activity", at: 2, tool: { name: "Edit", ok: true } },
      { id: "recovery", role: "bot", kind: "activity", at: 3, tool: { name: `recovery: ${explanation}`, ok: true } },
      { id: "bash", role: "bot", kind: "activity", at: 4, tool: { name: "Bash", ok: true } },
      { id: "write", role: "bot", kind: "activity", at: 5, tool: { name: "Write", ok: true } },
    ];
    try {
      const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, messages } }));
      expect(markup).toContain('data-mid="recovery"><div role="status"');
      expect(markup).toContain(explanation);
      expect(markup).not.toContain(`recovery: ${explanation}`);
      expect(markup.match(/Automatic recovery:/g)).toHaveLength(1);
      if (!showToolCalls) expect(markup).not.toContain('data-testid="tool-activity"');
    } finally {
      fixture.showToolCalls = false;
    }
  });
  // A bot saved on a retired model runs another one; with Tool calls off
  // (the default) the notice saying so was dropped with the tool steps.
  it.each([false, true])("shows a model notice as a status row when tool calls are %s", (showToolCalls) => {
    fixture.showToolCalls = showToolCalls;
    const explanation = "OpenCode no longer offers opencode/x-preview-f-free, so this conversation uses opencode/big-pickle.";
    const messages: Bot["messages"] = [
      { id: "read", role: "bot", kind: "activity", at: 1, tool: { name: "Read", ok: true } },
      { id: "notice", role: "bot", kind: "activity", at: 2, tool: { name: `notice: ${explanation}`, ok: true } },
      { id: "bash", role: "bot", kind: "activity", at: 3, tool: { name: "Bash", ok: true } },
      { id: "reply", role: "bot", kind: "text", at: 4, text: "ok" },
    ];
    try {
      const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, messages } }));
      expect(markup).toContain('data-mid="notice"><div role="status"');
      expect(markup.match(/no longer offers/g)).toHaveLength(1);
      expect(markup).not.toContain(`notice: ${explanation}`);
      if (!showToolCalls) expect(markup).not.toContain('data-testid="tool-activity"');
    } finally {
      fixture.showToolCalls = false;
    }
  });

  it("offers the matching macOS Settings and relaunch actions only for a named CUA permission failure", () => {
    fixture.platform = "darwin";
    fixture.localMessage = "Screen Recording required";
    window.ogb = { platform: "darwin", permOpenSettings: vi.fn(), relaunch: vi.fn() } as unknown as NonNullable<Window["ogb"]>;
    const screen = renderToStaticMarkup(createElement(ErrorRow, {
      message: "CUA Driver is not ready for this computer — embedded host failed: Screen Recording required. Relaunch OpenMausBot after granting any missing macOS permission.",
    }));
    expect(screen).toContain("Open Screen Recording Settings");
    expect(screen).toContain("Relaunch OpenMausBot");
    expect(screen).not.toContain("Open Accessibility Settings");
    fixture.localMessage = "Accessibility required";
    const accessibility = renderToStaticMarkup(createElement(ErrorRow, {
      message: "CUA Driver is not ready for this computer — Accessibility required",
    }));
    expect(accessibility).toContain("Open Accessibility Settings");
    expect(accessibility).not.toContain("Open Screen Recording Settings");
    expect(renderToStaticMarkup(createElement(ErrorRow, {
      message: "CUA Driver is not ready for this computer — Screen Recording required",
    }))).not.toContain("Open Screen Recording Settings");
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout" }))).not.toContain("Open Screen Recording Settings");
    fixture.localReasonCode = "remote-server";
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "CUA Driver is not ready for this computer — Screen Recording required" }))).not.toContain("Open Screen Recording Settings");
    fixture.localReasonCode = "cua-driver-unavailable";
    fixture.platform = "other";
    fixture.localMessage = "";
    delete window.ogb;
  });
  it.each([
    "شغّل الاختبارات\nThen run typecheck\nوبعدها ارفع الفرع",
    "שלום עולם\nThen run typecheck\nתודה רבה",
    `${"مرحبا\n".repeat(10)}Then run typecheck`,
  ])("applies per-line direction to the actual user text, including collapsed messages", (text) => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: {
      ...bot,
      messages: [{ id: "mixed-script", role: "user", kind: "text", at: 1, text }],
    } }));
    // unicode-bidi does not inherit: setting it on the bubble leaves this
    // inner text block LTR. Keep the class directly on the node with prose.
    expect(markup).toMatch(/<div class="chat-text[^"]*"[^>]*>(?:شغّل|שלום|مرحبا)/);
    expect(markup).not.toMatch(/class="[^"]*chat-text[^"\n]*bg-bubble-user/);
  });

  it("wraps the header into a name line and a chip line when the column is narrow", () => {
    // On a phone, or with a panel beside the chat, the header's chip group
    // cannot shrink: the name truncated to nothing and the rename pencil
    // landed under the export button. Below 30rem the header wraps instead.
    // The query lives on the container's child row: a container query never
    // matches the container element itself. (Approach from #1289.)
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false } }));
    expect(markup).toContain("@container/chathead");
    const row = /data-chathead-row="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(row[1].split(" ")).toContain("@max-[30rem]/chathead:flex-wrap");
    const identity = /data-chathead-identity="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(identity[1].split(" ")).toEqual(expect.arrayContaining(["min-w-0", "@max-[30rem]/chathead:basis-full"]));
    const controls = /data-chathead-controls="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(controls[1].split(" ")).toEqual(expect.arrayContaining(["shrink-0", "@max-[30rem]/chathead:ml-auto", "@max-[30rem]/chathead:flex-wrap"]));
  });

  it("keeps the Chief of Staff badge on one line instead of stacking a word per line", () => {
    // #1871: the badge shrank with the name and wrapped "Chief / of / Staff",
    // taller than the header row.
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, chiefOfStaff: true } }));
    const badge = /<span title="Chief of Staff" class="([^"]*)"><svg[^>]*lucide-crown[^]*?<\/svg> <span class="([^"]*)">Chief of Staff<\/span>/.exec(markup)!;
    expect(badge[1].split(" ")).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
    // In a narrow column it folds to the crown, so the name keeps the room;
    // the label stays for screen readers and as the tooltip.
    expect(badge[2].split(" ")).toContain("@max-4xl/chathead:sr-only");
  });

  it("keeps the selected thread's model in the header and permissions inside the composer pill", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup.match(/data-test-model-control/g)).toHaveLength(1);
    expect(markup.indexOf("data-test-model-control")).toBeLessThan(markup.indexOf('role="log"'));
    expect(markup.indexOf("rounded-3xl bg-composer")).toBeGreaterThan(-1);
    expect(markup.indexOf("data-test-approval-control")).toBeGreaterThan(markup.indexOf("rounded-3xl bg-composer"));
    expect(markup.indexOf("data-test-approval-control")).toBeLessThan(markup.indexOf("<textarea"));
    expect(markup).not.toContain('aria-label="Thread settings"');
    expect(fixture.model).toMatchObject({ threadId: "selected", bot: { busy: false, modelSelection: { model: "thread-model" } } });
    expect(fixture.approval).toMatchObject({ approvalMode: "ask", disabled: false, trustedModesAvailable: false });
    fixture.approval!.onSelect("auto");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateTask", botId: "bot", threadId: "selected", patch: { approvalMode: "auto" } });
  });

  it("keeps both controls hidden for remote clients", () => {
    window.ogb = { remoteClient: { active: true } } as NonNullable<Window["ogb"]>;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).not.toContain("data-test-model-control");
    expect(markup).not.toContain("data-test-approval-control");
    delete window.ogb;
  });

  it.each([true, false])("pins a place per conversation from the composer only in Advanced (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const pill = markup.slice(markup.indexOf("rounded-3xl bg-composer"), markup.indexOf("<textarea"));
    expect(pill.match(/data-testid="place-chip"/g) ?? []).toHaveLength(advanced ? 1 : 0);
    // Nowhere else in the chat either: Simple follows the bot's Works on.
    expect(markup.includes("Where this conversation works")).toBe(advanced);
    fixture.advanced = true;
  });
});

// A polite live region on the whole transcript re-reads every change: the
// ticking "Thinking 3s", each activity label, every chip. The log stays a
// landmark people can browse, and one quiet status line speaks when a
// reply is done or an approval is waiting.
describe("screen reader announcements", () => {
  it("keeps the transcript log out of live announcements", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).toMatch(/role="log" aria-live="off" aria-label="Conversation with Pepper"/);
  });

  it("does not make the working label a second live region", async () => {
    const { TurnPresence } = await import("./TurnPresence");
    const markup = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Running a command", since: 1 }));
    expect(markup).toContain("Running a command");
    expect(markup).not.toMatch(/thinking-shimmer[^"]*" aria-live/);
  });

  it("renders one visually hidden status line for finished replies", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup.match(/data-testid="transcript-announcer"/g)).toHaveLength(1);
    expect(markup).toMatch(/<p role="status" aria-live="polite" aria-atomic="true" class="sr-only" data-testid="transcript-announcer">/);
  });
});

// On an OMB Cloud home a guest writes only in conversations it opened: in
// any other, one button starts its own instead of a send that fails.
describe("a guest's composer on a Cloud home", () => {
  it("offers a new conversation in one click, with no dialog", () => {
    const onNew = vi.fn();
    const markup = renderToStaticMarkup(createElement(NewConversationInstead, { onNew }));
    expect(markup).toContain("You can only write in conversations you started on this Cloud.");
    expect(markup).toContain(">New conversation<");
    expect(markup).not.toContain("<textarea");
    const tree = NewConversationInstead({ onNew }) as { props: { children: Array<{ type: string; props: { onClick?: () => void } }> } };
    tree.props.children.find((child) => child.type === "button")!.props.onClick!();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("takes the composer's place only where the device may not write", () => {
    fixture.canWrite = false;
    const refused = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(refused).toContain('data-testid="cloud-guest-composer"');
    expect(refused).not.toContain("<textarea");
    expect(refused).not.toContain('data-testid="citation-toolbar"');
    fixture.canWrite = true;
    const allowed = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(allowed).not.toContain('data-testid="cloud-guest-composer"');
    expect(allowed).toContain("<textarea");
    expect(allowed).toContain('data-testid="citation-toolbar"');
    fixture.canWrite = null;
  });
});
