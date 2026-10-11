import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ admin: true as boolean | null, dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

import { pendingApprovals, PendingApprovalActions, PendingApprovalPanel } from "./PendingApproval";

const commandAllowlist = { command: "git status --short", cwd: "/work/project", providerInstanceId: "claude" };
const bot = { id: "bot-1", name: "Scout" } as Bot;
function message(extra: Partial<NonNullable<Message["card"]>> = {}): Message {
  return {
    id: "approval-1", at: 1, role: "bot", kind: "options",
    card: { title: "Approval needed", subtitle: commandAllowlist.command, options: ["Allow", "Deny"],
      tool: "Bash", requestId: "request-1", allowSession: true, commandAllowlist, ...extra },
  };
}
type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; "aria-label"?: string }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function view(extra: Partial<NonNullable<Message["card"]>> = {}) {
  const pending = pendingApprovals([message(extra)])[0]!;
  const tree = PendingApprovalActions({ pending, bot, threadId: "thread-1", onCancelTurn: vi.fn() });
  return { html: renderToStaticMarkup(tree), buttons: nodes(tree).filter((node) => node.type === "button") };
}

beforeEach(() => { fixture.admin = true; fixture.dispatch.mockReset(); });

describe("remembering exact command approvals", () => {
  it("shows the complete command being remembered even when the provider summary was truncated", () => {
    const fullCommand = `git diff ${"path/to/another-file ".repeat(30)}-- final-file.txt`;
    const summary = fullCommand.slice(0, 200) + "…";
    const pending = pendingApprovals([message({ subtitle: summary, commandAllowlist: { ...commandAllowlist, command: fullCommand } })])[0]!;
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }));
    expect(html).toContain(fullCommand);
    expect(html).toContain("-- final-file.txt");
    expect(html).not.toContain(summary);
  });

  it("keeps the provider summary when there is no exact command to remember", () => {
    const summary = "Review the proposed file changes.";
    const pending = pendingApprovals([message({ subtitle: summary, commandAllowlist: undefined })])[0]!;
    expect(renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }))).toContain(summary);
  });

  it("forwards eligibility supplied by the server without deriving a grant from the tool label", () => {
    expect(pendingApprovals([message()])[0]?.commandAllowlist).toEqual(commandAllowlist);
    expect(pendingApprovals([message({ commandAllowlist: undefined })])[0]?.commandAllowlist).toBeUndefined();
    expect(view({ commandAllowlist: undefined }).html).not.toContain("Always allow this command");
  });

  it("answers and remembers in one action without a separate preference update", () => {
    const result = view();
    expect(result.html).toContain("Always allow this command");
    expect(result.html).toContain("/work/project");
    expect(result.html).not.toContain("Always allow this session");
    result.buttons.find((button) => button.props["aria-label"] === "Always allow this command")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "decideRequest", threadId: "thread-1", requestId: "request-1", behavior: "allow", rememberCommand: true,
      alwaysAllow: undefined, always: undefined,
    }));
  });

  it("keeps Allow once and Deny from saving a grant", () => {
    for (const [label, behavior] of [["Allow once", "allow"], ["Deny", "deny"]]) {
      fixture.dispatch.mockClear();
      view().buttons.find((button) => button.props.children === label)!.props.onClick!();
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        behavior, rememberCommand: undefined, alwaysAllow: undefined, always: undefined,
      }));
    }
  });

  it.each([false, null])("keeps bot-wide grants unavailable without owner/admin authority (%s)", (admin) => {
    fixture.admin = admin;
    const result = view();
    expect(result.html).not.toContain("Always allow this command");
    expect(result.html).toContain("Always allow this session");
    expect(result.html).toContain("Allow once");
  });

  it("preserves session approval for requests without an exact command", () => {
    view({ commandAllowlist: undefined }).buttons.find((button) => button.props["aria-label"] === "Always allow this session")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      behavior: "allow", always: true, rememberCommand: undefined,
    }));
  });

  it("keeps peer grants separate from provider command rules", () => {
    const result = view({ allowKey: "peer:teammate" });
    expect(result.html).not.toContain("Always allow this command");
    result.buttons.find((button) => button.props.children === "Always allow")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      alwaysAllow: { botId: bot.id, key: "peer:teammate" }, always: undefined, rememberCommand: undefined,
    }));
  });

  it("never offers remembered commands on a durable confirmation", () => {
    const result = view({ routineRequest: { version: 1, requestId: "request-1", botId: bot.id, threadId: "thread-1", createdAt: 1,
      operation: { action: "run_now", routineId: "routine-1", expectedUpdatedAt: 1 } } });
    expect(result.html).not.toContain("Always allow");
    expect(result.html).toContain("Confirm");
  });

  it("puts the decision on the same row and Cancel turn behind the chevron", () => {
    const pending = pendingApprovals([message()])[0]!;
    const slot = (part: "primary" | "more") =>
      PendingApprovalActions({ pending, bot, threadId: "thread-1", onCancelTurn: vi.fn(), part });
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, {
      pending, count: 1, index: 0, botName: "Scout", actions: slot("primary"), more: slot("more"),
    }));
    const details = html.indexOf('id="approval-details-');
    const row = html.slice(0, details);
    expect(row).toContain(">Deny</button>");
    expect(row).toContain(">Allow once</button>");
    // one short label, the scope is in its name and tooltip
    expect(row).toContain('aria-label="Always allow this command"');
    expect(row).toContain(">Always allow</button>");
    expect(row).not.toContain("Cancel turn");
    expect(html.slice(details)).toContain("Cancel turn");
  });

  it("never offers always allow on code or a real send", () => {
    for (const tool of ["COMPOSIO_PROXY_EXECUTE", "SLACK_SEND_MESSAGE"]) {
      const result = view({ tool, commandAllowlist: undefined, allowSession: undefined, allowKey: undefined,
        heldCode: "approval.held.outbound", outboundRequest: { tool, app: "Slack", calls: [{ app: "Slack", label: "Send" }] } });
      expect(result.html).toContain("Allow once");
      expect(result.html).not.toContain("Always allow");
    }
  });

  it("keeps the answers flat, with a ring only for keyboard focus", () => {
    const tree = PendingApprovalActions({ pending: pendingApprovals([message()])[0]!, bot, threadId: "thread-1", onCancelTurn: vi.fn(), part: "primary" });
    const classes = nodes(tree).filter((node) => node.type === "button").map((node) => String((node.props as { className?: string }).className));
    expect(classes).toHaveLength(3);
    for (const name of classes) {
      expect(name).not.toMatch(/(^|\s)(border|shadow|ring-\d)/);
      expect(name).toContain("focus-visible:ring-2");
      expect(name).toContain("h-7");
      expect(name).toContain("text-[13px] font-medium");
      // equal visual mass: every answer has a fill, Deny keeps red text
      expect(name).toMatch(/(^|\s)bg-/);
    }
    expect(classes[0]).toContain("text-danger");
  });

  it("lines the row up on the text baseline with the command in a 28px mono pill", () => {
    const pending = pendingApprovals([message()])[0]!;
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0, botName: "Scout" }));
    const row = html.slice(0, html.indexOf('id="approval-details-'));
    expect(row).toContain("flex flex-wrap items-baseline gap-x-2");
    expect(row).toMatch(/<code class="[^"]*font-mono text-\[12\.5px\] leading-5[^"]*pb-\[3px\] pt-\[5px\][^"]*"[^>]*><span class="truncate">git status --short<\/span><\/code>/);
    // icons sit on the row's center, not on a text baseline
    expect(row).toMatch(/<svg[^>]*class="[^"]*self-center[^"]*"/);
  });
});
