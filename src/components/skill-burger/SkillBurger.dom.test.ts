// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { RunMessage } from "../../../shared/skill-burger/layers";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: (...args: unknown[]) => fixture.api(...args) }));

const { SkillBurgerSlot } = await import("./SkillBurgerSlot");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const ask: RunMessage = { id: "u1", role: "user", kind: "text", text: "Email the sales sheet to Priya" };
const app = (id: string, slug: string, live = false): RunMessage => ({
  id, role: "bot", kind: "activity",
  tool: { name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", ...(live ? {} : { ok: true }), input: JSON.stringify({ tools: [{ tool_slug: slug, arguments: { a: 1 } }] }) },
});
const saved = { name: "email-the-sales-sheet-to-priya", summary: "Email the sales sheet to Priya", sha256: "f".repeat(64), savedAt: "2026-11-23T00:00:00.000Z", layers: [], args: [] };

const render = async (messages: RunMessage[], live: string[] = [], busy = false) => {
  await act(async () => root.render(createElement(SkillBurgerSlot, {
    botId: "scout", threadId: "t1", busy, canWrite: true, messages, liveTools: new Set(live), transcriptKey: "scout:t1",
  })));
};
const burger = () => host.querySelector<HTMLElement>("[data-skill-burger]");
const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(text));

beforeEach(() => {
  fixture.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows only for a run of two real steps, one layer each, with the ask on top", async () => {
  await render([ask, app("m1", "GOOGLESHEETS_BATCH_GET")]);
  expect(burger()).toBeNull();
  await render([ask, app("m1", "GOOGLESHEETS_BATCH_GET"), app("m2", "GMAIL_SEND_EMAIL", true)], ["m2"]);
  expect(burger()?.dataset.skillBurger).toBe("live");
  expect([...host.querySelectorAll("[data-burger-layer]")].map((layer) => [layer.textContent?.trim(), layer.getAttribute("data-status")])).toEqual([
    ["Read from Google Sheets", "done"],
    ["Send email", "running"],
  ]);
  expect(host.textContent).toContain("Email the sales sheet to Priya");
  expect(button("Add Skill Burger")?.disabled).toBe(true);
});

it("saves in one click, then Undo takes back the exact copy", async () => {
  fixture.api.mockImplementation(async (_path: string, init?: { method?: string }) => (init?.method === "POST" ? { skill: saved } : { removed: true }));
  await render([ask, app("m1", "GOOGLESHEETS_BATCH_GET"), app("m2", "GMAIL_SEND_EMAIL")]);
  await act(async () => button("Add Skill Burger")!.click());
  expect(fixture.api).toHaveBeenCalledWith("/api/skill-burgers", { method: "POST", body: JSON.stringify({ botId: "scout", threadId: "t1", summary: "Email the sales sheet to Priya" }) });
  expect(burger()?.dataset.skillBurger).toBe("saved");
  expect(host.textContent).toContain("Skill Burger saved");
  await act(async () => button("Undo")!.click());
  expect(fixture.api).toHaveBeenLastCalledWith(`/api/skill-burgers/${saved.name}?sha256=${saved.sha256}`, { method: "DELETE" });
  expect(host.textContent).toContain("Removed from your skills.");
  expect(button("Add Skill Burger")).toBeDefined();
});

it("edits the summary in place: Escape puts it back, Enter keeps it", async () => {
  await render([ask, app("m1", "GOOGLESHEETS_BATCH_GET"), app("m2", "GMAIL_SEND_EMAIL")]);
  const edit = async (value: string, key: string) => {
    await act(async () => button("sales")!.click());
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Edit what this skill does"]')!;
    expect(field.getAttribute("dir")).toBe("auto");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  };
  await edit("Weekly sales email", "Escape");
  expect(button("Email the sales sheet to Priya")).toBeDefined();
  await edit("Weekly sales email", "Enter");
  expect(button("Weekly sales email")).toBeDefined();
});

it("folds and closes from the top bun", async () => {
  await render([ask, app("m1", "GOOGLESHEETS_BATCH_GET"), app("m2", "GMAIL_SEND_EMAIL")]);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Hide steps"]')!.click());
  expect(host.querySelector(".burger-fold")?.getAttribute("data-folded")).toBe("true");
  expect(host.querySelector(".burger-fold")?.hasAttribute("inert")).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(burger()).toBeNull();
});

