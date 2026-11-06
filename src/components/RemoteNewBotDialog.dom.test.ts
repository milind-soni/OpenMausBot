// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), announce: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ dispatch: fixture.dispatch, state: { instances: [
    { instanceId: "codex", displayName: "Codex", driverKind: "codex", snapshot: { state: "available", authenticated: true }, models: { options: [{ id: "gpt", label: "GPT" }] } },
    { instanceId: "signed-out", displayName: "Signed out", driverKind: "claude", snapshot: { state: "available", authenticated: false }, models: { options: [{ id: "cloud", label: "Cloud" }] } },
  ] } }),
}));
vi.mock("@/lib/new-bot", () => ({ announceNewBot: fixture.announce }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
import { RemoteNewBotDialog } from "./RemoteNewBotDialog";

afterEach(() => { document.body.innerHTML = ""; vi.clearAllMocks(); });

it("creates a remote bot with the chosen host model and reports failures", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  fixture.api.mockRejectedValueOnce(new Error("Model unavailable")).mockResolvedValueOnce({ bot: { id: "new" } });
  flushSync(() => root.render(createElement(RemoteNewBotDialog, { onClose: close })));
  const select = host.querySelector("select")!;
  expect(select.textContent).toContain("Codex · GPT");
  expect(select.textContent).not.toContain("Signed out");
  select.value = JSON.stringify({ instanceId: "codex", model: "gpt" });
  flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
  const create = [...host.querySelectorAll("button")].find(button => button.textContent === "newBot.create")!;
  flushSync(() => create.click());
  await vi.waitFor(() => expect(host.querySelector("[role=alert]")?.textContent).toBe("Model unavailable"));
  expect(close).not.toHaveBeenCalled();
  flushSync(() => create.click());
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(fixture.api).toHaveBeenLastCalledWith("/api/bots", expect.objectContaining({ method: "POST", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt" }, requireAvailableModel: true }) }));
  expect(fixture.announce).toHaveBeenCalledOnce();
  flushSync(() => root.unmount());
});
