// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { RoutineRetentionSettings } from "./RoutineRetentionSettings";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), threads: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: { threads: fixture.threads } }, dispatch: fixture.dispatch }),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.threads = {};
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });
const render = () => flushSync(() => root.render(createElement(RoutineRetentionSettings)));

it("hides the option for a server that does not support it", () => {
  render();
  expect(host.querySelector("#routine-retention-enabled")).toBeNull();
});

it("opts in for seven days and can turn a custom window off", async () => {
  fixture.threads = { routineExecutionRetentionSupported: true };
  fixture.api.mockResolvedValue({ threads: { routineExecutionRetentionSupported: true, routineExecutionRetentionDays: 7 } });
  render();
  const toggle = host.querySelector<HTMLButtonElement>("#routine-retention-enabled")!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(host.textContent).toContain("after 7 days");
  flushSync(() => toggle.click());
  await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledOnce());
  expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ routineExecutionRetentionDays: 7 }) });

  fixture.threads = { routineExecutionRetentionSupported: true, routineExecutionRetentionDays: 30 };
  fixture.api.mockResolvedValue({ threads: { routineExecutionRetentionSupported: true } });
  render();
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("after 30 days");
  flushSync(() => toggle.click());
  await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(2));
  expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ routineExecutionRetentionDays: null }) });
});
