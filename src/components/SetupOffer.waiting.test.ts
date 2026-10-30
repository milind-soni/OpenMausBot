// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), bots: [] as unknown[], instances: [] as unknown[] }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { bots: fixture.bots, instances: fixture.instances }, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/cloud-guest", () => ({ useReactor: () => "user", currentReactor: () => "user" }));
vi.mock("./AskCard", async (original) => ({ ...await original<typeof import("./AskCard")>(), returnFocusToComposer: vi.fn() }));
import { SetupOffer } from "./SetupOffer";

const FIXED = ["Research and digging into topics", "Keeping an eye on things for me", "Email, calendar and messages",
  "Bookings, shopping and errands", "Data, spreadsheets and reports"];
const PERSONAL = ["Sort my receipts", "Check my unpaid invoices", "Draft a payment reminder", "Find a missing expense", "Remind me of tax deadlines"];
const greeting = (extra: Partial<Message> = {}): Message => ({ id: "g1", role: "bot", kind: "text", at: Date.now(),
  text: "Hi, I'm Ava. What would you like me to do?", setupOffer: true, setupChoices: FIXED, ...extra }) as Message;

let root: Root | null = null;
let container: HTMLElement;
function show(message: Message, transcript: Message[] = [message]) {
  act(() => root!.render(createElement(SetupOffer, { botId: "b1", threadId: "t1", message, transcript })));
}
const card = () => container.querySelector<HTMLElement>("[data-setup-card]");
const labels = () => [...container.querySelectorAll<HTMLButtonElement>("[data-ask-choice]")].map((button) => button.querySelector("span")!.textContent);
const press = (key: string) => act(() => void card()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

beforeEach(() => {
  vi.useFakeTimers();
  fixture.api.mockReset().mockResolvedValue({ ok: true });
  fixture.bots = [{ id: "b1", threadId: "t1", name: "Ava", title: "", description: "", soul: "",
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, tasks: [{ threadId: "t1", title: "New thread", createdAt: 1 }] } as unknown as Bot];
  fixture.instances = [{ instanceId: "claude", capabilities: { agentsMcp: true } }];
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe("the setup card while its answers are written", () => {
  it("keeps a quiet frame with the title and the close button, takes no letter, and closes", () => {
    show(greeting({ setupChoicesPending: true }));
    expect(card()!.textContent).toContain("What should I help you with first?");
    expect(card()!.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll("[data-setup-waiting] > div")).toHaveLength(6);
    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(card()!.textContent).not.toContain("Something else");
    press("a");
    press("f");
    expect(fixture.api).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/setup-request", { method: "DELETE", body: JSON.stringify({ threadId: "t1" }) });
    expect(card()).toBeNull();
  });

  it("fills once with the written answers, and a letter picks the answer on screen", async () => {
    show(greeting({ setupChoicesPending: true }));
    show(greeting({ setupChoices: PERSONAL }));
    expect(container.querySelector("[data-setup-waiting]")).toBeNull();
    expect(labels()).toEqual([...PERSONAL, "Something else"]);
    expect(card()!.getAttribute("aria-busy")).toBeNull();
    press("b");
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/setup-request", { method: "POST", body: JSON.stringify({ threadId: "t1", text: PERSONAL[1] }) });
  });

  it("shows the fixed answers when the wait runs past 8 s, and at once on a greeting that has waited 20 s", () => {
    show(greeting({ setupChoicesPending: true }));
    act(() => void vi.advanceTimersByTime(7_999));
    expect(container.querySelector("[data-setup-waiting]")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(container.querySelector("[data-setup-waiting]")).toBeNull();
    expect(labels()).toEqual([...FIXED, "Something else"]);
    act(() => root!.unmount());
    root = createRoot(container);
    show(greeting({ setupChoicesPending: true, at: Date.now() - 20_000 }));
    expect(container.querySelector("[data-setup-waiting]")).toBeNull();
    expect(labels()).toEqual([...FIXED, "Something else"]);
  });

  it("shows a settled card as a greyed list, never a waiting one", () => {
    const message = greeting({ setupChoicesPending: true });
    show(message, [message, { id: "u1", role: "user", kind: "text", at: Date.now(), text: "help me plan a trip" } as Message]);
    expect(container.querySelector("[data-setup-waiting]")).toBeNull();
    expect(labels()).toEqual([...FIXED, "Something else"]);
    expect([...container.querySelectorAll<HTMLButtonElement>("[data-ask-choice]")].every((button) => button.disabled)).toBe(true);
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull();
  });

  it("keeps the first list it showed when the answers change afterwards, so a letter never picks a job that was not on screen", () => {
    show(greeting({ setupChoicesPending: true }));
    act(() => void vi.advanceTimersByTime(8_000));
    expect(labels()).toEqual([...FIXED, "Something else"]);
    show(greeting({ setupChoices: PERSONAL }));
    expect(labels()).toEqual([...FIXED, "Something else"]);
    press("c");
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/setup-request", { method: "POST", body: JSON.stringify({ threadId: "t1", text: FIXED[2] }) });
  });
});

describe("the setup card while a rename rewrites its answers", () => {
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("[data-ask-choice]")];
  const rewriting = () => container.querySelector("[data-setup-updating]") !== null;
  const picked = (text: string) => ["/api/bots/b1/setup-request", { method: "POST", body: JSON.stringify({ threadId: "t1", text }) }];

  it("keeps the answers on screen, quiet, takes no letter or click, then swaps the new ones in at once", () => {
    show(greeting());
    show(greeting({ setupChoicesUpdating: Date.now() }));
    expect(rewriting()).toBe(true);
    expect(card()!.getAttribute("aria-busy")).toBe("true");
    expect(labels()).toEqual([...FIXED, "Something else"]);
    expect(buttons().every((button) => button.disabled)).toBe(true);
    press("a");
    press("f");
    act(() => buttons()[1]!.click());
    expect(fixture.api).not.toHaveBeenCalled();
    show(greeting({ setupChoices: PERSONAL }));
    expect(rewriting()).toBe(false);
    expect(card()!.getAttribute("aria-busy")).toBeNull();
    expect(labels()).toEqual([...PERSONAL, "Something else"]);
    press("b");
    expect(fixture.api).toHaveBeenCalledWith(...picked(PERSONAL[1]!));
  });

  it("keeps its answers and takes picks again when the rewrite ends without new ones, also when first drawn mid-rewrite", () => {
    show(greeting({ setupChoices: PERSONAL, setupChoicesUpdating: Date.now() }));
    expect(rewriting()).toBe(true);
    expect(labels()).toEqual([...PERSONAL, "Something else"]);
    show(greeting({ setupChoices: PERSONAL }));
    expect(rewriting()).toBe(false);
    expect(buttons().some((button) => button.disabled)).toBe(false);
    press("c");
    expect(fixture.api).toHaveBeenCalledWith(...picked(PERSONAL[2]!));
  });

  it("takes picks again 8 s after it first saw a rewrite, never swaps answers in after that, and ignores one older than 20 s", () => {
    const stamp = Date.now();
    show(greeting());
    show(greeting({ setupChoicesUpdating: stamp }));
    act(() => void vi.advanceTimersByTime(7_999));
    expect(rewriting()).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(rewriting()).toBe(false);
    show(greeting({ setupChoices: PERSONAL }));
    expect(labels()).toEqual([...FIXED, "Something else"]);
    show(greeting({ setupChoicesUpdating: Date.now() }));
    expect(rewriting(), "a later rename waits again").toBe(true);
    act(() => root!.unmount());
    root = createRoot(container);
    show(greeting({ setupChoicesUpdating: Date.now() - 20_000 }));
    expect(rewriting()).toBe(false);
    press("a");
    expect(fixture.api).toHaveBeenCalledWith(...picked(FIXED[0]!));
  });

  it("never shows a rewrite on a settled card", () => {
    const message = greeting({ setupChoicesUpdating: Date.now() });
    show(message, [message, { id: "u1", role: "user", kind: "text", at: Date.now(), text: "help me hire" } as Message]);
    expect(rewriting()).toBe(false);
    expect(card()!.getAttribute("aria-busy")).toBeNull();
    expect(buttons().every((button) => button.disabled)).toBe(true);
  });
});
