// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { onCase, type Workflow } from "../../../shared/skill-burger/format";
import { RUN_STEP_MARK, type RunMessage } from "../../../shared/skill-burger/layers";
import { latestRun, runView } from "../../../shared/skill-burger/run-view";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: (...args: unknown[]) => fixture.api(...args) }));

const { SkillBurgerSlot } = await import("./SkillBurgerSlot");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const workflow: Workflow = {
  version: 1, summary: "Files new support email", args: {},
  steps: [
    { id: "s1", kind: "app", app: "gmail", tool: "GMAIL_FETCH_EMAILS", label: "Fetch emails", args: {} },
    { id: "d1", kind: "decide", label: "What kind of email", cases: ["support", "sales", "spam"], prompt: "Which?" },
    { id: "c1", kind: "app", app: "linear", tool: "LINEAR_CREATE_ISSUE", label: "Create issue", args: {}, when: onCase("d1", "support") },
    { id: "c2", kind: "app", app: "hubspot", tool: "HUBSPOT_CREATE_DEAL", label: "Create deal", args: {}, when: onCase("d1", "sales") },
    { id: "s2", kind: "app", app: "slack", tool: "SLACK_SEND_MESSAGE", label: "Tell the team", args: {}, when: { $step: "s1", path: "messages.0", op: "exists" } },
  ],
};

const ask: RunMessage = { id: "u1", role: "user", kind: "text", text: "/files-new-support-email" };
let n = 0;
const step = (id: string, state?: string, extra: Record<string, unknown> = {}): RunMessage => ({
  id: `m${++n}`, role: "bot", kind: "activity",
  tool: { name: id, input: JSON.stringify({ [RUN_STEP_MARK]: "run-1", name: "files-new-support-email", step: id }), ...(state ? { ok: state !== "failed", output: JSON.stringify({ state, ...extra }) } : {}) },
});

const render = async (messages: RunMessage[], busy = false) => {
  await act(async () => root.render(createElement(SkillBurgerSlot, { botId: "scout", threadId: "t1", busy, canWrite: true, messages, liveTools: new Set<string>(), transcriptKey: "scout:t1" })));
  await act(async () => { await Promise.resolve(); });
};
const card = () => host.querySelector<HTMLElement>("[data-skill-burger]");
const rows = () => [...host.querySelectorAll("[data-burger-layer]")].map((row) => `${row.getAttribute("data-status")} ${row.textContent?.replace(/\s+/g, " ").trim()}`);
const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(text) || node.title.includes(text));

