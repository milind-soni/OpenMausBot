// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string }>,
  bots: [] as Bot[],
}));

vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/i18n", () => ({ t: (key: string, params?: { name?: string }) => params?.name ? `${key}:${params.name}` : key }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { bots: fixture.bots } }),
  api: async (path: string, options?: { method?: string }) => {
    fixture.calls.push({ path, method: options?.method ?? "GET" });
    if (path.includes("local-computer/screenshot")) return { image: "data:image/png;base64,aGVsbG8=" };
    if (path.includes("local-computer")) return { ready: true };
    if (path.includes("screenshot")) return { png: "aGVsbG8=", format: "png" };
    return { configured: true, box: { state: "ready" }, ready: false };
  },
}));

const { ComputerWatchGallery } = await import("./ComputerWatchGallery");
const bot = (id: string, name: string): Bot => ({ id, name, cloudBackend: "vps", busy: true } as Bot);
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  fixture.calls.length = 0;
  fixture.bots = [];
});

describe("watching another bot's computer", () => {
  it("shows a Box screen independently of the current bot's VPS setting", async () => {
    fixture.bots = [bot("scout", "Scout"), bot("writer", "Writer")];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(ComputerWatchGallery, { bot: fixture.bots[0]! })));
    expect(fixture.calls).toEqual([]);
    await act(async () => container!.querySelector("button")!.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fixture.calls.map((call) => call.path)).toEqual([
      "/api/bots/scout/computer?watchBackend=box",
      "/api/bots/scout/computer/screenshot?watchBackend=box",
    ]);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(fixture.calls.every((call) => call.method === "GET" || call.path.includes("screenshot"))).toBe(true);
    const botChoice = container.querySelectorAll("select")[0]!;
    await act(async () => {
      botChoice.value = "writer";
      botChoice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fixture.calls.map((call) => call.path).slice(-2)).toEqual([
      "/api/bots/writer/computer?watchBackend=box",
      "/api/bots/writer/computer/screenshot?watchBackend=box",
    ]);
    const computerChoice = container.querySelectorAll("select")[1]!;
    await act(async () => {
      computerChoice.value = "vm";
      computerChoice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fixture.calls.map((call) => call.path).slice(-2)).toEqual([
      "/api/bots/writer/local-computer",
      "/api/bots/writer/local-computer/screenshot",
    ]);
  });
});
