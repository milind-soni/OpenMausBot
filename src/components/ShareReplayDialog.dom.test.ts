// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body?: unknown }> }));
vi.mock("@/state/api", () => ({
  api: async (path: string, init?: { body?: string }) => {
    fixture.calls.push({ path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (path.endsWith("/replay/publish")) return { card: { state: "live", title: "Signed up", url: "https://pages.example/abc" } };
    return {
      jobs: [{ requestId: "u1", at: 1, text: "Sign me up" }],
      replay: {
        requestId: "u1", title: "Sign me up", bot: "Scout", request: "Sign me up", answer: "Done", startedAt: 1, endedAt: 2, leftOutToFit: 0,
        steps: [
          { n: 1, kind: "browser", action: "Opened example.test", site: "example.test/signup", ok: true, imageUrl: "/api/threads/t1/evidence/gen-00001/step-000041.jpg", pictured: true },
          { n: 2, kind: "tool", action: "Read notes.md", ok: true, imageUrl: null, pictured: false },
        ],
      },
    };
  },
}));
import { closeShareReplay, openShareReplay } from "@/lib/share-replay";
import { ShareReplayHost } from "./ShareReplayDialog";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.calls = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { closeShareReplay(); root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const dialog = () => document.querySelector<HTMLElement>("[data-share-replay]");

it("shows every step before anything is shared, publishes without the screenshots taken out, and shows the link", async () => {
  await act(async () => root.render(createElement(ShareReplayHost)));
  expect(dialog()).toBeNull();
  await act(async () => openShareReplay({ threadId: "t1", botId: "b1" }));
  expect(fixture.calls.map((call) => call.path)).toEqual(["/api/threads/t1/replay"]);
  expect(dialog()!.textContent).toContain("Opened example.test");
  expect(dialog()!.textContent).toContain("Read notes.md");
  expect(dialog()!.querySelector("[data-replay-counts]")!.textContent).toBe("Steps: 2 · Screenshots: 1");
  expect(dialog()!.querySelectorAll("img")).toHaveLength(1);

  await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-replay-toggle="1"]')!.click());
  expect(dialog()!.querySelectorAll("img")).toHaveLength(0);
  expect(dialog()!.querySelector("[data-replay-counts]")!.textContent).toBe("Steps: 2 · Screenshots: 0");

  await act(async () => dialog()!.querySelector<HTMLButtonElement>("[data-replay-publish]")!.click());
  expect(fixture.calls.at(-1)).toEqual({ path: "/api/threads/t1/replay/publish", body: { request: "u1", title: "Sign me up", leaveOut: [1] } });
  expect(dialog()!.querySelector("[data-replay-link]")!.textContent).toContain("https://pages.example/abc");
  expect(dialog()!.querySelector("[data-replay-publish]")!.textContent).toBe("Update link");
});
