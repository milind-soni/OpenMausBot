import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { AutoEffortSettings } from "./AutoEffortSettings";
import { Select } from "../Select";
import { Switch } from "../SettingsPrimitives";
import { TurnEffortNote } from "../ConversationalReply";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture }) }));
const bot = (autoEffort?: Bot["autoEffort"]) => ({ modelSelection: { instanceId: "test", model: "limited" }, autoEffort }) as Bot;
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => Children.toArray(value).flatMap((child) => isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []);

beforeEach(() => {
  fixture.instances = [{ instanceId: "test", driverKind: "test", displayName: "Test", snapshot: { state: "available" }, capabilities: { effortLevels: ["low", "medium", "high", "max"] }, models: { default: "limited", options: [{ id: "limited", label: "Limited", effortLevels: ["low", "high"] }] } }];
});

it("shows only the selected model's supported levels and prevents reversed limits", () => {
  const all = nodes(AutoEffortSettings({ bot: bot({ max: "low" }), patch: vi.fn() }));
  const selects = all.filter((node) => node.type === Select);
  const options = nodes(selects[0].props.children).filter((node) => node.type === "option");
  expect(options.map((node) => node.props.value)).toEqual(["", "low", "high"]);
  expect(options.find((node) => node.props.value === "high")?.props.disabled).toBe(true);
});

it("saves automation separately and clears a bound without changing the other settings", () => {
  const patch = vi.fn();
  const all = nodes(AutoEffortSettings({ bot: bot({ min: "low", max: "high" }), patch }));
  all.find((node) => node.type === Switch)!.props.onClick();
  expect(patch).toHaveBeenLastCalledWith({ autoEffort: { min: "low", max: "high", automated: true } });
  all.find((node) => node.type === Select)!.props.onChange({ target: { value: "" } });
  expect(patch).toHaveBeenLastCalledWith({ autoEffort: { min: undefined, max: "high" } });
});

it("hides unsupported controls and shows a translated turn note only for an applied choice", () => {
  fixture.instances[0].models.options[0].effortLevels = [];
  expect(AutoEffortSettings({ bot: bot(), patch: vi.fn() })).toBeNull();
  expect(renderToStaticMarkup(createElement(TurnEffortNote, { effort: "high" }))).toContain('data-turn-effort="high"');
  expect(renderToStaticMarkup(createElement(TurnEffortNote, {}))).toBe("");
});