it("names what a finished run did on its top bun, keeping the ask until then", async () => {
  fixture.api.mockImplementation(async (path: string) => (path === "/api/skill-burger-summary" ? { summary: "Emails the sales sheet to Priya" } : {}));
  await render([ask, app("m1", "GOOGLESHEETS_BATCH_GET"), app("m2", "GMAIL_SEND_EMAIL", true)], ["m2"], true);
  expect(button("Email the sales sheet to Priya")).toBeDefined();
  expect(fixture.api).not.toHaveBeenCalled();
  await render([ask, app("m1", "GOOGLESHEETS_BATCH_GET"), app("m2", "GMAIL_SEND_EMAIL")]);
  await act(async () => { await Promise.resolve(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/skill-burger-summary", { method: "POST", body: JSON.stringify({ botId: "scout", threadId: "t1" }) });
  expect(button("Emails the sales sheet to Priya")).toBeDefined();
});

it("shows a run that handed work on with the teammates' steps from the server, and opens a step's details on a tap", async () => {
  const sent = (id: string, bot: string): RunMessage => ({ id, role: "bot", kind: "activity", tool: { name: `Sent to ${bot}`, ok: true }, threadRef: { botId: bot, threadId: `t-${bot}` } });
  const back = (id: string, bot: string): RunMessage => ({ id, role: "bot", kind: "activity", roomRequest: { id: `r-${bot}`, phase: "result" }, tool: { name: `${bot} replied`, ok: true, output: "ok" }, threadRef: { botId: bot, threadId: `t-${bot}` } });
  const layers = [
    { id: "s1/k1", messageId: "s1", kind: "browser", tool: "browser_navigate", words: "example.com", status: "done", read: false, where: "browser", replay: "exact", args: { url: "https://example.com/pricing" }, note: "Check the Pro plan price", from: { name: "Kiwi" } },
    { id: "s2/r1", messageId: "s2", kind: "app", app: "gmail", tool: "GMAIL_FETCH_EMAILS", words: "fetch emails", status: "done", read: true, where: "app", replay: "exact", args: { query: "launch" }, from: { name: "Rio" } },
    { id: "s2/judgement", messageId: "s2", kind: "ai", tool: "teammate", words: "Sum up what people ask", status: "done", read: false, where: "bot", replay: "ai", brief: "Sum up what people ask.", uses: ["s2/r1"], example: "Mostly pricing.", from: { name: "Rio" } },
  ];
  fixture.api.mockImplementation(async (path: string) => (path === "/api/skill-burger-summary" ? { summary: "Prepares the launch brief", layers } : {}));
  // One hand-off alone still asks: its teammate's work can be several steps.
  await render([ask, sent("s1", "Kiwi"), back("b1", "Kiwi")]);
  await act(async () => { await Promise.resolve(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/skill-burger-summary", expect.anything());
  await render([ask, sent("s1", "Kiwi"), sent("s2", "Rio"), back("b1", "Kiwi"), back("b2", "Rio"), { id: "x", role: "bot", kind: "activity", tool: { name: "Resumed with Kiwi, Rio results, reviewing", ok: true } }]);
  await act(async () => { await Promise.resolve(); });
  const rows = () => [...host.querySelectorAll("[data-burger-layer]")];
  expect(rows().map((row) => row.querySelector("button span[title]")?.textContent)).toEqual(["Open example.com", "Fetch emails", "Sum up what people ask"]);
  expect(host.textContent).not.toMatch(/Sent to|replied|Resumed/);
  const part = rows()[2]!.querySelector("button")!;
  expect(part.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector<HTMLElement>(`#${part.getAttribute("aria-controls")}`)?.hidden).toBe(true);
  await act(async () => part.click());
  const details = host.querySelector<HTMLElement>(`#${part.getAttribute("aria-controls")}`)!;
  expect(details.hidden).toBe(false);
  expect(details.textContent).toContain("Sum up what people ask.");
  expect(details.textContent).toContain("Fetch emails");
  expect(details.textContent).toContain("Mostly pricing.");
  expect(details.textContent).toContain("learned from Rio");
  // Simple mode keeps a step's raw call out of its details.
  expect(details.textContent).not.toContain("launch");
});
