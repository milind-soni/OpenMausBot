// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EduCrewLine as Line } from "../../shared/edu-brain";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { EduCrewLine } = await import("./EduCrewLine");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const JOB = "11111111-2222-3333-4444-555555555555";
let host: HTMLDivElement;
let root: Root;
const line = (status: Line["status"]): Line => ({ jobId: JOB, kind: "plan", status, title: "Add a hello file", at: 1 });
const render = async (status: Line["status"]) => {
  const current = line(status);
  await act(async () => root.render(createElement(EduCrewLine, { message: { id: "m1", role: "bot", kind: "activity", tool: { name: "Edu crew", ok: true }, eduCrew: current } as never, line: current })));
};

beforeEach(() => {
  fixture.api.mockReset();
  fixture.api.mockImplementation(async () => ({ line: line("running"), folder: "/work/shop", spec: "the spec" }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("reloads open Details when the job moves on", async () => {
  await render("running");
  expect(fixture.api).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-edu-crew-details]")!.click());
  expect(fixture.api).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("the spec");
  fixture.api.mockImplementation(async () => ({ line: line("done"), folder: "/work/shop", spec: "the spec", summary: "built hello.txt" }));
  await render("done");
  expect(fixture.api).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("built hello.txt");
  await act(async () => host.querySelector<HTMLButtonElement>("[data-edu-crew-details]")!.click());
  await render("failed");
  expect(fixture.api).toHaveBeenCalledTimes(2);
});
