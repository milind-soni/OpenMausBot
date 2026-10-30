// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { DiagnosticsRow } from "./DiagnosticsRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const FOLDER = "C:\\Users\\Ash\\AppData\\Roaming\\OpenMausBot\\logs";

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { ogb?: unknown }).ogb;
});
async function render() { await act(async () => root.render(createElement(DiagnosticsRow))); }
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
async function click(label: string) {
  await act(async () => button(label)!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

it("opens this computer's logs folder and says where it is; export still removes secrets", async () => {
  const openLogsFolder = vi.fn().mockResolvedValue({ folder: FOLDER, opened: true });
  (window as { ogb?: unknown }).ogb = { openLogsFolder, exportDiagnostics: vi.fn() };
  await render();
  expect(host.querySelector("[data-logs-help]")!.textContent).toBe("Logs stay on this computer. Export Diagnostics saves their most recent part with keys, passwords and sign-ins removed, ready to send to support.");
  await click("Open logs folder");
  expect(openLogsFolder).toHaveBeenCalledExactlyOnceWith();
  expect(host.querySelector("[data-logs-folder]")!.textContent).toBe(`Logs are in ${FOLDER}.`);
  expect(button("Export Diagnostics…")).toBeDefined();
});

it("when the folder cannot be opened, says where it is instead", async () => {
  (window as { ogb?: unknown }).ogb = { openLogsFolder: vi.fn().mockResolvedValue({ folder: FOLDER, opened: false, error: "Failed to open path" }), exportDiagnostics: vi.fn() };
  await render();
  await click("Open logs folder");
  expect(host.querySelector("[role=alert]")!.textContent).toBe(`Could not open the logs folder. It is ${FOLDER}.`);
});

it("on My Cloud's page (no desktop bridge) offers no buttons that do nothing, and says where logs are kept", async () => {
  (window as { ogb?: unknown }).ogb = { platform: "win32" };
  await render();
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(host.querySelector("[data-logs-help]")!.textContent).toContain("MausBot Cloud support can read the Cloud's.");
});
