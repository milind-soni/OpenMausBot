import { Children, createElement, isValidElement, type ReactNode, type ReactElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";
import { CODEX_USAGE_LIMIT_REACHED, CODEX_USAGE_URL } from "../../shared/codex-usage-limit";
import { failedTurnTool } from "../../shared/failed-turn";
import { PROVIDER_SAFETY_GUIDANCE } from "../../shared/provider-safety";
import { en } from "@/locales";

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
// The real useCaptionChrome rides along: it only asks this module for the window chrome.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: fixture.platform }, localComputer: { available: false, reasonCode: fixture.localReasonCode, message: fixture.localMessage } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => fixture.advanced && fixture.showThreads,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
// The trigger still renders, so the markup assertions in this file see the same header.
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { ariaLabel: string; items: never[]; renderTrigger: (state: { open: boolean }) => unknown }) => {
    fixture.menus.push({ ariaLabel: props.ariaLabel, items: props.items });
    return props.renderTrigger({ open: false });
  },
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => fixture.canWrite, useReactor: () => "user" }));
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

const { ChatView, ErrorRow, FailedTurnRow } = await import("./ChatView");
const { claudeUpdateTarget } = await import("@/lib/failed-turn");
const { NewConversationInstead } = await import("./NewConversationInstead");
const { activityPreview } = await import("@/lib/failed-turn");
afterAll(() => vi.unstubAllGlobals());

const bot: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};

