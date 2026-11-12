export type PreviewSizeGroup = "phone" | "tablet" | "laptop" | "desktop" | "custom";

export type PreviewZoomMode = "fit" | "50" | "75" | "100";

export interface PreviewSizePreset {
  id: string;
  label: string;
  group: PreviewSizeGroup;
  width: number;
  height: number;
  dpr: number;
  rotatable: boolean;
  defaultInCanvas: boolean;
}

export type MobileDevicePreset = PreviewSizePreset;

export const MIN_CUSTOM_DIMENSION = 240;
export const MAX_CUSTOM_DIMENSION = 3840;
export const DEFAULT_CUSTOM_DIMENSIONS = { width: 1024, height: 768 } as const;

export const PREVIEW_SIZE_PRESETS: PreviewSizePreset[] = [
  // Phone
  {
    id: "iphone-se",
    label: "iPhone SE",
    group: "phone",
    width: 375,
    height: 667,
    dpr: 2,
    rotatable: true,
    defaultInCanvas: false,
  },
  {
    id: "iphone-16",
    label: "iPhone 15 / 16",
    group: "phone",
    width: 393,
    height: 852,
    dpr: 3,
    rotatable: true,
    defaultInCanvas: true,
  },
  {
    id: "pixel",
    label: "Pixel",
    group: "phone",
    width: 412,
    height: 915,
    dpr: 2.6,
    rotatable: true,
    defaultInCanvas: false,
  },
  // Tablet
  {
    id: "ipad-mini",
    label: "iPad mini",
    group: "tablet",
    width: 744,
    height: 1133,
    dpr: 2,
    rotatable: true,
    defaultInCanvas: true,
  },
  {
    id: "ipad-pro-11",
    label: 'iPad Pro 11"',
    group: "tablet",
    width: 834,
    height: 1194,
    dpr: 2,
    rotatable: true,
    defaultInCanvas: false,
  },
  // Laptop
  {
    id: "laptop-1280",
    label: "Laptop",
    group: "laptop",
    width: 1280,
    height: 800,
    dpr: 2,
    rotatable: true,
    defaultInCanvas: true,
  },
  // Desktop
  {
    id: "desktop-1440",
    label: "Desktop",
    group: "desktop",
    width: 1440,
    height: 900,
    dpr: 2,
    rotatable: true,
    defaultInCanvas: true,
  },
  {
    id: "desktop-1920",
    label: "Wide Desktop",
    group: "desktop",
    width: 1920,
    height: 1080,
    dpr: 2,
    rotatable: true,
    defaultInCanvas: false,
  },
];

export const PREVIEW_SIZE_GROUPS: Array<{
  group: Exclude<PreviewSizeGroup, "custom">;
  label: string;
  presets: PreviewSizePreset[];
}> = [
  { group: "phone", label: "Phone", presets: PREVIEW_SIZE_PRESETS.filter((p) => p.group === "phone") },
  { group: "tablet", label: "Tablet", presets: PREVIEW_SIZE_PRESETS.filter((p) => p.group === "tablet") },
  { group: "laptop", label: "Laptop", presets: PREVIEW_SIZE_PRESETS.filter((p) => p.group === "laptop") },
  { group: "desktop", label: "Desktop", presets: PREVIEW_SIZE_PRESETS.filter((p) => p.group === "desktop") },
];

export const DEFAULT_PREVIEW_SIZE_ID = "iphone-16";
export const DEFAULT_CANVAS_SIZE_IDS = PREVIEW_SIZE_PRESETS.filter((p) => p.defaultInCanvas).map((p) => p.id);

// Legacy exports kept for backward compatibility with existing imports.
export const MOBILE_DEVICE_PRESETS: MobileDevicePreset[] = [
  PREVIEW_SIZE_PRESETS[0],
  { ...PREVIEW_SIZE_PRESETS[1], id: "iphone-14-pro", label: "iPhone 14 Pro" },
  { ...PREVIEW_SIZE_PRESETS[2], id: "pixel-7", label: "Pixel 7" },
];
export const DEFAULT_MOBILE_DEVICE_PRESET_ID = MOBILE_DEVICE_PRESETS[0].id;

const LEGACY_ID_MAP: Record<string, string> = {
  "iphone-14-pro": "iphone-16",
  "pixel-7": "pixel",
};

export function clampCustomDimension(value: number, fallback: number = DEFAULT_CUSTOM_DIMENSIONS.width): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_CUSTOM_DIMENSION, Math.max(MIN_CUSTOM_DIMENSION, Math.round(value)));
}

export function clampCustomSize(
  size?: { width?: number; height?: number } | null,
): { width: number; height: number } {
  return {
    width: clampCustomDimension(Number(size?.width), DEFAULT_CUSTOM_DIMENSIONS.width),
    height: clampCustomDimension(Number(size?.height), DEFAULT_CUSTOM_DIMENSIONS.height),
  };
}

