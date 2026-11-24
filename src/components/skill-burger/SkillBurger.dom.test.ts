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
const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(text) || node.title === text || node.getAttribute("aria-label") === text);

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

it("stays a closed pill while it cooks, finishes or fails, opens only on a tap, and closes from its panel", async () => {
  const fold = () => host.querySelector(".burger-fold");
  const pill = () => host.querySelector<HTMLButtonElement>("[data-burger-pill] button[aria-controls]")!;
  const shell = (id: string, command: string, extra: Partial<NonNullable<RunMessage["tool"]>> = {}): RunMessage => ({ id, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, input: JSON.stringify({ command }), ...extra } });
  // One step in, still working: the pill cooks, closed.
  await render([ask, app("m1", "GOOGLESHEETS_BATCH_GET")], [], true);
  expect(fold()?.getAttribute("data-folded")).toBe("true");
  expect(host.querySelector("[data-burger-pill]")?.textContent).toContain("Cooking… 1");
  // Eight steps across six apps: still closed, the count ticks over, at most four marks.
  const many = [ask, app("m1", "GOOGLESHEETS_BATCH_GET"), app("m2", "GMAIL_SEND_EMAIL"), app("m3", "SLACK_SEND_MESSAGE"), app("m4", "NOTION_CREATE_PAGE"), app("m5", "LINEAR_CREATE_ISSUE"), app("m6", "GITHUB_CREATE_ISSUE"), shell("m7", "git push"), app("m8", "GMAIL_SEND_EMAIL")];
  await render(many, [], true);
  expect(fold()?.getAttribute("data-folded")).toBe("true");
  expect(host.querySelector("[data-burger-pill]")?.textContent).toContain("Cooking… 8");
  expect(host.querySelectorAll("[data-burger-pill] .rounded-full.bg-card").length).toBe(4);
  // Finished, and then with a failed step: never opens by itself; a failure tints the count.
  await render(many);
  expect(fold()?.getAttribute("data-folded")).toBe("true");
  expect(host.querySelector("[data-burger-pill]")?.textContent).toContain("8 steps");
  await render([...many, shell("m9", "pnpm deploy", { ok: false })]);
  expect(fold()?.getAttribute("data-folded")).toBe("true");
  expect(host.querySelector("[data-burger-pill] .text-danger")).not.toBeNull();
  // A tap opens it; another closes it; Close in the panel dismisses it.
  await act(async () => pill().click());
  expect(fold()?.getAttribute("data-folded")).toBe("false");
  expect(pill().getAttribute("aria-expanded")).toBe("true");
  await act(async () => pill().click());
  expect(fold()?.getAttribute("data-folded")).toBe("true");
  expect(fold()?.hasAttribute("inert")).toBe(true);
  await act(async () => pill().click());
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

it("explains a finished delegation run and saves only what the person kept, under the input names they chose", async () => {
  const draft = {
    goal: "QA-test https://mausbot.com with Kiwi and Rio",
    inputs: [{ name: "site", value: "https://mausbot.com", label: "site" }],
    steps: [
      { id: "s1", kind: "delegate", label: "Ask Kiwi and Rio", exact: true, needs: [], who: [{ name: "Kiwi", role: "Accessibility tester" }, { name: "Rio" }],
        asked: [{ who: "Kiwi", text: "QA-test https://mausbot.com for accessibility" }, { who: "Rio", text: "QA-test https://mausbot.com for speed" }],
        back: [{ who: "Kiwi", text: "3 findings", ok: true, round: 1 }, { who: "Rio", text: "2 findings", ok: true, round: 1 }, { who: "Rio", text: "3 findings", ok: true, round: 2 }],
        rounds: 2, reviewRounds: 1, doneWhen: "3 findings, each naming the URL" },
      { id: "s2", kind: "ai", label: "Review what came back and report", exact: false, needs: ["s1"] },
    ],
    outcome: "Verdict: nothing serious.",
  };
  fixture.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/api/skill-burger-draft") return { draft };
    if (path === "/api/skill-burgers" && init?.method === "POST") return { skill: saved };
    return {};
  });
  const delegate: RunMessage = { id: "m1", role: "bot", kind: "activity", tool: { name: "mcp__agents__coordinate_bots", ok: true, itemId: "c1", input: JSON.stringify({ bot_ids: ["Kiwi", "Rio"], message: "QA-test https://mausbot.com" }) } };
  const sent: RunMessage = { id: "r1", role: "bot", kind: "activity", tool: { name: "Sent to Kiwi", ok: true }, threadRef: { botId: "kiwi", threadId: "k" } };
  const replied: RunMessage = { id: "r2", role: "bot", kind: "activity", tool: { name: "Kiwi replied", ok: true, output: "3 findings" }, roomRequest: { id: "q1", phase: "result" }, from: { name: "Kiwi" } };
  const verdict: RunMessage = { id: "v1", role: "bot", kind: "text", text: "Verdict: nothing serious." };
  await render([{ ...ask, text: "QA-test https://mausbot.com with Kiwi and Rio" }, delegate, sent, replied, verdict]);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const rows = [...host.querySelectorAll("[data-burger-layer]")];
  expect(rows.map((row) => row.getAttribute("data-burger-layer"))).toEqual(["delegate", "ai"]);
  expect(host.textContent).not.toContain("Sent to Kiwi");
  expect(rows[0]!.textContent).toContain("Ask Kiwi and Rio");
  expect(rows[0]!.textContent).toContain("Kiwi · Accessibility tester");
  expect(rows[0]!.textContent).toContain("2 rounds");
  expect(host.querySelector(".burger-bun-top")?.textContent).toContain("1 exact, 1 by judgement");
  // Open the delegation: what each was asked, what came back, what done meant.
  await act(async () => rows[0]!.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
  const detail = rows[0]!.querySelector("[data-burger-detail]")!.textContent!;
  expect(detail).toContain("QA-test https://mausbot.com for speed");
  expect(detail).toContain("Came back this time");
  expect(detail).toContain("Done when: 3 findings, each naming the URL");
  // Leave the review out, and rename the input.
  await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Keep “Review what came back and report”"]')!.click());
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("[data-burger-inputs] button")][0]!.click());
  const name = host.querySelector<HTMLInputElement>('input[aria-label="Input name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "website");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Add Skill Burger")!.click());
  const body = JSON.parse(fixture.api.mock.calls.find(([path, init]) => path === "/api/skill-burgers" && init?.method === "POST")![1].body);
  expect(body).toMatchObject({ botId: "scout", threadId: "t1", skip: ["s2"], inputs: { site: { name: "website" } } });
});

it("leaving a step out leaves out the steps that use its output", async () => {
  const draft = {
    goal: "Fetch and write", inputs: [],
    steps: [
      { id: "s1", kind: "shell", label: "Fetch example.com", exact: true, needs: [] },
      { id: "s2_write", kind: "ai", label: "Write top.md", exact: false, needs: ["s1"] },
      { id: "s2", kind: "file", label: "Write top.md", exact: true, needs: ["s2_write"] },
    ],
  };
  fixture.api.mockImplementation(async (path: string) => (path === "/api/skill-burger-draft" ? { draft } : {}));
  // Another run than the one saved above: a saved run's card comes back saved.
  await render([ask, app("m31", "GOOGLESHEETS_BATCH_GET"), app("m32", "GMAIL_SEND_EMAIL")]);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect([...host.querySelectorAll("[data-burger-layer]")].map((row) => row.textContent)).toEqual([expect.stringContaining("Fetch example.com"), expect.stringContaining("Write top.md")]);
  await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Keep “Fetch example.com”"]')!.click());
  expect([...host.querySelectorAll("[data-burger-layer]")].map((row) => row.getAttribute("data-kept"))).toEqual(["false", "false"]);
});
