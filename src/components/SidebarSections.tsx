import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import type { DepartmentOrder } from "./bot-sections";
import { FOLDER_DRAG_TYPE } from "@/lib/folder-order";
import { t } from "@/lib/i18n";
import {
  departmentsIn,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  placeSection,
  sameSectionOrder,
  sidebarLayoutInteractive,
  sidebarSectionCollapsed,
  simpleOrderedSections,
  userSectionId,
  withDepartmentOrder,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import {
  loadCollapsedSections,
  loadSectionOrder,
  loadSimpleSectionOrder,
  saveCollapsedSections,
  saveSectionOrder,
  saveSimpleSectionOrder,
  toggleCollapsedSection,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";

const SECTION_DRAG_TYPE = "application/x-openmausbot-sidebar-section";

/** The sidebar's sections on this device: which are collapsed, their saved order, and dragging or Alt+Up/Down a
 * heading to reorder them. Simple and Advanced each keep their own order, so a move in one leaves the other as it was.
 * With `departments`, the departments among them follow the workspace's order, the same on every device, and a move
 * saves it there; the built-in sections keep this device's places. */
export function useSidebarSections({ simple, rail, density, query, label, sidebarRef, departments = null }: {
  simple: boolean;
  rail: boolean;
  density: SidebarDensity;
  query: string;
  label: (id: string) => string;
  sidebarRef: RefObject<HTMLElement | null>;
  departments?: DepartmentOrder | null;
}) {
  const [collapsedIds, setCollapsedIds] = useState<string[]>(() => loadCollapsedSections());
  const [savedOrder, setSavedOrder] = useState<string[]>(() => loadSectionOrder());
  const [simpleOrder, setSimpleOrder] = useState<string[]>(() => loadSimpleSectionOrder());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const drag = useRef<{ from: string | null; over: { id: string; place: SectionDropPlace } | null }>({ from: null, over: null });
  const interactive = sidebarLayoutInteractive(density, query);
  const ownOrder = simple || rail;
  const shared = (ids: string[]) => (departments ? withDepartmentOrder(ids, departments.order) : ids);

  // Once per start: the order this device shows (Simple's in Simple or the rail) is offered to the workspace, which
  // takes it only while nobody has set one, so the first device to update keeps its departments where they were.
  const offered = useRef(false);
  useEffect(() => {
    if (!departments || offered.current || departments.order.length < 2) return;
    offered.current = true;
    const advanced = orderedSidebarSections(departments.order.map(userSectionId), savedOrder);
    departments.offer(departmentsIn(ownOrder ? simpleOrderedSections(advanced, simpleOrder) : advanced));
  }, [departments, savedOrder, simpleOrder, ownOrder]);

  const focusHeader = (name: string) => requestAnimationFrame(() => {
    const header = [...(sidebarRef.current?.querySelectorAll<HTMLElement>("[data-section]") ?? [])].find((element) => element.dataset.section === name);
    (header?.querySelector<HTMLElement>("button") ?? header ?? sidebarRef.current)?.focus();
  });
  const resetDrag = () => {
    drag.current = { from: null, over: null };
    setDraggingId(null);
    setDropTarget(null);
  };

  return {
    interactive,
    announcement,
    announce: setAnnouncement,
    focusHeader,
    collapsed: (id: string) => sidebarSectionCollapsed(id, collapsedIds, density, query),
    toggle: (id: string) => {
      if (!interactive) return;
      const next = toggleCollapsedSection(collapsedIds, id);
      setCollapsedIds(next);
      saveCollapsedSections(next);
    },
    /** A department's new name keeps its place and its collapsed state. */
    renamed: (from: string, to: string) => {
      const replace = (ids: string[]) => [...new Set(ids.map((id) => (id === userSectionId(from) ? userSectionId(to) : id)))];
      setCollapsedIds((current) => { const next = replace(current); saveCollapsedSections(next); return next; });
      setSavedOrder((current) => { const next = replace(current); saveSectionOrder(next); return next; });
      setSimpleOrder((current) => { const next = replace(current); saveSimpleSectionOrder(next); return next; });
      focusHeader(to);
    },
    arrange(natural: string[]) {
      const orderedIds = shared(orderedSidebarSections(natural, savedOrder));
      const sectionIds = ownOrder ? shared(simpleOrderedSections(orderedIds, simpleOrder)) : orderedIds;
      const reorder = (id: string, next: string[]) => {
        if (sameSectionOrder(next, sectionIds)) return;
        const saved = ownOrder ? simpleOrder : savedOrder;
        const merged = mergeSectionOrder(saved, next);
        if (interactive && !sameSectionOrder(merged, saved)) {
          (ownOrder ? setSimpleOrder : setSavedOrder)(merged);
          (ownOrder ? saveSimpleSectionOrder : saveSectionOrder)(merged);
        }
        if (interactive && departments) void departments.save(departmentsIn(next).filter((name) => departments.order.includes(name)));
        const position = next.indexOf(id);
        if (position >= 0) setAnnouncement(t("sidebar.section.moved", { name: label(id), position: position + 1, count: next.length }));
      };
      return {
        sectionIds,
        header: (id: string) => ({
          reorderable: interactive && sectionIds.length > 1,
          dragging: draggingId === id,
          onDragStart: (event: DragEvent<HTMLElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(SECTION_DRAG_TYPE, id);
            event.dataTransfer.setData("text/plain", id);
            drag.current = { from: id, over: null };
            setDraggingId(id);
          },
          onDragEnd: resetDrag,
          onMove: (direction: -1 | 1) => reorder(id, moveSection(sectionIds, id, direction)),
        }),
        zone: (id: string) => ({
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!interactive || !drag.current.from) return;
            // A section outside the order being arranged has no place to give: it takes no drop and shows no line.
            if (!sectionIds.includes(id)) {
              drag.current.over = null;
              return setDropTarget(null);
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const over = { id, place: event.clientY < rect.top + rect.height / 2 ? "before" as const : "after" as const };
            drag.current.over = over;
            setDropTarget(over);
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
            event.preventDefault();
            const from = event.dataTransfer.getData(SECTION_DRAG_TYPE) || event.dataTransfer.getData("text/plain") || drag.current.from;
            const over = drag.current.over;
            if (from && over) reorder(from, placeSection(sectionIds, from, over.id, over.place));
            resetDrag();
          },
        }),
        dropLine: (id: string, place: SectionDropPlace) =>
          dropTarget?.id === id && dropTarget.place === place && draggingId !== id ? <div className="mx-2 h-0.5 rounded-full bg-accent" /> : null,
      };
    },
  };
}
