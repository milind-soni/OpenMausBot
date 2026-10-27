// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { WelcomeFields } from "@/lib/welcome-draft";

const store = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), state: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: store.state, dispatch: store.dispatch }) }));
const analytics = vi.hoisted(() => ({ identifyEmail: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/analytics", () => analytics);
const { HelloBeat } = await import("./HelloBeat");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn(), onFields: vi.fn() };
let host: HTMLDivElement, root: Root;
const saved = { current: undefined as { name?: string } | undefined };
const show = async (fields: WelcomeFields, hosted?: boolean) => {
  await act(async () => { root.render(createElement(HelloBeat, { ...props, fields, saved, ...(hosted === undefined ? {} : { hosted }) })); });
};
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;
const press = async (label: string) => { await act(async () => { button(label).click(); }); };
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const putBodies = () => store.api.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
  setLocale("en");
  store.api.mockReset();
  store.api.mockImplementation(async (_path: string, init: { body: string }) => ({ profile: JSON.parse(init.body).profile }));
  store.dispatch.mockReset();
  store.state = { config: { profile: { name: "" } } };
  saved.current = { name: "" };
  for (const fn of [...Object.values(props), analytics.identifyEmail, analytics.track]) fn.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the greeting beat", () => {
  it("asks a hosted workspace for nothing and saves nothing", async () => {
    await show({ name: "" }, true);
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toContain("shared OpenMausBot");
    expect(host.textContent).toContain("nothing to install");
    await press("Continue");
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("asks for a name only: the email is asked once, by the separate product-updates question", async () => {
    await show({ name: "" });
    expect(host.querySelectorAll("input")).toHaveLength(1);
    expect(host.querySelector('input[type="email"]')).toBeNull();
    expect(host.querySelector('input[type="text"]')?.getAttribute("placeholder")).toBe("Your name");
    expect(host.textContent).toContain("Bots that do real work for you. What should we call you?");
    expect(host.textContent).not.toMatch(/email|updates|big things ship/i);
    expect(host.textContent).not.toContain("shared OpenMausBot");
  });

  it("Continue is a plain button, held only while it saves, and goes on once the name is saved", async () => {
    let release!: (value: unknown) => void;
    store.api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await show({ name: " Ada " });
    expect(button("Continue").disabled).toBe(false);
    expect(button("Continue").hasAttribute("aria-disabled")).toBe(false);
    await press("Continue");
    expect(button("Saving…").disabled).toBe(true);
    expect(button("Maybe later").disabled, "no second way forward while saving").toBe(true);
    expect(props.onNext).not.toHaveBeenCalled();
    await act(async () => { release({ profile: { name: "Ada" } }); });
    await flush();
    expect(putBodies()).toEqual([{ profile: { name: "Ada" } }]);
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(analytics.identifyEmail, "nothing ties analytics to an email here").not.toHaveBeenCalled();
  });

  it("lets Continue go on with no name at all, saving nothing", async () => {
    await show({ name: "" });
    await press("Continue");
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("Maybe later still saves the name typed, and goes on at once", async () => {
    await show({ name: "Ada" });
    await press("Maybe later");
    expect(props.onSkip).toHaveBeenCalledOnce();
    await flush();
    expect(putBodies()).toEqual([{ profile: { name: "Ada" } }]);
    expect(analytics.identifyEmail).not.toHaveBeenCalled();
  });

  it("never writes a blank over a saved name", async () => {
    saved.current = { name: "Ada" };
    await show({ name: "" });
    await press("Maybe later");
    await press("Continue");
    await flush();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("reports every keystroke to the flow, which keeps the name", async () => {
    await show({ name: "" });
    const name = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Ada");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(props.onFields).toHaveBeenLastCalledWith({ name: "Ada" });
  });

  it("Enter in the name field is Continue", async () => {
    await show({ name: "Ada" });
    const name = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => { name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
    expect(putBodies()).toEqual([{ profile: { name: "Ada" } }]);
    expect(props.onNext).toHaveBeenCalledOnce();
  });
});
