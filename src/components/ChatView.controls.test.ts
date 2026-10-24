import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";
import { CODEX_USAGE_LIMIT_REACHED, CODEX_USAGE_URL } from "../../shared/codex-usage-limit";
import { failedTurnTool } from "../../shared/failed-turn";

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
vi.mock("./ChiefJobCancel", () => ({ ChiefJobCancel: ({ chief, canWrite }: { chief: boolean; canWrite: boolean }) => createElement("div", { "data-current-job-status": true, "data-chief-job-cancel": chief && canWrite ? true : undefined }, "Checking job status…") }));

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

describe("the header's right side", () => {
  it("hides Stop for read-only viewers while preserving current-job status", () => {
    fixture.canWrite = false;
    try {
      const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: true, waitingForTeammates: true } }));
      expect(markup).not.toContain('title="Stop this turn"');
      expect(markup).toContain("data-current-job-status");
    } finally { fixture.canWrite = null; }
  });

  const header = (of: Bot = bot) => {
    fixture.menus = [];
    fixture.model = null;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: of }));
    return { markup, controls: markup.slice(markup.indexOf("data-chathead-controls"), markup.indexOf("role=\"log\"")) };
  };

  it("shows only what applies in Simple mode: no model, computer or ⋯, which the bot panel holds", () => {
    fixture.advanced = false;
    const { markup, controls } = header();
    expect(markup).not.toContain("data-test-model-control");
    expect(fixture.model).toBeNull();
    expect(markup).not.toContain('data-tour="computer"');
    expect(markup).not.toContain('data-testid="chat-more"');
    expect(fixture.menus.find((menu) => menu.ariaLabel === "More")).toBeUndefined();
    expect(controls).not.toContain("<button");
    expect(markup).toContain("data-chathead-pill");
    fixture.advanced = true;
  });

  it("keeps the computer and ⋯ in a remote client's Simple header, whose settings panel has no room for them", () => {
    fixture.advanced = false;
    window.ogb = { remoteClient: { active: true } } as NonNullable<Window["ogb"]>;
    try {
      const { markup } = header();
      expect(markup).not.toContain("data-test-model-control");
      expect(markup).toContain('data-tour="computer"');
      expect(markup).toContain('data-testid="chat-more"');
      const more = fixture.menus.find((menu) => menu.ariaLabel === "More")!;
      expect(more.items.map((item) => item.key)).toEqual(["find", "new-thread", "copy", "download"]);
    } finally {
      delete window.ogb;
      fixture.advanced = true;
    }
  });

  it("keeps Stop in the Simple header while a turn runs", () => {
    fixture.advanced = false;
    const { controls } = header({ ...bot, busy: true, tasks: (bot.tasks ?? []).map((task) => ({ ...task, busy: true })) });
    expect(controls).toContain('title="Stop this turn"');
    expect(controls.match(/<button/g)).toHaveLength(1);
    fixture.advanced = true;
  });

  it("mounts exact job cancellation only for a writable Chief while keeping ordinary Stop", () => {
    const running = { ...bot, busy: true, waitingForTeammates: true, tasks: (bot.tasks ?? []).map(task => ({ ...task, busy: true })) };
    expect(header(running).markup).not.toContain("data-chief-job-cancel");
    const chief = header({ ...running, chiefOfStaff: true });
    expect(chief.markup).toContain("data-chief-job-cancel");
    expect(chief.controls).toContain('title="Stop this turn"');
    fixture.canWrite = false;
    expect(header({ ...running, chiefOfStaff: true }).markup).not.toContain("data-chief-job-cancel");
    fixture.canWrite = null;
  });

  it("leaves Advanced mode's model, computer and ⋯ exactly as they were, the inspector unlocked", () => {
    fixture.advanced = true;
    const { markup } = header();
    expect(markup).toContain("data-test-model-control");
    expect(markup).toContain('data-tour="computer"');
    expect(markup).toContain('data-testid="chat-more"');
    const more = fixture.menus.find((menu) => menu.ariaLabel === "More")!;
    expect(more.items.map((item) => item.key)).toEqual(["find", "copy", "download", "activity", "inspector"]);
    const inspector = more.items.find((item) => item.key === "inspector")!;
    expect(inspector.disabled).toBeFalsy();
    expect(inspector.heading).toBeUndefined();
  });
});

describe("header conversation title", () => {
  it("reads Bot / Conversation ▾ in Simple mode, in place of the other-activity picker and the way back, and only there", () => {
    const busyElsewhere: Bot = { ...bot, mainThreadId: "other", tasks: [...bot.tasks!, { threadId: "other", title: "Other", createdAt: 0, busy: true, activity: "working" }] };
    fixture.advanced = false;
    const simple = renderToStaticMarkup(createElement(ChatView, { bot: busyElsewhere }));
    const identity = simple.slice(simple.indexOf("data-chathead-identity"), simple.indexOf("data-chathead-controls"));
    expect(identity.indexOf("data-chathead-conversation")).toBeGreaterThan(identity.indexOf("data-chathead-pill"));
    expect(identity).toMatch(/data-chathead-conversation[^>]*><span dir="auto" class="truncate">Selected<\/span>/);
    expect(simple).not.toContain("data-background-activity");
    expect(simple).not.toContain("data-chathead-back");
    window.ogb = { remoteClient: { active: true } } as NonNullable<Window["ogb"]>;
    try {
      const remote = renderToStaticMarkup(createElement(ChatView, { bot: busyElsewhere }));
      expect(remote).not.toContain("data-chathead-conversation");
      expect(remote).toContain("data-background-activity");
    } finally {
      delete window.ogb;
    }
    fixture.advanced = true;
    fixture.showThreads = false;
    const advanced = renderToStaticMarkup(createElement(ChatView, { bot: busyElsewhere }));
    expect(advanced).not.toContain("data-chathead-conversation");
    expect(advanced).toContain("data-background-activity");
    expect(advanced).toContain("data-chathead-back");
    fixture.showThreads = true;
  });
});

