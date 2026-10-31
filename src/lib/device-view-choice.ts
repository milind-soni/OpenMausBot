import type { DeviceView } from "../../shared/device-view";

export type DeviceAccess = "admin" | "client" | "limited";

export interface DeviceViewTargets {
  sections: string[];
  bots: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
  /** Every bot and room the server still accepts in a view, archived bots and direct rooms included: more than the switches offer. */
  existing: { bots: Array<{ id: string; name: string }>; groups: Array<{ id: string; name: string }> };
}

export const NO_TARGETS: DeviceViewTargets = { sections: [], bots: [], groups: [], existing: { bots: [], groups: [] } };
export const EMPTY_VIEW: DeviceView = { sections: [], bots: [], groups: [] };

export function viewTargetsFrom(body: unknown): DeviceViewTargets {
  const record = Object(body) as { sections?: unknown; bots?: unknown; groups?: unknown };
  const named = (value: unknown) => {
    const item = Object(value) as { id?: unknown; name?: unknown };
    return typeof item.id === "string" && typeof item.name === "string" ? { id: item.id, name: item.name } : null;
  };
  const sections = Array.isArray(record.sections) ? record.sections.filter((section): section is string => typeof section === "string") : [];
  const every = (list: unknown) => Array.isArray(list) ? list.map((item) => ({ item, named: named(item) })).filter((entry) => entry.named !== null) : [];
  const bots = every(record.bots);
  const groups = every(record.groups);
  return {
    sections: sections.some((section) => section.trim() === "") ? sections : ["", ...sections],
    bots: bots.filter(({ item }) => !Object(item).hidden).map((entry) => entry.named!),
    groups: groups.filter(({ item }) => !Object(item).dm).map((entry) => entry.named!),
    existing: { bots: bots.map((entry) => entry.named!), groups: groups.map((entry) => entry.named!) },
  };
}

export function togglePicked(view: DeviceView, kind: keyof DeviceView, id: string): DeviceView {
  const list = view[kind];
  return { ...view, [kind]: list.includes(id) ? list.filter((item) => item !== id) : [...list, id] };
}

/** The server refuses a target that no longer exists, and the picker shows no switch to turn it off. */
export function knownTargets(view: DeviceView, targets: DeviceViewTargets): DeviceView {
  return {
    sections: view.sections.filter((section) => section === "" || targets.sections.includes(section)),
    bots: view.bots.filter((id) => targets.existing.bots.some((bot) => bot.id === id)),
    groups: view.groups.filter((id) => targets.existing.groups.some((group) => group.id === id)),
  };
}

/** A paired device's view after one switch flips; every switch off leaves it seeing nothing. */
export function flipTarget(view: DeviceView, kind: keyof DeviceView, id: string, targets: DeviceViewTargets): DeviceView {
  return knownTargets(togglePicked(view, kind, id), targets);
}

export function pickedCount(view: DeviceView): number {
  return view.sections.length + view.bots.length + view.groups.length;
}

export function pairingBody(access: DeviceAccess, picked: DeviceView): { scopes: string[]; view?: DeviceView } {
  if (access === "limited") return { scopes: ["client"], view: picked };
  return { scopes: access === "admin" ? ["admin", "client"] : ["client"] };
}

/** The names of what a view still names; a deleted target drops out. */
export function viewNames(view: DeviceView, targets: DeviceViewTargets, general: string): string[] {
  const known = knownTargets(view, targets);
  return [
    ...known.sections.map((section) => section || general),
    ...known.bots.map((id) => targets.existing.bots.find((bot) => bot.id === id)!.name),
    ...known.groups.map((id) => targets.existing.groups.find((group) => group.id === id)!.name),
  ];
}
