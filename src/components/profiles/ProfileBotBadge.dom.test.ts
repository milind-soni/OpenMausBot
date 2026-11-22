// @vitest-environment happy-dom
// Bot settings: where a bot came from, what was changed here since, and the keys its profile asks this person for.
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProfileBotView } from "../../../shared/profile-plan";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/api")>()),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { DriftMark, ProfileBotBadge, useProfileBotView } = await import("./ProfileBotBadge");
const { setEduCrew } = await import("@/lib/edu-brain");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const source = { area: "sales", key: "closer", file: "areas/sales/bots/closer.md", appliedAt: 1, hashes: { title: "aaaa" } };
const closer = (patch: Partial<Bot> = {}) => ({ id: "b1", name: "Closer", title: "Sales follow-up", soul: "", profileSource: source, ...patch }) as unknown as Bot;

function Panel({ bot }: { bot: Bot }) {
  const view = useProfileBotView(bot);
  return createElement(Fragment, null,
    createElement(ProfileBotBadge, { bot, view }),
    createElement("span", { "data-row": "job" }, "Job", createElement(DriftMark, { view, field: "title" })),
    createElement("span", { "data-row": "approval" }, "Approval", createElement(DriftMark, { view, field: "approval" })));
}

const render = async (bot: Bot) => {
  await act(async () => root.render(createElement(Panel, { bot })));
  await act(async () => { vi.advanceTimersByTime(500); });
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  vi.useFakeTimers();
  fixture.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("names the profile, marks the fields changed here, and asks for each key without ever showing one", async () => {
  const view: ProfileBotView = {
    changedHere: ["title", "soul", "chief"],
    secrets: [{ kind: "secret", name: "EDU_CLOUD_SALES", for: "Edu brain" }, { kind: "env", name: "NOTION_TOKEN", for: "notion" }, { kind: "file", for: "drive" }],
  };
  fixture.api.mockResolvedValue(view);
  await render(closer());
  expect(fixture.api).toHaveBeenCalledWith("/api/profiles/bots/b1");
  const badge = host.querySelector("[data-profile-badge]")!;
  expect(badge.querySelector("[data-profile-from]")?.textContent).toBe("From profile sales/closer");
  expect(badge.querySelector("[data-profile-changed]")?.textContent).toBe("Changed here: job, instructions, Chief of Staff");
  expect(badge.querySelector("[data-profile-secret=NOTION_TOKEN]")?.textContent).toBe("NOTION_TOKEN · Needs your keyfor notion");
  expect(badge.querySelector("[data-profile-secret=EDU_CLOUD_SALES]")?.textContent).toContain("Needs your key");
  expect(badge.querySelector("[data-profile-secret-kind=file]")?.textContent).toBe("Needs a key filefor drive");
  expect(host.querySelector("[data-row=job] [data-profile-drift=title]")?.textContent).toBe("Changed here");
  expect(host.querySelector("[data-row=approval] [data-profile-drift]")).toBeNull();
});

it("reads the view again after a field is edited here", async () => {
  fixture.api.mockResolvedValue({ changedHere: [], secrets: [] });
  await render(closer());
  expect(host.querySelector("[data-profile-drift]")).toBeNull();
  fixture.api.mockResolvedValue({ changedHere: ["title"], secrets: [] });
  await render(closer({ title: "Writes emails" }));
  expect(fixture.api).toHaveBeenCalledTimes(2);
  expect(host.querySelector("[data-row=job] [data-profile-drift=title]")).not.toBeNull();
});

it("reads the view again after Chief of Staff, or the Edu brain or crew, is changed here", async () => {
  fixture.api.mockResolvedValue({ changedHere: [], secrets: [] });
  await render(closer({ chiefOfStaff: true }));
  fixture.api.mockResolvedValue({ changedHere: ["chief"], secrets: [] });
  await render(closer({ chiefOfStaff: false }));
  expect(fixture.api).toHaveBeenCalledTimes(2);
  expect(host.querySelector("[data-profile-changed]")?.textContent).toBe("Changed here: Chief of Staff");

  fixture.api.mockResolvedValue({ changedHere: ["chief", "eduCrew"], secrets: [] });
  await act(async () => { await setEduCrew("b1", true); });
  await act(async () => { vi.advanceTimersByTime(500); });
  await act(async () => { await Promise.resolve(); });
  expect(fixture.api.mock.calls.map(([path]) => path).slice(2)).toEqual(["/api/bots/b1", "/api/profiles/bots/b1"]);
  expect(host.querySelector("[data-profile-changed]")?.textContent).toBe("Changed here: Chief of Staff, Edu crew");

  await act(async () => { await setEduCrew("other", false); });
  await act(async () => { vi.advanceTimersByTime(500); });
  expect(fixture.api).toHaveBeenCalledTimes(5);
});

it("still names the profile when this person may not read profiles, and shows nothing for a bot made here", async () => {
  fixture.api.mockRejectedValue(new Error("Admin only"));
  await render(closer());
  expect(host.querySelector("[data-profile-from]")?.textContent).toBe("From profile sales/closer");
  expect(host.querySelector("[data-profile-changed], [data-profile-secret], [data-profile-drift]")).toBeNull();

  fixture.api.mockClear();
  await render(closer({ profileSource: undefined }));
  expect(host.querySelector("[data-profile-badge]")).toBeNull();
  expect(fixture.api).not.toHaveBeenCalled();
});
