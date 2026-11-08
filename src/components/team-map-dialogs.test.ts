// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: request }));
const { SectionContextDialog } = await import("./TeamMapPage");
const { TeamMemoryDialog } = await import("./TeamMemoryDialog");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (path: string) => path.startsWith("/api/section-context")
    ? { text: "Be brief.", updatedAt: 1, maxBytes: 24_000 }
    : { entries: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

// A backdrop blur re-blurs the whole team map on every repaint of these dialogs, which is costly without GPU compositing.
it.each([
  ["shared instructions", SectionContextDialog],
  ["department memory", TeamMemoryDialog],
])("keeps the %s dialog's backdrop free of blur over the team map", async (_name, Dialog) => {
  flushSync(() => root.render(createElement(Dialog, { section: "General", label: "General", onClose: () => undefined })));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  const overlay = dialog!.parentElement!;
  expect(overlay.className).toContain("fixed inset-0");
  expect(overlay.classList.contains("bg-black/55")).toBe(true);
  expect(overlay.className).not.toMatch(/backdrop-blur|backdrop-filter/);
  await vi.waitFor(() => expect(request).toHaveBeenCalled());
});
