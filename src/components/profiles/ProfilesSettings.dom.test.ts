// @vitest-environment happy-dom
// Settings → Profiles: choosing the folder, the plan in plain groups, conflicts, more access and Apply.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProfileApplyResult, ProfilePlan, ProfilePlanLine, ProfilesStatus } from "../../../shared/profile-plan";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/api")>()),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { ApiError } = await import("@/state/api");
const { ProfilesSettings, PROFILES_DOCS_URL } = await import("./ProfilesSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const FOLDER = "/home/ana/acme";
const bot = (id: string, name: string, botId?: string) => ({ kind: "bot" as const, id, name, ...(botId ? { botId } : {}) });
const line = (kind: ProfilePlanLine["kind"], text: string, extra: Partial<ProfilePlanLine> = {}): ProfilePlanLine =>
  ({ kind, subject: bot("bi/analyst", "Analista BI", "b1"), text, ...extra });
const conflict = line("conflict", "Analista BI: title: the file says \"Data analyst\", you have \"Numbers\"", {
  field: "title", conflict: { choice: "bi/analyst:title", file: "\"Data analyst\"", mine: "\"Numbers\"" },
});
const counts = { add: 0, change: 0, access: 0, conflict: 0, changedHere: 0, gone: 0, remove: 0, blocked: 0, later: 0 };
const plan = (lines: ProfilePlanLine[], patch: Partial<ProfilePlan> = {}): ProfilePlan =>
  ({ folder: FOLDER, digest: "d1", lines, counts, noChanges: lines.length === 0, problems: [], warnings: [], ...patch });
const FULL = plan([
  line("add", "Closer: new bot in Sales", { subject: bot("sales/closer", "Closer") }),
  line("change", "Reporter: instructions 2 changed", { subject: bot("bi/reporter", "Reporter", "b2"), field: "soul" }),
  line("access", "Analista BI: Edu crew off → on", { field: "eduCrew" }),
  line("changed-here", "Reporter: memory changed in this app to off; that change stays", { subject: bot("bi/reporter", "Reporter", "b2") }),
  conflict,
  line("gone", "Old helper is no longer in your profiles; it stays in this app as it is", { subject: bot("bi/old", "Old helper", "b3") }),
  line("later", "MCP server notion (mcp/notion.md) is set up from profiles in a later update; until then nothing here changes for it"),
  line("note", "Closer: this app has no codex engine, so the bot uses this app's default model"),
  line("blocked", "Seller is left as it is: its file has problems"),
], {
  problems: [{ file: "areas/sales/bots/seller.md", line: 4, message: "x", sentence: "areas/sales/bots/seller.md, line 4: approval must be one of ask, edits, auto, full" }],
  warnings: [{ file: "notes.txt", message: "x", sentence: "notes.txt: is not a profile file, so it is ignored" }],
});

let status: ProfilesStatus;
let plans: ProfilePlan[];
let applyAnswer: () => Promise<ProfileApplyResult>;
const calls = (path: string) => fixture.api.mock.calls.filter(([called]) => called === path).map(([, init]) => (init?.body ? JSON.parse(init.body) : undefined));

const render = async () => {
  await act(async () => root.render(createElement(ProfilesSettings)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const text = () => host.textContent ?? "";
const button = (name: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name);
const click = async (target: Element | undefined | null) => {
  expect(target).toBeTruthy();
  await act(async () => { (target as HTMLElement).click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const groups = () => [...host.querySelectorAll("[data-settings-block^=plan-]")].map((group) => group.querySelector("h3")?.textContent);

beforeEach(() => {
  status = { folder: FOLDER, areas: {} };
  plans = [FULL];
  applyAnswer = async () => ({ ...plan([]), applied: { lines: [], skipped: [] } });
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => {
    if (path === "/api/profiles") return status;
    if (path === "/api/profiles/plan") return plans.length > 1 ? plans.shift() : plans[0];
    if (path === "/api/profiles/apply") return applyAnswer();
    if (path === "/api/profiles/folder") return { ...status, folder: "/srv/profiles" };
    throw new Error(`unexpected ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { ogb?: unknown }).ogb;
});

it("with no folder chosen, says what a profile folder is, links the docs and takes a typed path on the web", async () => {
  status = { areas: {} };
  await render();
  expect(text()).toContain("A profile folder holds your organization's bots as files, so everyone who uses it gets the same bots.");
  expect(host.querySelector<HTMLAnchorElement>("[data-profiles-empty] a")?.href).toBe(PROFILES_DOCS_URL);
  expect(text()).toContain("Not chosen yet");
  expect(calls("/api/profiles/plan")).toEqual([]);
  const input = host.querySelector<HTMLInputElement>("[data-profiles-path]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/srv/profiles");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Use this folder"));
  expect(calls("/api/profiles/folder")).toEqual([{ folder: "/srv/profiles" }]);
  expect(calls("/api/profiles/plan")).toEqual([{ choices: {} }]);
  expect(host.querySelector("[data-profiles-path]")).toBeNull();
  await click(button("Change…"));
  expect(host.querySelector("[data-profiles-path]")).not.toBeNull();
});

it("on this computer's desktop page, chooses the folder with the system picker instead", async () => {
  status = { areas: {} };
  const pickFolder = vi.fn(async () => "/home/ana/acme");
  (window as { ogb?: unknown }).ogb = { companion: {}, pickFolder };
  await render();
  expect(host.querySelector("[data-profiles-path]")).toBeNull();
  await click(button("Choose folder…"));
  expect(pickFolder).toHaveBeenCalled();
  expect(calls("/api/profiles/folder")).toEqual([{ folder: "/home/ana/acme" }]);
});

it("shows the folder, the last apply with its commit, and every plan group in order with its lines", async () => {
  status = { folder: FOLDER, areas: {}, applied: { at: Date.UTC(2026, 10, 22, 12), commit: "6bacc2c72aa", digest: "d0", folder: FOLDER } };
  await render();
  expect(host.querySelector("[data-profiles-folder]")?.textContent).toBe(FOLDER);
  expect(host.querySelector("[data-profiles-applied]")?.textContent).toMatch(/2026.* · commit 6bacc2c$/);
  expect(groups()).toEqual(["Fix these in the files first", "Will add", "Will change", "Gives more access", "Changed here (kept)", "Conflicts",
    "No longer in your profiles (kept)", "Comes in a later update", "Good to know"]);
  const group = (id: string) => host.querySelector(`[data-settings-block=plan-${id}]`)?.textContent ?? "";
  expect(group("problems")).toContain("areas/sales/bots/seller.md, line 4: approval must be one of ask, edits, auto, full");
  expect(group("problems")).toContain("Seller is left as it is: its file has problems");
  expect(group("add")).toContain("Closer: new bot in Sales");
  expect(group("change")).toContain("Reporter: instructions 2 changed");
  expect(group("access")).toContain("Analista BI: Edu crew off → on");
  expect(group("access")).toContain("These let a bot do more. They apply only if you allow them.");
  expect(group("changedHere")).toContain("Reporter: memory changed in this app to off; that change stays");
  expect(group("conflict")).toContain("File: \"Data analyst\" · Yours: \"Numbers\"");
  expect(group("gone")).toContain("Old helper is no longer in your profiles; it stays in this app as it is");
  expect(group("later")).toContain("MCP server notion");
  expect(group("notes")).toContain("Closer: this app has no codex engine");
  expect(group("notes")).toContain("notes.txt: is not a profile file, so it is ignored");
  expect(text()).toContain("1 conflict has no choice yet, so it stays as it is.");
});

it("explains an empty folder instead of listing its problem", async () => {
  plans = [plan([], { problems: [{ file: ".", message: "has no profiles: expected org.md or areas/<key>/area.md (docs/profiles.md)", sentence: ".: has no profiles" }] })];
  await render();
  expect(host.querySelector("[data-profiles-empty] a")?.getAttribute("href")).toBe(PROFILES_DOCS_URL);
  expect(groups()).toEqual([]);
  expect(button("Apply")).toBeUndefined();
});

it("says so when everything already matches, with nothing to apply", async () => {
  plans = [plan([])];
  await render();
  expect(text()).toContain("Everything already matches the profiles.");
  expect(button("Apply")).toBeUndefined();
});

it("keeps a conflict on screen with the person's choice, plans again with it, and applies with that choice", async () => {
  const kept = line("note", "Analista BI: title: you keep yours; the file's value is recorded, so this is no longer a conflict", { field: "title" });
  plans = [plan([conflict]), plan([kept], { digest: "d2" })];
  await render();
  const row = () => host.querySelector("[data-conflict='bi/analyst:title']")!;
  const radio = (name: string) => [...row().querySelectorAll<HTMLButtonElement>("[role=radio]")].find((candidate) => candidate.textContent === name)!;
  expect(radio("Keep mine").getAttribute("aria-checked")).toBe("false");
  expect(radio("Take the file's").getAttribute("aria-checked")).toBe("false");
  await click(radio("Keep mine"));
  expect(calls("/api/profiles/plan").at(-1)).toEqual({ choices: { "bi/analyst:title": "mine" } });
  expect(radio("Keep mine").getAttribute("aria-checked")).toBe("true");
  expect(text()).not.toContain("you keep yours");
  await click(button("Apply"));
  expect(calls("/api/profiles/apply")).toEqual([{ choices: { "bi/analyst:title": "mine" }, giveAccess: false, expect: "d2" }]);
});

it("applies without more access unless it is allowed, and asks a second time before giving it", async () => {
  await render();
  await click(button("Apply"));
  expect(calls("/api/profiles/apply")).toEqual([{ choices: {}, giveAccess: false, expect: "d1" }]);

  await click(host.querySelector("[data-profiles-action=allow-access]"));
  await click(button("Apply"));
  expect(calls("/api/profiles/apply")).toHaveLength(1);
  const confirm = host.querySelector("[data-profiles-confirm]")!;
  expect(confirm.textContent).toContain("Give more access?");
  expect(confirm.textContent).toContain("This gives more access to Analista BI:");
  expect([...confirm.querySelectorAll("[data-profiles-confirm-line]")].map((item) => item.textContent)).toEqual(["Analista BI: Edu crew off → on"]);
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(document.activeElement?.className).toContain("focus:outline-focus");
  await click(button("Cancel"));
  expect(host.querySelector("[data-profiles-confirm]")).toBeNull();
  expect(calls("/api/profiles/apply")).toHaveLength(1);

  await click(button("Apply"));
  await click(button("Give access and apply"));
  expect(calls("/api/profiles/apply").at(-1)).toEqual({ choices: {}, giveAccess: true, expect: "d1" });
});

it("shows the server's refusal with what to do, and can apply the rest without more access", async () => {
  const refusal = "These changes give bots more access, so they have to be confirmed from the desktop app or a paired admin device.";
  applyAnswer = async () => { throw new ApiError(refusal, 403, { error: refusal }); };
  await render();
  await click(host.querySelector("[data-profiles-action=allow-access]"));
  await click(button("Apply"));
  await click(button("Give access and apply"));
  const refused = host.querySelector("[data-profiles-refused]")!;
  expect(refused.getAttribute("role")).toBe("alert");
  expect(refused.textContent).toContain(refusal);
  expect(refused.textContent).toContain("Open Edu Bot on this computer and apply there, or apply without more access.");
  expect(host.querySelector("[data-profiles-action=allow-access]")?.getAttribute("aria-checked")).toBe("false");
  expect(button("Apply")).toBeUndefined();
  applyAnswer = async () => ({ ...plan([]), applied: { lines: [FULL.lines[0]!], skipped: [] } });
  await click(button("Apply without more access"));
  expect(calls("/api/profiles/apply").at(-1)).toEqual({ choices: {}, giveAccess: false, expect: "d1" });
});

it("after an apply, says how many bots were updated and what was left out, and plans again", async () => {
  applyAnswer = async () => ({
    ...plan([]),
    applied: {
      lines: [FULL.lines[0]!, FULL.lines[1]!, line("change", "Reporter: title", { subject: bot("bi/reporter", "Reporter", "b2") }),
        line("change", "Analista BI: soul"), line("add", "Area Sales", { subject: { kind: "area", id: "sales", name: "Sales" } })],
      skipped: [{ ...FULL.lines[2]!, reason: "More access was not confirmed." }],
    },
  });
  plans = [FULL, plan([line("access", "Analista BI: Edu crew off → on", { field: "eduCrew" })], { digest: "d3" })];
  await render();
  await click(button("Apply"));
  expect(host.querySelector("[data-profiles-result]")?.textContent).toContain("3 bots updated.");
  expect(host.querySelector("[data-profiles-skipped]")?.textContent).toBe("Left out: Analista BI: Edu crew off → on. More access was not confirmed.");
  expect(calls("/api/profiles/plan")).toHaveLength(2);
  expect(calls("/api/profiles")).toHaveLength(2);
  expect(groups()).toEqual(["Gives more access"]);
  expect(button("Apply")).toBeUndefined();
  expect(text()).toContain("Only more access is left. Turn on Allow more access to apply it.");
});

it("with only more access left, offers the switch instead of Apply, and after a refusal turns the switch off", async () => {
  const refusal = "These changes give bots more access, so they have to be confirmed from the desktop app or a paired admin device.";
  applyAnswer = async () => { throw new ApiError(refusal, 403, { error: refusal }); };
  plans = [plan([line("access", "Analista BI: Edu crew off → on", { field: "eduCrew" })])];
  await render();
  expect(button("Apply")).toBeUndefined();
  expect(host.querySelector("[data-profiles-access-only]")?.textContent).toBe("Only more access is left. Turn on Allow more access to apply it.");
  await click(host.querySelector("[data-profiles-action=allow-access]"));
  expect(host.querySelector("[data-profiles-access-only]")).toBeNull();
  await click(button("Apply"));
  await click(button("Give access and apply"));
  expect(calls("/api/profiles/apply")).toEqual([{ choices: {}, giveAccess: true, expect: "d1" }]);
  expect(host.querySelector("[data-profiles-action=allow-access]")?.getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector("[data-profiles-refused]")?.textContent).toContain("Open Edu Bot on this computer and apply there.");
  expect(text()).not.toContain("apply without more access");
  expect(button("Apply")).toBeUndefined();
  expect(button("Apply without more access")).toBeUndefined();
});

it("says nothing was applied when every line was left out", async () => {
  applyAnswer = async () => ({ ...plan([]), applied: { lines: [], skipped: [{ ...FULL.lines[2]!, reason: "More access was not confirmed." }] } });
  await render();
  await click(button("Apply"));
  expect(host.querySelector("[data-profiles-result]")?.textContent).toContain("Nothing was applied.");
  expect(text()).not.toContain("Applied. No bot changed.");
});

it("shows the new plan when the profiles changed since the person looked", async () => {
  const fresh = plan([line("change", "Reporter: title \"A\" → \"B\"", { subject: bot("bi/reporter", "Reporter", "b2") })], { digest: "d9" });
  applyAnswer = async () => { throw new ApiError("changed", 409, { error: "changed", plan: fresh }); };
  await render();
  await click(button("Apply"));
  expect(host.querySelector("[data-profiles-stale]")?.textContent).toBe("The profiles changed since you looked. Check the new plan, then apply again.");
  expect(groups()).toEqual(["Will change"]);
  await click(button("Apply"));
  expect(calls("/api/profiles/apply").at(-1)).toMatchObject({ expect: "d9" });
});

it("shows a plan error next to the plan with a way to try again", async () => {
  let fail = true;
  fixture.api.mockImplementation(async (path: string) => {
    if (path === "/api/profiles") return status;
    if (fail) throw new ApiError("A profile folder cannot be inside this app's data folder.", 400);
    return FULL;
  });
  await render();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("Couldn't read the profiles. A profile folder cannot be inside this app's data folder.");
  fail = false;
  await click(button("Try again"));
  expect(groups()).toHaveLength(9);
});
