// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args) }));

const { setLocale } = await import("@/lib/i18n");
const { ResetCloudComputerButton } = await import("./ResetCloudComputerButton");
type View = import("./ResetCloudComputerButton").CloudResetView;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const stuck: View = {
  computer: "cloud", cloudBackend: "box", canManage: true, busy: false, pending: false,
  phase: "busy-boat", boatState: "starting", refusal: undefined,
};

it("keeps saying the old cloud desktop is still being deleted after the panel goes back to checking", async () => {
  setLocale("en");
  vi.stubGlobal("confirm", () => true);
  api.mockResolvedValue({ ok: true, pending: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const draw = (view: View) => createElement(ResetCloudComputerButton, { botId: "bot-a", botName: "Ada", view, onReset: () => root.render(draw({ ...view, phase: "checking", boatState: null })) });
  await act(async () => { root.render(draw(stuck)); });
  await act(async () => { host.querySelector("button")!.click(); });
  expect(host.querySelector("button")).toBeNull();
  expect(host.querySelector("[role=status]")?.textContent).toContain("Ada");
  await act(async () => { root.unmount(); });
});
