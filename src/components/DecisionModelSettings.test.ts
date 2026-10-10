import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { DecisionModelSettings, deciderFailureText } from "./DecisionModelSettings";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: null as ConfigStatus | null,
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

const KEY = "tsk_ui_secret_key_value";
type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = DecisionModelSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const byTestId = (id: string) => all.filter((node) => node.props["data-testid"] === id);
  return {
    html,
    switches: all.filter((node) => node.type === Switch),
    master: byTestId("decider-master")[0]!,
    job: byTestId("decider-job-roomRouting")[0]!,
    save: byTestId("decider-save")[0]!,
    test: byTestId("decider-test")[0]!,
    input: all.find((node) => node.type === "input")!,
  };
}
const click = (node: Node) => (node.props.onClick as () => void)();
const type = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const status = (decider: NonNullable<ConfigStatus["decider"]>) => ({ decider } as ConfigStatus);

beforeEach(() => {
  fixture.values = [];
  fixture.config = status({ provider: "jev", configured: false, enabled: false, jobs: { roomRouting: true } });
  fixture.api.mockReset();
  fixture.dispatch.mockReset().mockImplementation(({ config }: { config: ConfigStatus }) => { fixture.config = config; });
  vi.stubGlobal("window", {});
});

describe("DecisionModelSettings", () => {
  it("explains itself, then the switch, the key, and what it decides", () => {
    const view = render();
    const order = ["A fast decision model that picks things for your bots", "Use Jev for fast decisions", "Jev API key", "What it decides", "Who answers in rooms"]
      .map((text) => view.html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(view.html).toContain("Not connected");
    expect(view.html).toContain('href="https://typesafe.ai"');
    // the switch stays off, and cannot be turned on, while no key is saved
    expect(view.master.props.checked).toBe(false);
    expect(view.master.props.disabled).toBe(true);
    expect(view.html).toContain("Save a key below to turn this on.");
  });

  it("lists the coming-soon jobs with no switch", () => {
    const view = render();
    for (const label of ["Browser clicks", "Tool selection", "Where work runs"]) expect(view.html).toContain(label);
    expect(view.html.match(/Coming soon/g)).toHaveLength(3);
    // only the master switch and the room job have switches
    expect(view.switches).toHaveLength(2);
  });

  it("every button shows a pointer cursor", () => {
    const view = render();
    for (const node of [view.save, view.test, view.master, view.job]) expect(String(node.props.className)).toContain("cursor-pointer");
  });

  it("saves the key, shows Connected, and never renders the key back", async () => {
    fixture.api.mockResolvedValueOnce(status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } }));
    type(render().input, KEY);
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { key: KEY } }) });
    const view = render();
    expect(view.html).toContain("Connected");
    expect(view.html).not.toContain(KEY);
    expect(view.input.props.value).toBe("");
    expect(view.master.props.checked).toBe(true);
  });

  it("the master switch and the job switch patch the config", async () => {
    fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    fixture.api.mockResolvedValue(fixture.config);
    click(render().master);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { enabled: false } }) });
    fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    click(render().job);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { jobs: { roomRouting: false } } }) });
  });

  it("Test shows the result: how fast on success, a fixed sentence on failure", async () => {
    fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 342 });
    click(render().test);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: "{}" });
    expect(render().html).toContain("Jev answered in 342 ms.");

    fixture.api.mockResolvedValueOnce({ ok: false, reason: "rejected", status: 401 });
    type(render().input, "tsk_draft");
    click(render().test);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ key: "tsk_draft" }) });
    expect(render().html).toContain("Jev rejected this key. Check it at typesafe.ai.");
  });

  it("shows Cloud Pro's included decisions as included, on, with nothing to clear", () => {
    fixture.config = status({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    const view = render();
    expect(view.html).toContain("Included with your Cloud plan");
    expect(view.html).not.toContain("Connected");
    expect(view.html).not.toContain("Not connected");
    expect(view.html).not.toContain("Save a key below to turn this on.");
    expect(view.master.props.checked).toBe(true);
    expect(view.master.props.disabled).toBe(false);
    expect(view.job.props.checked).toBe(true);
    // no saved key: nothing to clear or replace, and Save waits for a pasted key
    expect(view.html).not.toContain("Clear");
    expect(view.html).not.toContain("Remove the saved key");
    expect(view.save.props.disabled).toBe(true);
    expect(view.input.props.placeholder).toBe("Paste your TypeSafe API key");
    expect(view.test.props.disabled).toBe(false);
  });

  it("with an own key saved as well, shows Connected and offers Clear, as without Cloud Pro", () => {
    fixture.config = status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    const view = render();
    expect(view.html).toContain("Connected");
    expect(view.html).not.toContain("Included with your Cloud plan");
    expect(view.html).toContain("Clear");
    expect(view.save.props.disabled).toBe(false);
  });

  it("can be switched off, and a pasted own key is saved to replace it", async () => {
    fixture.config = status({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    fixture.api.mockResolvedValueOnce(status({ provider: "jev", configured: true, included: true, enabled: false, jobs: { roomRouting: true } }));
    click(render().master);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { enabled: false } }) });
    expect(render().master.props.checked).toBe(false);
    // an empty Save never clears the included decisions
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    fixture.api.mockResolvedValueOnce(status({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } }));
    type(render().input, KEY);
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { key: KEY } }) });
    expect(render().html).toContain("Connected");
  });

  it("Test checks the included decisions, and says what a refusal from Cloud Pro means", async () => {
    fixture.config = status({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    fixture.api.mockResolvedValueOnce({ ok: true, latencyMs: 210 });
    click(render().test);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: "{}" });
    expect(render().html).toContain("Jev answered in 210 ms.");
    for (const [result, text] of [
      [{ ok: false, reason: "http_error", status: 402 }, "Decisions are included with an active Cloud subscription."],
      [{ ok: false, reason: "rate_limited", status: 429 }, "Your Cloud plan&#x27;s decisions are busy or used up for this month. Try again later."],
      [{ ok: false, reason: "rejected", status: 401 }, "MausBot Cloud did not accept this machine&#x27;s decisions. Try again later."],
    ] as const) {
      fixture.api.mockResolvedValueOnce(result);
      click(render().test);
      await flush();
      expect(render().html).toContain(text);
      expect(render().html).not.toContain("typesafe.ai.");
    }
    // a pasted draft is the person's own key, tested at Jev
    fixture.api.mockResolvedValueOnce({ ok: false, reason: "rejected", status: 401 });
    type(render().input, "tsk_draft");
    click(render().test);
    await flush();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ key: "tsk_draft" }) });
    expect(render().html).toContain("Jev rejected this key. Check it at typesafe.ai.");
  });

  it("maps every failure to a fixed sentence", () => {
    expect(deciderFailureText({ reason: "overloaded" })).toBe("Jev is overloaded right now. Try again shortly.");
    expect(deciderFailureText({ reason: "http_error", status: 500 })).toBe("Jev returned an unexpected error (HTTP 500).");
    expect(deciderFailureText({ reason: "something-new" })).toBe("The test did not finish. Try again.");
  });
});