export function resolvePreviewSize(
  id: string,
  customSize?: { width?: number; height?: number } | null,
): PreviewSizePreset {
  if (id === "custom") {
    const clamped = clampCustomSize(customSize);
    return {
      id: "custom",
      label: "Custom size",
      group: "custom",
      width: clamped.width,
      height: clamped.height,
      dpr: 2,
      rotatable: true,
      defaultInCanvas: false,
    };
  }
  const normalizedId = LEGACY_ID_MAP[id] ?? id;
  return (
    PREVIEW_SIZE_PRESETS.find((preset) => preset.id === normalizedId) ??
    PREVIEW_SIZE_PRESETS.find((preset) => preset.id === DEFAULT_PREVIEW_SIZE_ID) ??
    PREVIEW_SIZE_PRESETS[0]
  );
}

export function applyRotation(
  dimensions: { width: number; height: number },
  rotated: boolean,
): { width: number; height: number } {
  if (!rotated) return { width: dimensions.width, height: dimensions.height };
  return { width: dimensions.height, height: dimensions.width };
}

export function computeFrameScale(
  frame: { width: number; height: number },
  stage: { width: number; height: number },
  zoom: PreviewZoomMode = "fit",
  padding = 16,
): number {
  if (zoom === "50") return 0.5;
  if (zoom === "75") return 0.75;
  if (zoom === "100") return 1;
  const availableWidth = Math.max(1, stage.width - padding * 2);
  const availableHeight = Math.max(1, stage.height - padding * 2);
  const fit = Math.min(1, availableWidth / Math.max(1, frame.width), availableHeight / Math.max(1, frame.height));
  return Number.isFinite(fit) && fit > 0 ? fit : 1;
}

// ── Canvas board math (ported from #gerer-wavez CanvasBoard.tsx) ──────

export const CANVAS_ARTBOARD_GAP = 120;
export const CANVAS_HEADER_SPACE = 48;
export const CANVAS_FIT_PADDING = 48;
export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 4;
export const MAX_LIVE_CANVAS_FRAMES = 6;

export interface CanvasViewTransform {
  x: number;
  y: number;
  k: number;
}

export interface CanvasArtboardBox {
  id: string;
  preset: PreviewSizePreset;
  left: number;
  width: number;
  height: number;
  rotated: boolean;
}

export function clampCanvasZoom(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, k));
}

export function layoutCanvasArtboards(
  sizeIds: string[],
  options?: {
    rotatedById?: Record<string, boolean>;
    customSize?: { width?: number; height?: number } | null;
    gap?: number;
  },
): {
  artboards: CanvasArtboardBox[];
  boardWidth: number;
  boardHeight: number;
} {
  const gap = options?.gap ?? CANVAS_ARTBOARD_GAP;
  const uniqueIds = Array.from(new Set(sizeIds.length > 0 ? sizeIds : DEFAULT_CANVAS_SIZE_IDS));
  let left = 0;
  let maxHeight = 0;
  const artboards: CanvasArtboardBox[] = [];

  for (const id of uniqueIds) {
    const preset = resolvePreviewSize(id, options?.customSize);
    const rotated = Boolean(options?.rotatedById?.[preset.id] || options?.rotatedById?.[id]);
    const dims = applyRotation(preset, rotated);
    artboards.push({
      id: preset.id,
      preset,
      left,
      width: dims.width,
      height: dims.height,
      rotated,
    });
    left += dims.width + gap;
    if (dims.height > maxHeight) maxHeight = dims.height;
  }

  const boardWidth = artboards.length > 0 ? left - gap : 0;
  const boardHeight = artboards.length > 0 ? maxHeight + CANVAS_HEADER_SPACE : 0;
  return { artboards, boardWidth, boardHeight };
}

export function computeCanvasFit(
  viewport: { width: number; height: number },
  board: { width: number; height: number },
  padding = CANVAS_FIT_PADDING,
): CanvasViewTransform {
  if (board.width <= 0 || board.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, k: 0.5 };
  }
  const usableW = Math.max(1, viewport.width - padding * 2);
  const usableH = Math.max(1, viewport.height - padding * 2);
  const k = clampCanvasZoom(Math.min(usableW / board.width, usableH / board.height));
  return {
    k,
    x: (viewport.width - board.width * k) / 2,
    y: (viewport.height - board.height * k) / 2,
  };
}

export function computeCanvasZoomAt(
  current: CanvasViewTransform,
  factor: number,
  anchor: { x: number; y: number },
): CanvasViewTransform {
  const k = clampCanvasZoom(current.k * factor);
  return {
    k,
    x: anchor.x - ((anchor.x - current.x) * k) / current.k,
    y: anchor.y - ((anchor.y - current.y) * k) / current.k,
  };
}

/**
 * Enforces the performance cap of at most `maxLive` (default 6) live frames.
 * Recently hovered/clicked artboard IDs in `promotedIds` (most recent first)
 * take priority; remaining slots are filled in board order.
 */
export function resolveLiveArtboardIds(
  artboardIds: string[],
  promotedIds: string[] = [],
  maxLive = MAX_LIVE_CANVAS_FRAMES,
): Set<string> {
  const cap = Math.max(1, maxLive);
  if (artboardIds.length <= cap) return new Set(artboardIds);

  const valid = new Set(artboardIds);
  const live = new Set<string>();

  for (const id of promotedIds) {
    if (valid.has(id)) {
      live.add(id);
      if (live.size >= cap) return live;
    }
  }
  for (const id of artboardIds) {
    if (!live.has(id)) {
      live.add(id);
      if (live.size >= cap) break;
    }
  }
  return live;
}
