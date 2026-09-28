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
  it("starts off and explains scope, bounded recovery, no replay and provider charges", () => {
    const view = render();
    expect(view.toggle.props.checked).toBe(false);
    expect(view.engine.props.disabled).toBe(true);
    expect(view.save.props.disabled).toBe(true);
    expect(view.html).toContain("If an ACP engine (such as Qwen or OpenCode) fails before starting, try a backup once. Work that may have already run is not replayed.");
    expect(view.html).toContain("direct bot threads, including Chief and delegated work");
    expect(view.html).toContain("Channels are not included");
    expect(view.html).toContain("Only this thread switches; bot defaults stay unchanged.");
    expect(view.html).toContain("Permissions stay unchanged; some engine switches need confirmation.");
    expect(view.html).toContain("can incur charges from its provider");
    expect(view.html).toContain('for="automatic-recovery-engine"');
    expect(view.html).toContain('for="automatic-recovery-model"');
    expect(view.html).toContain('aria-describedby="automatic-recovery-help automatic-recovery-scope"');
  });

  it("requires a ready backup, preserves drafts through broadcasts and failed saves, and saves only once", async () => {
    click(render().toggle);
    expect(render().save.props.disabled).toBe(true);
    choose(render().engine, "backup");
    choose(render().model, "m");
    fixture.config = { automaticRecovery: { enabled: false } };
    expect(render().toggle.props.checked).toBe(true);
    expect(render().model.props.value).toBe("m");
    let reject!: (cause: Error) => void;
    fixture.api.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    click(render().save);
    click(render().save);
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ automaticRecovery: { enabled: true, backup: { instanceId: "backup", model: "m" } } }) });
    expect(render().toggle.props.disabled).toBe(true);
    reject(new Error("Fixture save failed"));
    await flush();
    expect(render().html).toContain('role="alert"');
    expect(render().html).toContain("Fixture save failed");
    expect(render().model.props.value).toBe("m");
    expect(render().save.props.disabled).toBe(false);
    fixture.api.mockResolvedValueOnce({ automaticRecovery: { enabled: true, backup: { instanceId: "backup", model: "m" } } });
    click(render().save);
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(render().save.props.disabled).toBe(true);
    expect(render().html).not.toContain("Fixture save failed");
  });

  it("keeps a saved unavailable backup visible and allows disabling it", async () => {
    fixture.config = { automaticRecovery: { enabled: true, backup: { instanceId: "gone", model: "old" } } };
    expect(render().engine.props.value).toBe("gone");
    expect(render().html).toContain("gone (unavailable)");
    expect(render().save.props.disabled).toBe(true);
    click(render().toggle);
    fixture.api.mockResolvedValueOnce({ automaticRecovery: { enabled: false, backup: { instanceId: "gone", model: "old" } } });
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ automaticRecovery: { enabled: false, backup: { instanceId: "gone", model: "old" } } }) });
  });

  it("clears an incomplete selection when turning recovery off", async () => {
    click(render().toggle);
    choose(render().engine, "backup");
    click(render().toggle);
    fixture.api.mockResolvedValueOnce({ automaticRecovery: { enabled: false } });
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ automaticRecovery: { enabled: false } }) });
  });
});