describe("the single-bar conversation header", () => {
  it.each([true, false])("puts profile and current thread in one row without repeated labels (advanced %s)", advanced => {
    fixture.advanced = advanced;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, title: "Research" } }));
    const header = markup.slice(markup.indexOf("data-chathead-row"), markup.indexOf('role="log"'));
    expect(header).toContain('aria-label="Open Pepper&#x27;s profile"');
    expect(header).toContain('aria-label="All threads: Selected"');
    expect(header).not.toContain("data-chathead-role");
    expect(header).not.toContain(">Current thread<");
    expect(header).not.toContain("data-chathead-conversation");
    expect(header).not.toContain('data-tour="model"');
    expect(header).toContain('data-testid="chat-more"');
    expect(header.match(/data-thread-navigation=/g)).toHaveLength(1);
    expect(fixture.model).toMatchObject({ threadId: "selected", menuRequest: 0 });
    expect(fixture.model?.menuAnchor).toBeDefined();
    fixture.advanced = true;
  });

  it("keeps model selection in the paired client's menu and leaves permission changes on the host", () => {
    window.ogb = { remoteClient: { active: true } } as NonNullable<Window["ogb"]>;
    fixture.menus = [];
    try {
      const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
      expect(markup).toContain('data-tour="computer"');
      expect(fixture.menus.find(menu => menu.ariaLabel === "More")?.items.map(item => item.key)).toContain("model");
      expect(fixture.model).toMatchObject({ threadId: "selected", bot: { modelSelection: { model: "thread-model" } } });
    } finally { delete window.ogb; }
  });

  it.each([true, false])("shows the selected thread's status and scoped Stop while working (advanced %s)", advanced => {
    fixture.advanced = advanced;
    const busy = { ...bot, tasks: bot.tasks!.map(task => ({ ...task, busy: true, activity: "working" as const })) };
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: busy }));
    const header = markup.slice(markup.indexOf("data-chathead-controls"), markup.indexOf('role="log"'));
    expect(header).toContain('data-thread-status="working"');
    expect(header).toContain('aria-label="Stop this thread"');
    expect(header).toContain("data-header-thread-stop");
    fixture.advanced = true;
  });

  it("dispatches Stop for exactly the selected thread even while a sibling works", () => {
    const profile = { ...bot, tasks: [{ ...bot.tasks![0], busy: true, activity: "working" as const }, { threadId: "sibling", title: "Sibling", createdAt: 2, busy: true }] };
    let tree: ReactNode;
    function Capture() { tree = ChatView({ bot: profile }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    const find = (node: ReactNode): ReactElement<{ onClick: () => void }> | undefined => {
      for (const child of Children.toArray(node)) {
        if (!isValidElement<{ children?: ReactNode; "data-header-thread-stop"?: boolean; onClick: () => void }>(child)) continue;
        if (child.props["data-header-thread-stop"]) return child;
        const nested = find(child.props.children); if (nested) return nested;
      }
    };
    fixture.dispatch.mockClear();
    find(tree)!.props.onClick();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "interrupt", botId: "bot", threadId: "selected" });
  });

  it("does not show Stop for an idle selected thread while a sibling works", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, tasks: [...bot.tasks!, { threadId: "other", title: "Other", createdAt: 2, busy: true }] } }));
    const header = markup.slice(markup.indexOf("data-chathead-controls"), markup.indexOf('role="log"'));
    expect(header).not.toContain("data-header-thread-stop");
    expect(header).toContain('data-thread-status="idle"');
    expect(header).toContain('aria-label="Working in other threads: 1"');
  });

  it("marks the computer button live while a turn works in the browser, so a closed panel still shows it", () => {
    const working = (computer: Bot["computer"], busy: boolean) => renderToStaticMarkup(createElement(ChatView, {
      bot: { ...bot, computer, busy, tasks: (bot.tasks ?? []).map((task) => ({ ...task, busy })) },
    }));
    const button = (markup: string) => markup.match(/<button[^>]*data-tour="computer"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(button(working("browser", true))).toContain('data-testid="computer-button-live"');
    expect(button(working("browser", true))).toContain('aria-label="Bot&#x27;s screen, In use now"');
    expect(button(working("browser", false))).toContain('aria-label="Bot&#x27;s screen"');
    expect(button(working("browser", false))).not.toContain("computer-button-live");
    expect(button(working("local", true))).not.toContain("computer-button-live");
    const pinned = renderToStaticMarkup(createElement(ChatView, {
      bot: { ...bot, computer: undefined, busy: true, tasks: (bot.tasks ?? []).map((task) => ({ ...task, busy: true, surface: "browser" as const })) },
    }));
    expect(button(pinned)).toContain('data-testid="computer-button-live"');
  });

  it("offers a Watch button only while a running tool uses the bot's screen", () => {
    const working = (tool: string, busy = true, computer: Bot["computer"] | "auto" = "cloud", ok?: boolean) => renderToStaticMarkup(createElement(ChatView, {
      bot: { ...bot, computer: computer === "auto" ? undefined : computer, busy, turnStartedAt: 1, tasks: (bot.tasks ?? []).map((task) => ({ ...task, busy, turnStartedAt: 1 })), messages: [
        { id: "ask", role: "user", kind: "text", at: 1, text: "Check the site" },
        { id: "tool", role: "bot", kind: "activity", at: 2, tool: { name: tool, ok } },
      ] } as Bot,
    }));
    const watch = (markup: string) => markup.match(/<button[^>]*data-testid="watch-screen"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(watch(working("mcp__computer__click"))).toContain(">Watch<");
    expect(watch(working("mcp__browser__browser_snapshot", true, "auto"))).toContain(">Watch<");
    expect(watch(working("mcp__computer__click", false))).toBe("");
    expect(watch(working("Bash"))).toBe("");
    expect(watch(working("screenshot", true, "auto"))).toBe("");
    expect(watch(working("mcp__browser__browser_snapshot", true, "cloud", true))).toBe("");
  });

  it("keeps identity and controls in a single flex row", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const row = markup.match(/data-chathead-row="true" class="([^"]*)"/)![1];
    expect(row).toContain("min-w-0");
    expect(row).not.toContain("grid");
    expect(row).toContain("@max-[36rem]/chathead:flex-wrap");
  });});

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
    expect(markup.slice(frame, header)).toContain("[--glass-tint:var(--color-app)]");
    expect(markup.slice(scroller)).toMatch(/class="glass-scroller-content[^"]*"[^>]*role="log"/);
  });

  it("fades the transcript into the canvas under the header in both modes", () => {
    const bar = (markup: string) => markup.match(/<div data-glass-bar="top"[^>]*>/)?.[0] ?? "";
    expect(bar(renderToStaticMarkup(createElement(ChatView, { bot })))).toContain('data-glass-fade=""');
    fixture.advanced = false;
    try {
      const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
      expect(bar(markup)).toContain('data-glass-fade=""');
      expect(bar(markup)).not.toContain("before:hidden");
      expect(markup).toMatch(/class="glass-scroller [^"]*" style="scroll-padding-bottom:calc\(/);
    } finally {
      fixture.advanced = true;
    }
  });

  it("holds every row's positioned parts inside the transcript, so nothing in it can make the window scroll", () => {
    // An absolutely positioned reply label with no positioned ancestor in the scroller is placed past
    // the window, which then scrolls by script: an app frame's scrollIntoView lifts the whole app off the top.
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const transcript = markup.match(/class="(glass-scroller-content[^"]*)"[^>]*role="log"/)?.[1] ?? "";
    expect(transcript.split(" ")).toContain("relative");
  });
});

