import { isValidElement, type ChangeEvent, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import { localeChoices } from "@/locales";
import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), refreshInstances: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => fixture }));
// Exercise the component's event handlers without a DOM. The browser fixture
// separately checks the disabled controls; these probes control async ordering.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
}));
import { ProviderIconPicker } from "./ProviderIconPicker";

function elements(root: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(root)) return [];
  return [root, ...elements(root.props.children)];
}

const instance: InstanceInfo = {
  instanceId: "work", driverKind: "codex", displayName: "Work",
  snapshot: { state: "available" }, models: { default: "fixture", options: [] },
  icon: { kind: "preset", preset: "azure" },
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let images: Array<{ onload: () => void; onerror: () => void }>;

function controls() {
  const nodes = elements(ProviderIconPicker({ instance }));
  const upload = nodes.find((node) => node.type === "input")!.props.onChange as (event: ChangeEvent<HTMLInputElement>) => void;
  const select = nodes.find((node) => node.type === "select")!.props.onChange as (event: ChangeEvent<HTMLSelectElement>) => void;
  const reset = nodes.find((node) => node.type === "button")!.props.onClick as () => void;
  return {
    upload: () => upload({ currentTarget: { files: [new File([png], "icon.png", { type: "image/png" })], value: "icon.png" } } as unknown as ChangeEvent<HTMLInputElement>),
    select: () => select({ target: { value: "google" } } as ChangeEvent<HTMLSelectElement>),
    reset,
  };
}

beforeEach(() => {
  fixture.api.mockReset().mockResolvedValue({});
  fixture.refreshInstances.mockReset().mockResolvedValue(undefined);
  images = [];
  vi.stubGlobal("Image", class {
    naturalWidth = 1; naturalHeight = 1; src = "";
    onload = () => {}; onerror = () => {};
    constructor() { images.push(this); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

describe("provider icon operation ordering", () => {
  it("guards the entire read, decode and save against overlapping choices", async () => {
    let finishRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => { finishRefresh = resolve; });
    fixture.refreshInstances.mockReturnValueOnce(refresh);
    const ui = controls();
    ui.upload();
    ui.select(); ui.reset(); ui.upload();
    await vi.waitFor(() => expect(images).toHaveLength(1));
    expect(fixture.api).not.toHaveBeenCalled();
    images[0].onload();
    await vi.waitFor(() => expect(fixture.refreshInstances).toHaveBeenCalledOnce());
    ui.select(); ui.reset();
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(JSON.parse(fixture.api.mock.calls[0][1].body).icon.kind).toBe("custom");
    finishRefresh();
    await refresh;
    ui.select();
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fixture.api.mock.calls[1][1].body).icon).toEqual({ kind: "preset", preset: "google" });
  });

  it("unlocks after decode failure so a preset can still be saved", async () => {
    const ui = controls();
    ui.upload();
    await vi.waitFor(() => expect(images).toHaveLength(1));
    images[0].onerror();
    // Let the decode rejection propagate through file conversion and save.
    await vi.waitFor(() => {
      ui.select();
      expect(fixture.api).toHaveBeenCalledOnce();
    });
    expect(JSON.parse(fixture.api.mock.calls[0][1].body).icon.preset).toBe("google");
  });

  it("unlocks after a failed save so reset can be retried", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Save failed"));
    const ui = controls();
    ui.select();
    await vi.waitFor(() => {
      ui.reset();
      expect(fixture.api).toHaveBeenCalledTimes(2);
    });
    expect(JSON.parse(fixture.api.mock.calls[1][1].body).icon).toBeNull();
  });
});

it("uses the selected locale for visible labels and accessible names", () => {
  for (const { code } of localeChoices) {
    setLocale(code);
    const nodes = elements(ProviderIconPicker({ instance }));
    expect(nodes[0].props["aria-label"]).toBe(t("engines.icon.label"));
    expect(nodes.find((node) => node.type === "select")!.props["aria-label"]).toBe(t("engines.icon.selectAria", { name: "Work" }));
    expect(nodes.find((node) => node.type === "input")!.props["aria-label"]).toBe(t("engines.icon.uploadAria", { name: "Work" }));
    expect(nodes.find((node) => node.type === "p")!.props.children).toBe(t("engines.icon.help"));
    if (code !== "en") expect(nodes[0].props["aria-label"]).not.toBe("Provider icon");
  }
});
