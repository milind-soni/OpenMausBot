// @vitest-environment happy-dom
import { createElement, createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOTS_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { SIDEBAR_SECTION_ORDER_KEY } from "@/lib/sidebar-preferences";
import { useSidebarSections } from "./SidebarSections";
import type { DepartmentOrder } from "./bot-sections";

const [sales, ops] = [userSectionId("Sales"), userSectionId("Ops")];
let root: Root;
let shown: ReturnType<ReturnType<typeof useSidebarSections>["arrange"]>;

function Probe({ departments, simple = false }: { departments: DepartmentOrder | null; simple?: boolean }) {
  const sections = useSidebarSections({ simple, rail: false, density: "comfortable", query: "", label: (id) => id, sidebarRef: createRef(), departments });
  shown = sections.arrange([BOTS_SECTION_ID, sales, ops]);
  return null;
}

const render = (departments: DepartmentOrder | null, simple = false) => flushSync(() => root.render(createElement(Probe, { departments, simple })));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  // This device had put Ops first, with the bots between the two departments.
  localStorage.setItem(SIDEBAR_SECTION_ORDER_KEY, JSON.stringify([ops, BOTS_SECTION_ID, sales]));
  root = createRoot(document.createElement("div"));
});
afterEach(() => root.unmount());

describe("the sidebar's departments", () => {
  it("follow the workspace's order, the same on every device, while the built-in sections keep this device's places", () => {
    render({ order: ["Sales", "Ops"], save: vi.fn(async () => true), offer: vi.fn() });
    expect(shown.sectionIds).toEqual([sales, BOTS_SECTION_ID, ops]);
  });

  it("save a move for every device", () => {
    const save = vi.fn(async () => true);
    render({ order: ["Sales", "Ops"], save, offer: vi.fn() });
    // Up past the bots, then past Sales.
    flushSync(() => shown.header(ops).onMove(-1));
    expect(shown.sectionIds).toEqual([sales, ops, BOTS_SECTION_ID]);
    flushSync(() => shown.header(ops).onMove(-1));
    expect(save).toHaveBeenLastCalledWith(["Ops", "Sales"]);
  });

  it("offer this device's order to the workspace once, so the first device to update keeps its departments where they were", async () => {
    const save = vi.fn(async () => true);
    const offer = vi.fn();
    render({ order: ["Sales", "Ops"], save, offer });
    await settle();
    render({ order: ["Sales", "Ops"], save, offer });
    await settle();
    expect(offer).toHaveBeenCalledTimes(1);
    expect(offer).toHaveBeenCalledWith(["Ops", "Sales"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("follow the workspace's order in Simple too, and a Simple move saves it for every device", () => {
    const save = vi.fn(async () => true);
    render({ order: ["Sales", "Ops"], save, offer: vi.fn() }, true);
    expect(shown.sectionIds.filter((id) => id !== BOTS_SECTION_ID)).toEqual([sales, ops]);
    flushSync(() => shown.header(ops).onMove(-1));
    expect(save).toHaveBeenLastCalledWith(["Ops", "Sales"]);
  });

  it("stay in this device's order for a person who may not change the workspace's", () => {
    render(null);
    expect(shown.sectionIds).toEqual([ops, BOTS_SECTION_ID, sales]);
  });
});
