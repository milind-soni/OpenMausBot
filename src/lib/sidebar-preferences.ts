export type SidebarDensity = "comfortable" | "compact" | "icons";

export const SIDEBAR_DENSITY_KEY = "openmausbot.sidebarDensity";

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

export const SIDEBAR_COLLAPSED_KEY = "openmausbot.sidebarCollapsedSections";
export const SIDEBAR_SECTION_ORDER_KEY = "openmausbot.sidebarSectionOrder";

function readStringList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split("\n").filter((value) => value.length > 0);
}

function writeStringList(key: string, values: string[], storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(key, values.join("\n"));
  } catch {
    /* same localStorage failure mode as density */
  }
}

export function loadCollapsedSections(storage?: Pick<Storage, "getItem"> | null): string[] {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return readStringList(target?.getItem(SIDEBAR_COLLAPSED_KEY) ?? null);
  } catch {
    return [];
  }
}

export function saveCollapsedSections(
  names: string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  writeStringList(SIDEBAR_COLLAPSED_KEY, [...new Set(names)], storage);
}

export function toggleCollapsedSection(names: string[], id: string): string[] {
  return names.includes(id) ? names.filter((name) => name !== id) : [...names, id];
}

export function loadSectionOrder(storage?: Pick<Storage, "getItem"> | null): string[] {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return readStringList(target?.getItem(SIDEBAR_SECTION_ORDER_KEY) ?? null);
  } catch {
    return [];
  }
}

export function saveSectionOrder(names: string[], storage?: Pick<Storage, "setItem"> | null): void {
  writeStringList(SIDEBAR_SECTION_ORDER_KEY, names, storage);
}