describe("header name", () => {
  it("renames only from the bot's settings in Simple mode: no pencil, and the whole pill opens them", () => {
    fixture.advanced = false;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).not.toContain('aria-label="Rename Pepper"');
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

  it("shows the bot's role beside the pill in both modes, taking only the room the name leaves", () => {
    for (const advanced of [true, false]) {
      fixture.advanced = advanced;
      const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, title: " Research " } }));
      const identity = markup.slice(markup.indexOf("data-chathead-identity"), markup.indexOf("data-chathead-controls"));
      const role = identity.match(/<span data-chathead-role="true" class="([^"]*)"><span title="Research" class="([^"]*)">Research<\/span><\/span>/);
      expect(role, `advanced ${advanced}`).toBeTruthy();
      expect(role![1].split(" ")).toEqual(expect.arrayContaining(["min-w-0", "max-w-fit", "grow", "basis-0"]));
      expect(role![2].split(" ")).toEqual(expect.arrayContaining(["truncate", "text-[13px]", "text-ink-secondary"]));
      expect(identity.indexOf("data-chathead-role")).toBeGreaterThan(identity.indexOf(advanced ? "Rename Pepper" : "</button>"));
      expect(renderToStaticMarkup(createElement(ChatView, { bot }))).not.toContain("data-chathead-role");
    }
    fixture.advanced = true;
  });

  it("leaves a Chief's role out of the header when it only repeats the Chief of Staff badge", () => {
    const header = (title: string) => renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, chiefOfStaff: true, title } }));
    expect(header("chief of staff ")).not.toContain("data-chathead-role");
    expect(header("Operations lead")).toContain('<span title="Operations lead"');
    expect(renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, title: "Chief of Staff" } }))).toContain("data-chathead-role");
  });

  it("draws no working dots in the header pill, keeping one width, while a status still tells a screen reader", () => {
    for (const advanced of [true, false]) {
      fixture.advanced = advanced;
      const busyMarkup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: true, tasks: (bot.tasks ?? []).map((task) => ({ ...task, busy: true })) } }));
      const idleMarkup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false } }));
      const pillOf = (markup: string) => {
        const start = markup.indexOf("data-chathead-pill");
        return markup.slice(start, markup.indexOf("data-chathead-status", start));
      };
      expect(pillOf(busyMarkup)).not.toContain("animate-status-pulse");
      expect(pillOf(busyMarkup)).toBe(pillOf(idleMarkup));
      expect(busyMarkup).toMatch(/<span role="status" class="sr-only" data-chathead-status="true">Working…<\/span>/);
      expect(idleMarkup).toMatch(/<span role="status" class="sr-only" data-chathead-status="true"><\/span>/);
      expect(busyMarkup).toContain('title="Stop this turn"');
    }
    fixture.advanced = true;
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
    expect(markup.slice(frame, header)).toContain("[--glass-tint:var(--color-app)]");
    expect(markup.slice(scroller)).toMatch(/class="glass-scroller-content[^"]*"[^>]*role="log"/);
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
  it.each([true, false])("leaves All threads out of the header in both modes (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).not.toContain('aria-label="All threads"');
    expect(markup.includes('data-testid="chat-more"')).toBe(advanced);
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
  it("draws Retry and the next action on the 28px control step", () => {
    const retry = renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout", onRetry: () => {} }));
    const action = renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout", action: { label: "Open", onClick: () => {} } }));
    for (const markup of [retry, action]) {
      expect(markup).toContain('class="ui-button ui-button-md ');
      expect(markup).not.toContain("text-[12.5px]");
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
    // unicode-bidi does not inherit, so the class must sit on the node holding the prose.
    expect(markup).toMatch(/<div class="chat-text[^"]*"[^>]*>(?:شغّل|שלום|مرحبا)/);
    expect(markup).not.toMatch(/class="[^"]*chat-text[^"\n]*bg-bubble-user/);
  });

  it("wraps the header into a name line and a chip line when the column is narrow", () => {
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
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, chiefOfStaff: true } }));
    const badge = /<span title="Chief of Staff" class="([^"]*)"><svg[^>]*lucide-crown[^]*?<\/svg> <span class="([^"]*)">Chief of Staff<\/span>/.exec(markup)!;
    expect(badge[1].split(" ")).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
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
    expect(header(false, visiting)).toContain("data-chathead-back");
    expect(header(false, visiting)).toContain("Back to your chat");
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

it("mounts current-job status in real non-Chief and read-only ChatView", () => {
 const bot: Bot = { id: "worker", threadId: "delegated", name: "Worker", title: "", description: "", color: "green", notifications: true, unread: false, messages: [], modelSelection: { instanceId: "test", model: "test" } };
 fixture.canWrite = true;
 expect(renderToStaticMarkup(createElement(ChatView, { bot }))).toContain("Checking job status");
 fixture.canWrite = false;
 const html = renderToStaticMarkup(createElement(ChatView, { bot }));
 expect(html).toContain("Checking job status");
 expect(html).not.toContain("Cancel job");
 fixture.canWrite = null;
});
