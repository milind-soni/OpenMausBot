import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import { AutomaticRecoverySettings } from "./AutomaticRecoverySettings";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: {} as Pick<ConfigStatus, "automaticRecovery">,
  instances: [] as InstanceInfo[],
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    return fixture.values[index] ??= { current: initial };
  },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config, instances: fixture.instances }, dispatch: fixture.dispatch }),
}));

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
  function Capture() { fixture.index = 0; tree = AutomaticRecoverySettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  return {
    html,
    toggle: all.find(node => node.type === Switch)!,
    engine: all.find(node => node.props.id === "automatic-recovery-engine")!,
    model: all.find(node => node.props.id === "automatic-recovery-model")!,
    save: all.find(node => node.type === "button")!,
  };
}
const click = (node: Node) => (node.props.onClick as () => void)();
const choose = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  fixture.values = [];
  fixture.config = {};
  fixture.instances = [{ instanceId: "backup", driverKind: "codex", displayName: "Backup engine",
    snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [{ id: "m", label: "Backup model" }] } }];
  fixture.api.mockReset();
  fixture.dispatch.mockReset().mockImplementation(({ config }: { config: ConfigStatus }) => { fixture.config = config; });
});

describe("AutomaticRecoverySettings", () => {
  it("starts off with one short line and no Save; Learn more explains scope, no replay, provider charges and a bot's own backups", () => {
    const view = render();
    expect(view.toggle.props.checked).toBe(false);
    // Off, the provider and model rows are not shown, and there is no Save: it saves as you go.
    expect(view.engine).toBeUndefined();
    expect(view.model).toBeUndefined();
    expect(view.save).toBeUndefined();
    expect(view.html).toContain("If a provider fails before it starts, try a backup once.");
    expect(view.html).toContain("Learn more");
    expect(view.html).not.toContain("Channels are not included");
    expect(view.html).toContain('aria-describedby="automatic-recovery-help"');
    // Learn more (the fourth piece of state) opens the rest under the row.
    fixture.values[3] = true;
    const more = render().html;
    expect(more).toContain("If an ACP model provider (such as Qwen or OpenCode) fails before starting, try a backup once. Work that may have already run is not replayed.");
    expect(more).toContain("direct bot threads, including Chief and work handed on");
    expect(more).toContain("Channels are not included");
    expect(more).toContain("Only this thread switches; bot defaults stay unchanged.");
    expect(more).toContain("Permissions stay unchanged; some provider switches need confirmation.");
    expect(more).toContain("can incur charges from its provider");
    expect(more).toContain("Bots with backups of their own (Model → Backup models for this bot) use those instead, whether or not this is on.");
  });

  it("saves as soon as a ready backup is chosen, keeps the draft through broadcasts and a failed save, and saves once at a time", async () => {
    click(render().toggle);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(render().html).toContain('aria-label="Backup provider"');
    expect(render().html).toContain("Choose a backup provider and model to turn this on.");
    choose(render().engine, "backup");
    expect(fixture.api).not.toHaveBeenCalled();
    let reject!: (cause: Error) => void;
    fixture.api.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    choose(render().model, "m");
    choose(render().model, "m");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ automaticRecovery: { enabled: true, backup: { instanceId: "backup", model: "m" } } }) });
    fixture.config = { automaticRecovery: { enabled: false } };
    expect(render().toggle.props.checked).toBe(true);
    expect(render().model.props.value).toBe("m");
    expect(render().toggle.props.disabled).toBe(true);
    reject(new Error("Fixture save failed"));
    await flush();
    expect(render().html).toContain('role="alert"');
    expect(render().html).toContain("Fixture save failed");
    expect(render().model.props.value).toBe("m");
    fixture.api.mockResolvedValueOnce({ automaticRecovery: { enabled: true, backup: { instanceId: "backup", model: "m" } } });
    choose(render().model, "m");
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(render().html).not.toContain("Fixture save failed");
  });

  it("keeps a saved unavailable backup visible and turning it off saves at once", async () => {
    fixture.config = { automaticRecovery: { enabled: true, backup: { instanceId: "gone", model: "old" } } };
    expect(render().engine.props.value).toBe("gone");
    expect(render().html).toContain("gone (unavailable)");
    fixture.api.mockResolvedValueOnce({ automaticRecovery: { enabled: false, backup: { instanceId: "gone", model: "old" } } });
    click(render().toggle);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ automaticRecovery: { enabled: false, backup: { instanceId: "gone", model: "old" } } }) });
  });

  it("clears an incomplete selection when turning recovery off", async () => {
    click(render().toggle);
    choose(render().engine, "backup");
    fixture.api.mockResolvedValueOnce({ automaticRecovery: { enabled: false } });
    click(render().toggle);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ automaticRecovery: { enabled: false } }) });
  });
});
