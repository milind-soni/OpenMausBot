// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { BurstCardData } from "../../shared/burst";

const sent = vi.hoisted(() => ({ failure: null as unknown }));
vi.mock("@/state/store", async () => {
  const { ApiError } = await import("@/state/api");
  return { ApiError, api: vi.fn(async () => { throw sent.failure; }), openThread: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));

const card: BurstCardData = {
  version: 1, burstId: "b1", botId: "bot", task: "Research these companies", phase: "preview", total: 2, requested: 2, parallel: 2, modelName: "Fast 1",
  estimateMinutes: 1, counts: { queued: 2, running: 0, done: 0, failed: 0, cancelled: 0 }, sample: ["Acme", "Globex"],
};

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function pressRun(failure: unknown): Promise<string> {
  sent.failure = failure;
  const { BurstCard } = await import("./BurstCard");
  await act(async () => { root.render(createElement(BurstCard, { card })); });
  const run = [...container.querySelectorAll("button")].find((button) => button.textContent === "Run")!;
  await act(async () => { run.click(); });
  return container.textContent ?? "";
}

describe("a burst card press the server refuses", () => {
  it("says why when the server names the reason, such as only the Cloud's owner may answer", async () => {
    const { ApiError } = await import("@/state/api");
    const body = { error: "refused", errorKey: "serverError.card.cloudOwnerOnly" };
    const text = await pressRun(new ApiError("Only the owner of this Cloud can answer this card. Chats started by other people always ask the owner first, whatever the bot's access level.", 403, body));
    expect(text).toContain("Only the owner of this Cloud can answer this card.");
    expect(text).not.toContain("That didn't work. Try again in a moment.");
  });

  it("keeps the general try-again line when the server gives no reason", async () => {
    const text = await pressRun(new TypeError("Failed to fetch"));
    expect(text).toContain("That didn't work. Try again in a moment.");
  });
});
