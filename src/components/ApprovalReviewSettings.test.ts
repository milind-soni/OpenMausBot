import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { APPROVAL_REVIEW_RUBRIC } from "../../shared/approval-review-policy";
import { defaultApprovalReviewEffort } from "../../shared/approval-review";
import { effortLabel } from "./ModelPicker";
import { ApprovalReviewSettings } from "./ApprovalReviewSettings";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: {} as Pick<ConfigStatus, "approvalReview">,
  instances: [] as InstanceInfo[], api: vi.fn(), dispatch: vi.fn(),
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
vi.mock("@/state/store", () => ({ api: fixture.api,
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
  function Capture() { fixture.index = 0; tree = ApprovalReviewSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const byId = (id: string) => all.find((node) => node.props.id === id)!;
  return { html, all, engine: byId("approval-review-engine"), model: byId("approval-review-model"),
    effort: byId("approval-review-effort"), variant: byId("approval-review-variant"), instructions: byId("approval-review-instructions"),
    save: all.filter((node) => node.type === "button").at(-1)!, manage: all.find((node) => node.type === "button")! };
}
const click = (node: Node) => (node.props.onClick as () => void)();
const choose = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const request = () => JSON.parse(fixture.api.mock.calls[0][1].body);
beforeEach(() => {
  fixture.values = []; fixture.config = {};
  fixture.instances = [{ instanceId: "helper", driverKind: "fixture", displayName: "Isolated helper",
    snapshot: { state: "available", authenticated: true }, capabilities: { approvalReview: true, effortLevels: ["low", "high"] },
    models: { default: "m", options: [{ id: "m", label: "Registered model" }] } }];
  fixture.api.mockReset().mockResolvedValue({ approvalReview: {} });
  fixture.dispatch.mockReset().mockImplementation(({ config }: { config?: ConfigStatus }) => { if (config) fixture.config = config; });
});
describe("ApprovalReviewSettings", () => {
  it("offers and persists reasoning off for a helper-only API effort capability", async () => {
    fixture.instances[0].capabilities = { approvalReview: true, approvalReviewEffortLevels: ["none", "low", "medium", "high"] };
    choose(render().engine, "helper"); choose(render().model, "m");
    const options = nodes(render().effort.props.children).filter(node => node.type === "option").map(node => node.props.value);
    expect(options).toContain("none");
    choose(render().effort, "none"); click(render().save); await flush();
    const settings = request().approvalReview;
    expect(settings.model).toEqual({ instanceId: "helper", model: "m", effort: "none" });
    fixture.values = []; fixture.config = { approvalReview: settings };
    expect(render().effort.props.value).toBe("none");
  });

  it("saves and reloads an omitted reviewer effort with the advertised minimum default", async () => {
    choose(render().engine, "helper"); choose(render().model, "m");
    choose(render().effort, "high");
    choose(render().effort, "");
    const saved = { model: { instanceId: "helper", model: "m" }, instructions: "" };
    fixture.api.mockResolvedValue({ approvalReview: saved });
    click(render().save); await flush();
    expect(request().approvalReview).toEqual(saved);
    expect(fixture.config.approvalReview).toEqual(saved);
    fixture.values = [];
    const reloaded = render();
    expect(reloaded.effort.props.value).toBe("");
    const defaultOption = nodes(reloaded.effort.props.children).find(node => node.props.value === "");
    expect(defaultOption?.props.children).toBe(t("settings.approvalReview.defaultEffort", { effort: effortLabel(defaultApprovalReviewEffort(fixture.instances[0].capabilities!)!) }));
    choose(reloaded.engine, "");
    fixture.api.mockResolvedValue({ approvalReview: { instructions: "" } });
    click(render().save); await flush();
    expect(fixture.config.approvalReview).toEqual({ instructions: "" });
    expect(render().html).toContain(t("settings.approvalReview.sessionStatus"));
  });

  it("keeps unsupported saved effort visible and blocks saving until explicitly corrected", async () => {
    fixture.config = { approvalReview: { model: { instanceId: "helper", model: "m", effort: "none" } } };
    choose(render().instructions, "Keep the constraint");
    expect(render().effort.props.value).toBe("none");
    expect(render().save.props.disabled).toBe(true);
    expect(render().html).toContain(t("settings.approvalReview.unsupportedEffort"));
    choose(render().effort, "");
    expect(render().save.props.disabled).toBe(false);
    click(render().save); await flush();
    expect(request().approvalReview.model.effort).toBeUndefined();
  });
  it("shows the exact immutable model review rules in a collapsed disclosure beside editable additional constraints", async () => {
    const view = render();
    const disclosure = view.all.find((node) => node.type === "details")!;
    const contents = nodes(disclosure.props.children);
    const summary = contents.find((node) => node.type === "summary")!;
    const rubric = contents.find((node) => node.type === "pre")!;
    expect(disclosure.props.open).toBeFalsy();
    expect(summary.props.children).toBe(t("settings.approvalReview.builtInRules"));
    expect(rubric.props.children).toBe(APPROVAL_REVIEW_RUBRIC);
    expect(rubric.props.contentEditable).toBeUndefined();
    expect(contents.some((node) => node.type === "input" || node.type === "textarea")).toBe(false);
    expect(rubric.props["aria-describedby"]).toBe("approval-review-rubric-help");
    choose(view.instructions, "Ask before purchases.");
    const updated = render();
    expect(updated.all.find((node) => node.type === "pre")?.props.children).toBe(APPROVAL_REVIEW_RUBRIC);
    click(updated.save); await flush();
    expect(request()).toEqual({ approvalReview: { model: null, instructions: "Ask before purchases." } });
  });

  it("defaults to the session model and offers only available isolated helpers", () => {
    fixture.instances.push({ ...fixture.instances[0], instanceId: "no-helper", capabilities: {} } as InstanceInfo,
      { ...fixture.instances[0], instanceId: "offline", snapshot: { state: "unavailable" } } as InstanceInfo);
    const view = render();
    expect(view.engine.props.value).toBe(""); expect(view.save.props.disabled).toBe(true);
    const options = nodes(view.engine.props.children).filter((node) => node.type === "option").map((node) => node.props.value);
    expect(options).toEqual(["", "helper"]);
    expect(view.html).toContain(t("settings.approvalReview.hierarchy"));
    expect(view.html).toContain(t("settings.approvalReview.instructionsHelp"));
    click(view.manage); expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "engines" });
  });
  it("requires an explicit registered model and saves its native effort with additional instructions", async () => {
    choose(render().engine, "helper"); expect(render().save.props.disabled).toBe(true);
    choose(render().model, "m"); choose(render().effort, "high"); choose(render().instructions, "Ask before purchases.");
    click(render().save); await flush();
    expect(request()).toEqual({ approvalReview: { model: { instanceId: "helper", model: "m", effort: "high" }, instructions: "Ask before purchases." } });
    expect(fixture.api.mock.calls[0][0]).toBe("/api/config");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { approvalReview: {} } });
  });
  it("preserves exact variant settings when editing the rubric and explicitly clears the selection", async () => {
    const model = { instanceId: "helper", model: "m", variant: "deep" };
    fixture.config = { approvalReview: { model, instructions: "Old rule" } };
    fixture.instances[0].capabilities = { approvalReview: true, modelVariants: true };
    fixture.instances[0].models.options[0].variants = [{ id: "deep", label: "Deep" }];
    choose(render().instructions, "New rule"); click(render().save); await flush();
    expect(request()).toEqual({ approvalReview: { model, instructions: "New rule" } });
    fixture.api.mockClear(); fixture.config = { approvalReview: { model, instructions: "New rule" } };
    choose(render().engine, ""); click(render().save); await flush();
    expect(request()).toEqual({ approvalReview: { model: null, instructions: "New rule" } });
  });
  it("keeps unavailable selections visible until the user explicitly chooses another route", () => {
    fixture.config = { approvalReview: { model: { instanceId: "missing", model: "old", effort: "high" } } };
    const view = render(); expect(view.engine.props.value).toBe("missing");
    expect(view.model.props.value).toBe("old"); expect(view.effort.props.value).toBe("high");
    choose(view.instructions, "Keep this rule"); expect(render().save.props.disabled).toBe(true);
    choose(render().engine, ""); expect(render().save.props.disabled).toBe(false);
  });
  it("blocks duplicate saves and keeps failed drafts available for retry", async () => {
    let reject!: (error: Error) => void;
    fixture.api.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    choose(render().instructions, "Keep this rule"); const save = render().save; click(save); click(save);
    expect(fixture.api).toHaveBeenCalledTimes(1); expect(render().instructions.props.disabled).toBe(true);
    reject(new Error("Fixture rejection")); await flush();
    expect(render().instructions.props.value).toBe("Keep this rule"); expect(render().save.props.disabled).toBe(false);
    expect(render().html).toContain('role="alert"');
    fixture.api.mockResolvedValue({ approvalReview: { instructions: "Keep this rule" } }); click(render().save); await flush();
    expect(render().save.props.disabled).toBe(true);
  });
});
