import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn(), model: null as ComponentProps<typeof ModelPicker> | null,
    approval: null as ComponentProps<typeof ApprovalModeSelector> | null };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: fixture.dispatch,
  }) };
});
// The real useCaptionChrome rides along: it only asks this module for the
// window chrome, and these tests render the desktop-neutral layout.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: (props: ComponentProps<typeof ModelPicker>) => {
  fixture.model = props;
  return createElement("span", { "data-test-model-control": true });
} }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (props: ComponentProps<typeof ApprovalModeSelector>) => {
  fixture.approval = props;
  return createElement("span", { "data-test-approval-control": true });
} }));

const { ChatView, ErrorRow } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const bot: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};

describe("thread control placement", () => {
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
    expect(markup).toMatch(/<div class="chat-text[^"]*">(?:شغّل|שלום|مرحبا)/);
    expect(markup).not.toMatch(/class="[^"]*chat-text[^"\n]*bg-bubble-user/);
  });

  it("wraps the header into a name line and a chip line when the column is narrow", () => {
    // With a settings or inspector panel open beside the chat the header's
    // chip group cannot shrink; the wrap keeps the name readable and every
    // chip in place. The query lives on the container's child row: a
    // container query never matches the container element itself.
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false } }));
    expect(markup).toContain("@container/chathead");
    const row = /data-chathead-row="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(row[1].split(" ")).toContain("@max-[30rem]/chathead:flex-wrap");
    const identity = /data-chathead-identity="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(identity[1].split(" ")).toEqual(expect.arrayContaining(["min-w-0", "@max-[30rem]/chathead:basis-full"]));
    const controls = /data-chathead-controls="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(controls[1].split(" ")).toContain("@max-[30rem]/chathead:ml-auto");
  });

  it("moves the editor onto its own line above the chips when the composer is narrow", () => {
    // A bot's settings open beside the chat leaves the composer a few hundred
    // pixels wide; the editor, the only shrinkable child, used to collapse to
    // a sliver and stack its placeholder one letter per line.
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false } }));
    const box = markup.indexOf("@container/composer");
    expect(box).toBeGreaterThan(-1);
    const row = /data-composer-row="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(row[1].split(" ")).toContain("@max-[30rem]/composer:flex-wrap");
    const editor = /class="mention-editor ([^"]*)"/.exec(markup)!;
    expect(editor[1].split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "@max-[30rem]/composer:order-first", "@max-[30rem]/composer:basis-full"]));
    const actions = /data-composer-actions="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(actions[1].split(" ")).toContain("@max-[30rem]/composer:ml-auto");
    // the chips group still comes before the editor in source order: the
    // wrap only reorders visually below the threshold
    expect(markup.indexOf("data-test-approval-control")).toBeLessThan(markup.indexOf("mention-editor"));
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
});
