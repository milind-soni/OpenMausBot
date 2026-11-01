import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";
import type { ComputerAskCard } from "../../shared/computer-ask";
import { ApprovalCard } from "./ApprovalCard";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";

const bot = { id: "scout", name: "Scout" } as Bot;

function ask(view: Partial<ComputerAskCard> = {}, answered?: string): Message {
  return {
    id: "ask-card", role: "bot", kind: "options", at: 1,
    card: {
      title: "Scout wants to use your PC's apps and screen", subtitle: "", options: ["Turn on", "Not now"], requestId: "ask-1", requestType: "permission",
      tool: "turn_on_your_computer", ...(answered ? { answered } : {}),
      computerAsk: { need: "screen", reason: "not-running", device: "PC", state: "asking", why: "Fill in the invoice in Excel", ...view },
    },
  } as Message;
}

const panel = (message: Message) => {
  const [pending] = pendingApprovals([message]);
  return renderToStaticMarkup(createElement(StoreProvider, null, createElement(PendingApprovalPanel, {
    pending: pending!, count: 1, index: 0, botName: "Scout",
    actions: createElement(PendingApprovalActions, { pending: pending!, threadId: "t1", bot, onCancelTurn: () => undefined, part: "primary" }),
  })));
};

describe("a bot's ask to turn on what it needs from the person's computer", () => {
  it("says who wants what and why, why it can't now, and offers Turn on and Not now", () => {
    const markup = panel(ask());
    expect(markup).toContain("Scout wants to use your PC&#x27;s apps and screen");
    expect(markup).toContain("Fill in the invoice in Excel");
    expect(markup).toContain("Screen control isn&#x27;t running on your PC.");
    expect(markup).toContain(">Turn on</button>");
    expect(markup).toContain(">Not now</button>");
    expect(markup).not.toContain("Always allow");
    expect(markup).not.toContain("Allow once");
  });

  it("when the app there is the fix, links to it instead of a Turn on that can't work", () => {
    const markup = panel(ask({ reason: "closed" }));
    expect(markup).toContain("MausBot isn&#x27;t open on your PC. Open it there and Scout carries on.");
    expect(markup).toContain('href="https://www.openmausbot.com/download"');
    expect(markup).toContain(">Get MausBot</a>");
    expect(markup).not.toContain(">Turn on</button>");
  });

  it("after a start that failed, says so and offers Try again", () => {
    const markup = panel(ask({ state: "failed", reason: "blocked" }));
    expect(markup).toContain("It didn&#x27;t turn on. Screen control is blocked on your PC: Windows Security may have stopped it.");
    expect(markup).toContain(">Try again</button>");
  });

  it("reads in the transcript as it goes: turning on, then on", () => {
    const row = (message: Message) => renderToStaticMarkup(createElement(ApprovalCard, { bot, message, threadId: "t1" }));
    expect(row(ask({ state: "turning-on" }, "allow"))).toContain("Turning on…");
    expect(row(ask({ state: "on" }, "allow"))).toContain("Turned on. Scout is carrying on.");
    expect(row(ask({ state: "on" }, "allow")), "once on, the old reason is gone").not.toContain("isn&#x27;t running");
    expect(row(ask({ state: "declined" }, "deny"))).toContain("Not now");
    expect(spokenApprovalPrompt(pendingApprovals([ask()])[0]!, "Scout")).toBe("Scout wants to use your PC's apps and screen. Screen control isn't running on your PC.");
  });
});
