// @vitest-environment happy-dom
// An Edu proposal waits below the chat with its own Reject and Approve, while the person keeps writing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
const ENGINE = "claude-edu";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: (...args: unknown[]) => fixture.api(...args), useStore: () => ({
    state: { ...original.initialState, bots: [], instances: [{ instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: {} }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: () => null }));

const { Composer } = await import("./Composer");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const edu: Message = { id: "edu", role: "bot", kind: "options", at: 1, card: {
  title: "Save to Atlas's Edu brain?", subtitle: "Use ISO dates", options: ["Approve", "Reject"], requestId: "edu-1", tool: "edu_propose_canonical",
  eduProposal: { id: "K-iso", title: "Use ISO dates", kind: "standard", band: "verified", why: "", brain: "/b", global: false, location: "/b" },
} };
const bash: Message = { id: "bash", role: "bot", kind: "options", at: 2, card: { title: "Run?", subtitle: "ls", options: ["Allow", "Deny"], requestId: "p1", tool: "Bash" } };
const bot = (messages: Message[]): Bot => ({
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "", color: "purple", notifications: false, unread: false, busy: false,
  messages, approvalMode: "ask", modelSelection: { instanceId: ENGINE, model: "fake" },
});

let root: Root;
let container: HTMLDivElement;
const render = async (messages: Message[]) => { await act(async () => root.render(createElement(Composer, { bot: bot(messages) }))); };
const field = () => container.querySelector("textarea")!;

beforeEach(() => {
  fixture.api.mockImplementation(async (path: string) => (path === "/api/edu/rights" ? { mayApprove: false, mayReject: true } : {}));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the composer open under a pending Edu proposal, which shows its own answers", async () => {
  await render([edu]);
  expect(field().disabled).toBe(false);
  expect(field().placeholder).not.toBe("Answer the approval above to continue");
  const panel = container.querySelector("[data-ask-card=approval]")!;
  expect(panel.textContent).toContain("Use ISO dates");
  const buttons = [...panel.querySelectorAll("button")].filter((button) => /^(Reject|Approve)$/.test(button.textContent ?? ""));
  expect(buttons.map((button) => button.textContent)).toEqual(["Reject", "Approve"]);
  expect(document.activeElement).not.toBe(buttons[0]);
});

it("offers Approve exactly as Memory settings does, with its note", async () => {
  await render([edu]);
  const panel = container.querySelector("[data-ask-card=approval]")!;
  const button = (name: string) => [...panel.querySelectorAll("button")].find((one) => one.textContent === name)!;
  expect(fixture.api).toHaveBeenCalledWith("/api/edu/rights");
  expect(button("Approve").disabled).toBe(true);
  expect(button("Reject").disabled).toBe(false);
  expect(panel.querySelector("[data-edu-rights-note]")?.textContent).toBe("Approve these in the desktop app or from a paired device. You can reject them here.");
});

it("puts a turn's own approval first and holds the composer for it", async () => {
  await render([edu, bash]);
  expect(field().disabled).toBe(true);
  expect(container.querySelector("[data-ask-card=approval]")!.textContent).not.toContain("Use ISO dates");
});