beforeEach(() => {
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => (path.includes("?runner=") ? { workflow } : {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("reads the newest run's steps from its rows, and lays the cases under their decide step", () => {
  const seen = latestRun([ask, step("s1", "done"), step("d1", "done", { case: "support" }), step("c1")]);
  const view = runView(workflow, seen);
  expect(view.rows.map((row) => [row.id, row.depth, row.state, row.caseHeading ?? ""])).toEqual([
    ["s1", 0, "done", ""], ["d1", 0, "done", ""], ["c1", 1, "running", "support"], ["c2", 1, "waiting", "sales"], ["s2", 0, "waiting", ""],
  ]);
  expect(view.rows[1]).toMatchObject({ cases: ["support", "sales", "spam"], chosen: "support" });
  expect(latestRun([step("s1", "done"), ask])).toBeNull();
});

it("cooks the running step, greys the case not taken and a skipped step, and ends quietly", async () => {
  await render([ask, step("s1", "done"), step("d1", "done", { case: "support" }), step("c1")], true);
  expect(fixture.api).toHaveBeenCalledWith("/api/skill-burgers/files-new-support-email?runner=scout");
  expect(card()?.dataset.skillBurger).toBe("running");
  expect(host.querySelector('[data-status="running"] .thinking-sheen')).not.toBeNull();
  expect(host.querySelector('[data-case="support"]')?.getAttribute("data-chosen")).toBe("true");
  await render([ask, step("s1", "done"), step("d1", "done", { case: "support" }), step("c1", "done"), step("c2", "not_taken"), step("s2", "skipped")]);
  expect(card()?.dataset.skillBurger).toBe("ran");
  expect(rows()).toEqual([
    "done Fetch emails", "done Decide: What kind of emailsupportsalesspam", "done If supportCreate issue", "not_taken If salesCreate dealnot this time", "skipped Tell the teamskipped",
  ]);
  expect(button("Add the")).toBeUndefined();
});

it("keeps the run a closed pill while it runs, after it ends and when it fails, until someone taps it", async () => {
  const folded = () => host.querySelector(".burger-fold")?.getAttribute("data-folded");
  await render([ask, step("s1", "done"), step("d1")], true);
  expect(folded()).toBe("true");
  expect(host.querySelector("[data-burger-pill]")?.textContent).toContain("Running… 1");
  await render([ask, step("s1", "done"), step("d1", "done", { case: "support" }), step("c1", "failed", { error: "nope" })]);
  expect(card()?.dataset.skillBurger).toBe("failed");
  expect(folded()).toBe("true");
  expect(host.querySelector("[data-burger-pill] .text-danger")?.textContent).toContain("Stopped");
  await act(async () => host.querySelector<HTMLButtonElement>("[data-burger-pill] button[aria-controls]")!.click());
  expect(folded()).toBe("false");
});

it("offers to keep what the bot did for a case nobody saved, once it's done, with an Undo", async () => {
  const handed: RunMessage = { id: "call-1", role: "bot", kind: "activity", tool: { name: "mcp__agents__run_workflow", ok: true, input: "{}", output: 'resume "run-1"' } };
  const messages = [ask, step("s1", "done"), step("d1", "done", { case: "spam" }), handed];
  await render(messages, true);
  expect(button("Add the")).toBeUndefined();
  await render(messages);
  fixture.api.mockImplementation(async (path: string) => {
    if (path.includes("?runner=")) return { workflow };
    if (path.endsWith("/paths")) return { skill: {}, undo: "u-1" };
    return {};
  });
  await act(async () => button("Add the “spam” path")!.click());
  expect(fixture.api).toHaveBeenCalledWith("/api/skill-burgers/files-new-support-email/paths", {
    method: "POST", body: JSON.stringify({ runBotId: "scout", threadId: "t1", run: "run-1", decide: "d1", case: "spam" }),
  });
  expect(host.textContent).toContain("“spam” path added");
  await act(async () => button("Undo")!.click());
  expect(fixture.api).toHaveBeenCalledWith("/api/skill-burgers/files-new-support-email", { method: "PATCH", body: JSON.stringify({ undo: "u-1" }) });
  expect(host.textContent).toContain("Path removed");
});

it("shows a burger the turn changed, with that change's Undo", async () => {
  const edit: RunMessage = { id: "e1", role: "bot", kind: "activity", tool: { name: "mcp__agents__workflow_edit", ok: true, input: JSON.stringify({ name: "files-new-support-email", action: "add_case" }), output: JSON.stringify([{ type: "text", text: 'Changed it. undo "0f0e0d0c-0b0a-4908-8706-050403020100".' }]) } };
  await render([{ id: "u2", role: "user", kind: "text", text: "if it's sales, make a deal" }, edit]);
  expect(card()?.dataset.skillBurger).toBe("edited");
  await act(async () => button("Undo")!.click());
  expect(fixture.api).toHaveBeenCalledWith("/api/skill-burgers/files-new-support-email", { method: "PATCH", body: JSON.stringify({ undo: "0f0e0d0c-0b0a-4908-8706-050403020100" }) });
  expect(host.textContent).toContain("Change undone");
});

it("asks for a burger's inputs in one form, filled with the saved values, and runs with what the person gave", async () => {
  const { RunWithInputs } = await import("./RunInputs");
  const ran: Array<Record<string, string>> = [];
  fixture.api.mockImplementation(async () => ({ workflow: { version: 1, summary: "QA", args: { site: { default: "https://mausbot.com" } }, steps: [] } }));
  const skill = { name: "qa", summary: "QA a site", sha256: "x", savedAt: "", layers: [], args: ["site"], botId: "lead" };
  await act(async () => root.render(createElement(RunWithInputs, { skill, onRun: (inputs: Record<string, string>) => ran.push(inputs), className: "", panelAction: "run-skill-burger:qa" })));
  const run = host.querySelector<HTMLButtonElement>('button[data-panel-action="run-skill-burger:qa"]')!;
  await act(async () => run.click());
  const field = host.querySelector<HTMLInputElement>("[data-burger-run-inputs] input")!;
  expect(field.value).toBe("https://mausbot.com");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "https://example.org");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLFormElement>("[data-burger-run-inputs]")!.requestSubmit());
  expect(ran).toEqual([{ site: "https://example.org" }]);
  expect(host.querySelector("[data-burger-run-inputs]")).toBeNull();
});