describe("thread control placement", () => {
  it.each([true, false])("keeps the thread picker and More available in both modes (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).toContain('aria-label="All threads: Selected"');
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

  it("keeps the editor and its controls on one line, wrapping only in a narrow composer", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).toContain("@container/composer");
    const row = /data-composer-row="[^"]*" class="([^"]*)"/.exec(markup)!.at(1)!.split(" ");
    expect(row).toContain("@max-[30rem]/composer:flex-wrap");
    expect(row).not.toContain("flex-wrap");
    const editor = /class="mention-editor ([^"]*)"/.exec(markup)!.at(1)!.split(" ");
    expect(editor).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "@max-[30rem]/composer:order-first", "@max-[30rem]/composer:basis-full"]));
    expect(editor).not.toContain("basis-full");
    const textarea = /<textarea[^>]*class="([^"]*)"/.exec(markup)!.at(1)!.split(" ");
    expect(textarea).toContain("min-h-6");
    expect(textarea).not.toContain("min-h-14");
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

  it("applies Full access from the composer at once, with or without the desktop bridge", () => {
    for (const bridge of [false, true]) {
      if (bridge) window.ogb = { approvals: { setMode: vi.fn() } } as unknown as NonNullable<Window["ogb"]>;
      fixture.dispatch.mockClear();
      const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
      expect(fixture.approval?.trustedModesAvailable).toBe(bridge);
      fixture.approval!.onSelect("full");
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "updateTask", botId: "bot", threadId: "selected", patch: { approvalMode: "full" } });
      expect(markup).not.toContain('role="alertdialog"');
      delete window.ogb;
    }
    fixture.dispatch.mockClear();
    renderToStaticMarkup(createElement(ChatView, { bot }));
    fixture.approval!.onSelect("custom");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

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
  it.each([
    "شغّل الاختبارات\nThen run typecheck\nوبعدها ارفع الفرع",
    "שלום עולם\nThen run typecheck\nתודה רבה",
    `${"مرحبا\n".repeat(10)}Then run typecheck`,
  ])("applies per-line direction to the actual user text, including collapsed messages", (text) => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: {
      ...bot,
      messages: [{ id: "mixed-script", role: "user", kind: "text", at: 1, text }],
    } }));
    // unicode-bidi does not inherit, so the class must sit on the node holding the prose.
    expect(markup).toMatch(/<div class="chat-text[^"]*"[^>]*>(?:شغّل|שלום|مرحبا)/);
    expect(markup).not.toMatch(/class="[^"]*chat-text[^"\n]*bg-bubble-user/);
  });

  it("keeps a full-width thread picker and wrapping controls on narrow headers", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const row = markup.match(/data-chathead-row="true" class="([^"]*)"/)![1];
    expect(row).toContain("@max-[36rem]/chathead:flex-wrap");
    expect(markup).toContain("@max-[30rem]/chathead:hidden");
  });
  it("leaves the Chief's role and badge in the profile instead of repeating them in the header", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, chiefOfStaff: true, title: "Chief of Staff" } }));
    const identity = markup.slice(markup.indexOf("data-chathead-identity"), markup.indexOf("data-chathead-controls"));
    expect(identity).toContain("Pepper");
    expect(identity).not.toContain("Chief of Staff");
  });
  it("keeps the selected thread's model in the header and permissions inside the composer pill", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup.match(/data-test-model-control/g)).toHaveLength(1);
    expect(markup.indexOf("data-test-model-control")).toBeLessThan(markup.indexOf('role="log"'));
    expect(markup.indexOf('data-tour="composer"')).toBeGreaterThan(-1);
    expect(markup.indexOf("data-test-approval-control")).toBeGreaterThan(markup.indexOf('data-tour="composer"'));
    expect(markup.indexOf("data-test-approval-control")).toBeLessThan(markup.indexOf("<textarea"));
    expect(markup).not.toContain('aria-label="Thread settings"');
    expect(fixture.model).toMatchObject({ threadId: "selected", bot: { busy: false, modelSelection: { model: "thread-model" } } });
    expect(fixture.approval).toMatchObject({ approvalMode: "ask", busy: false, trustedModesAvailable: false });
    fixture.approval!.onSelect("auto");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateTask", botId: "bot", threadId: "selected", patch: { approvalMode: "auto" } });
  });

  it("changes a working thread's level from the composer, saying the bot is working", () => {
    renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: true, tasks: (bot.tasks ?? []).map((task) => ({ ...task, busy: true })) } }));
    expect(fixture.approval).toMatchObject({ approvalMode: "ask", busy: true });
    fixture.approval!.onSelect("full");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateTask", botId: "bot", threadId: "selected", patch: { approvalMode: "full" } });
  });

  it("offers remote clients the model picker but keeps approval changes on the host", () => {
    window.ogb = { remoteClient: { active: true } } as NonNullable<Window["ogb"]>;
    try {
      fixture.model = null;
      const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
      expect(markup).toContain("data-test-model-control");
      expect(fixture.model).toMatchObject({ bot: { id: "bot" }, threadId: "selected" });
      expect(markup).not.toContain("data-test-approval-control");
    } finally {
      delete window.ogb;
    }
  });

  it.each([true, false])("pins a place per conversation from the composer only in Advanced (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const pill = markup.slice(markup.indexOf('data-tour="composer"'), markup.indexOf("<textarea"));
    expect(pill.match(/data-testid="place-chip"/g) ?? []).toHaveLength(advanced ? 1 : 0);
    expect(markup.includes("Where this conversation works")).toBe(advanced);
    fixture.advanced = true;
  });
});

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

