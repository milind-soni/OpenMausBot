import { z } from "zod";

export type SidebarDensity = "comfortable" | "compact" | "icons";

export const SIDEBAR_DENSITY_KEY = "openmausbot.sidebarDensity";
export const SIDEBAR_COLLAPSED_SECTIONS_KEY = "openmausbot.sidebarCollapsedSections.v1";
export const SIDEBAR_SECTION_ORDER_KEY = "openmausbot.sidebarSectionOrder.v1";
export const SIDEBAR_BOT_ORDER_KEY = "openmausbot.sidebarBotOrder.v1";

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

const stringListSchema = z.array(z.string().min(1).max(240));

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = stringListSchema.safeParse(parsed);
    return result.success ? [...new Set(result.data)].slice(0, 100) : [];
  } catch {
    return [];
  }
}

function loadStringList(
  key: string,
  storage?: Pick<Storage, "getItem"> | null,
): string[] {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseStringList(target?.getItem(key) ?? null);
  } catch {
    return [];
  }
}

function saveStringList(
  key: string,
  values: string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const safe = [
      ...new Set(values.filter((value) => value.length > 0 && value.length <= 240)),
    ].slice(0, 100);
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

export function loadBotOrder(storage?: Pick<Storage, "getItem"> | null): string[] {
  return loadStringList(SIDEBAR_BOT_ORDER_KEY, storage);
}

export function saveBotOrder(
  ids: string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  saveStringList(SIDEBAR_BOT_ORDER_KEY, ids, storage);
}
