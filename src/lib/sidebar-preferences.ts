import { z } from "zod";

export type SidebarDensity = "comfortable" | "compact" | "icons";

export const SIDEBAR_DENSITY_KEY = "openmausbot.sidebarDensity";
export const SIDEBAR_COLLAPSED_SECTIONS_KEY = "openmausbot.sidebarCollapsedSections.v1";
export const SIDEBAR_SECTION_ORDER_KEY = "openmausbot.sidebarSectionOrder.v1";

export function parseSidebarDensity(value: string | null): SidebarDensity {
  switch (value) {
    case "comfortable":
    case "compact":
    case "icons":
      return value;
    default:
      return "comfortable";
  }
}

export function loadSidebarDensity(storage?: Pick<Storage, "getItem"> | null): SidebarDensity {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarDensity(target?.getItem(SIDEBAR_DENSITY_KEY) ?? null);
  } catch {
    return "comfortable";
  }
}

export function saveSidebarDensity(
  density: SidebarDensity,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_DENSITY_KEY, density);
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // The in-memory React state still makes the control useful this session.
  }
}

/* The column width is dragged, and it is stored on its own: density decides
 * the shape of a row, the width decides how much room that row gets. Drag far
 * enough left and the sidebar becomes the avatar rail, which is the "icons"
 * density — the two ends stay in step, so the rail is reachable both from the
 * menu and from the handle. */
export const SIDEBAR_WIDTH_KEY = "openmausbot.sidebarWidth";
export const SIDEBAR_ROW_ORDER_KEY = "openmausbot.sidebarRowOrder.v1";

export const SIDEBAR_RAIL_WIDTH = 80;
/** Narrowest a sidebar with text can be before the preview stops being
 * readable. Between the rail and this there is nothing to land on. */
export const SIDEBAR_MIN_EXPANDED_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 320;
/** Drag left past this and the sidebar collapses to the rail. */
export const SIDEBAR_RAIL_SNAP_WIDTH = 180;

/** The input is a pointer position, so it is unbounded in both directions and
 * can be NaN when a drag starts before layout. The dead zone is deliberate:
 * a 140px sidebar shows a truncated word and nothing else. */
export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  if (value < SIDEBAR_RAIL_SNAP_WIDTH) return SIDEBAR_RAIL_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_EXPANDED_WIDTH, Math.round(value)));
}

export function sidebarIsRail(width: number): boolean {
  return width <= SIDEBAR_RAIL_WIDTH;
}

/** A build that only had the density menu saved no width. Map the mode it did
 * save so an upgrade does not silently reset everyone to the default. */
export function widthForDensity(density: SidebarDensity): number {
  if (density === "icons") return SIDEBAR_RAIL_WIDTH;
  return density === "compact" ? 272 : SIDEBAR_DEFAULT_WIDTH;
}

export function loadSidebarWidth(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const stored = Number(target?.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampSidebarWidth(stored);
    return widthForDensity(parseSidebarDensity(target?.getItem(SIDEBAR_DENSITY_KEY) ?? null));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function saveSidebarWidth(width: number, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // The in-memory React state still makes the drag useful this session.
  }
}

const stringListSchema = z.array(z.string().min(1).max(240));

function parseStringList(raw: string | null, limit = 100): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = stringListSchema.safeParse(parsed);
    return result.success ? [...new Set(result.data)].slice(0, limit) : [];
  } catch {
    return [];
  }
}

function loadStringList(
  key: string,
  storage?: Pick<Storage, "getItem"> | null,
  limit = 100,
): string[] {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseStringList(target?.getItem(key) ?? null, limit);
  } catch {
    return [];
  }
}

function saveStringList(
  key: string,
  values: string[],
  storage?: Pick<Storage, "setItem"> | null,
  limit = 100,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const safe = [
      ...new Set(values.filter((value) => value.length > 0 && value.length <= 240)),
    ].slice(0, limit);
    target?.setItem(key, JSON.stringify(safe));
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // In-memory React state still keeps the interaction useful this session.
  }
}

export function loadCollapsedSections(storage?: Pick<Storage, "getItem"> | null): string[] {
  return loadStringList(SIDEBAR_COLLAPSED_SECTIONS_KEY, storage);
}

export function saveCollapsedSections(
  ids: string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  saveStringList(SIDEBAR_COLLAPSED_SECTIONS_KEY, ids, storage);
}

export function toggleCollapsedSection(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}

export function loadSectionOrder(storage?: Pick<Storage, "getItem"> | null): string[] {
  return loadStringList(SIDEBAR_SECTION_ORDER_KEY, storage);
}

export function saveSectionOrder(
  ids: string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  saveStringList(SIDEBAR_SECTION_ORDER_KEY, ids, storage);
}

/** A roster is not a handful of section names, so the saved row order gets a
 * ceiling of its own. Rows past it keep their natural position rather than
 * being dropped from the list. */
const ROW_ORDER_LIMIT = 500;

export function loadRowOrder(storage?: Pick<Storage, "getItem"> | null): string[] {
  return loadStringList(SIDEBAR_ROW_ORDER_KEY, storage, ROW_ORDER_LIMIT);
}

export function saveRowOrder(ids: string[], storage?: Pick<Storage, "setItem"> | null): void {
  saveStringList(SIDEBAR_ROW_ORDER_KEY, ids, storage, ROW_ORDER_LIMIT);
}