const { awayFromMainThread, openBot } = await import("@/state/store");

describe("the way back to the bot's own conversation", () => {
  const visiting: Bot = {
    ...bot, threadId: "side", mainThreadId: "main",
    tasks: [
      { threadId: "main", title: "Our chat", createdAt: 1, busy: false, activity: "idle" },
      { threadId: "side", title: "Routine report", createdAt: 2, busy: false, activity: "idle" },
    ],
  };
  const header = (shown: boolean, of: Bot) => {
    fixture.showThreads = shown;
    try { return renderToStaticMarkup(createElement(ChatView, { bot: of })); } finally { fixture.showThreads = true; }
  };

  it("offers it with threads hidden while a side thread is open, and opens the main thread", () => {
    expect(header(false, visiting)).not.toContain("data-chathead-back");
    expect(header(false, visiting)).toContain('aria-label="All threads: Routine report"');
    expect(awayFromMainThread(visiting, false)).toBe(true);
    fixture.dispatch.mockReset();
    openBot(fixture.dispatch, visiting, false);
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toContainEqual(expect.objectContaining({ threadId: "main" }));
  });

  it("never with threads shown, nor in the main thread itself", () => {
    expect(header(true, visiting)).not.toContain("data-chathead-back");
    expect(header(false, { ...visiting, threadId: "main" })).not.toContain("data-chathead-back");
    expect(header(false, { ...visiting, mainThreadId: "unknown" })).not.toContain("data-chathead-back");
  });
});
