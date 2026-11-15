// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; init?: { method?: string; body?: string } }> = [];
let status: unknown = null;
let answer: unknown = { answers: true };
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, init });
    return init?.method === "POST" ? answer : { recovery: status };
  }),
}));

import { CloudComputerRecoveryRow } from "./CloudComputerRecovery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls.length = 0;
  status = null;
  answer = { answers: true };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = async (always = true) => {
  await act(async () => { root.render(createElement(CloudComputerRecoveryRow, { botId: "bot-1", name: "Ada", always })); });
};
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label))!;

describe("the computer panel's recovery row", () => {
  it("shows nothing in Simple mode while the computer is fine", async () => {
    await render(false);
    expect(host.querySelector("[data-testid=cloud-computer-recovery]")).toBeNull();
  });

  it("shows what MausBot did, in Simple mode too, with the buttons", async () => {
    status = { state: "replaced", at: 1 };
    await render(false);
    expect(host.textContent).toContain("Ada's cloud computer stopped responding, so MausBot replaced it with a new one. Files that were only on the old computer are gone.");
    expect(button("Restart computer")).toBeTruthy();
    expect(button("Replace computer")).toBeTruthy();
  });

  it("holds the buttons while a restart or replacement is under way", async () => {
    status = { state: "replacing", at: 1 };
    await render();
    expect(host.textContent).toContain("This cloud computer isn't responding. MausBot is replacing it.");
    expect(button("Restart computer").disabled).toBe(true);
    expect(button("Replace computer").disabled).toBe(true);
  });

  it("restarts on one click and says when the computer still does not answer", async () => {
    answer = { answers: false };
    await render();
    await act(async () => { button("Restart computer").click(); });
    expect(calls.find((call) => call.init?.method === "POST")).toEqual({ path: "/api/bots/bot-1/computer/recovery", init: { method: "POST", body: JSON.stringify({ action: "restart" }) } });
    expect(host.textContent).toContain("The cloud computer still isn't answering after a restart. Replace computer gives Ada a new one.");
  });

  it("replaces only after the person confirms that files only on it are lost", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    window.confirm = confirm;
    await render();
    await act(async () => { button("Replace computer").click(); });
    expect(confirm).toHaveBeenCalledWith("Replace Ada's cloud computer with a new one? Files that are only on this computer are lost.");
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
    confirm.mockReturnValue(true);
    answer = { replaced: true };
    await act(async () => { button("Replace computer").click(); });
    expect(calls.filter((call) => call.init?.method === "POST").map((call) => call.init?.body)).toEqual([JSON.stringify({ action: "replace" })]);
  });
});
