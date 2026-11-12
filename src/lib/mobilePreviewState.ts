import {
  DEFAULT_CANVAS_SIZE_IDS,
  DEFAULT_CUSTOM_DIMENSIONS,
  DEFAULT_PREVIEW_SIZE_ID,
  type CanvasViewTransform,
  type PreviewZoomMode,
} from "./previewSizes";
import type { PreviewSource } from "./mobilePreviewUrl";

const STORAGE_KEY = "mobile-preview-last-state";
const STUDIO_STORAGE_KEY = "gbs-preview-studio-state-v1";

export interface MobilePreviewPersistedState {
  input: string;
  presetId: string;
  rotated?: boolean;
  zoom?: PreviewZoomMode;
  customSize?: { width: number; height: number };
  source?: PreviewSource | null;
}

export interface PreviewStudioPersistedState {
  input: string;
  source: PreviewSource | null;
  presetId: string;
  rotated: boolean;
  zoom: PreviewZoomMode;
  customSize: { width: number; height: number };
  autoRefresh: boolean;
  mode: "single" | "canvas";
  selectedSizeIds: string[];
  rotatedById: Record<string, boolean>;
  canvasTransform: CanvasViewTransform | null;
  scrollSync: boolean;
}

export const DEFAULT_PREVIEW_STUDIO_STATE: PreviewStudioPersistedState = {
  input: "",
  source: null,
  presetId: DEFAULT_PREVIEW_SIZE_ID,
  rotated: false,
  zoom: "fit",
  customSize: { ...DEFAULT_CUSTOM_DIMENSIONS },
  autoRefresh: true,
  mode: "single",
  selectedSizeIds: [...DEFAULT_CANVAS_SIZE_IDS],
  rotatedById: {},
  canvasTransform: null,
  scrollSync: false,
};

function normalizeZoom(value: unknown): PreviewZoomMode {
  if (value === "fit" || value === "50" || value === "75" || value === "100") {
    return value;
  }
  return "fit";
}

export function loadMobilePreviewState(): MobilePreviewPersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { input: "", presetId: DEFAULT_PREVIEW_SIZE_ID, rotated: false, zoom: "fit" };
    }
    const parsed = JSON.parse(raw);
    return {
      input: typeof parsed?.input === "string" ? parsed.input : "",
      presetId:
        typeof parsed?.presetId === "string" && parsed.presetId
          ? parsed.presetId
          : DEFAULT_PREVIEW_SIZE_ID,
      rotated: Boolean(parsed?.rotated),
      zoom: normalizeZoom(parsed?.zoom),
      customSize:
        parsed?.customSize &&
        typeof parsed.customSize.width === "number" &&
        typeof parsed.customSize.height === "number"
          ? { width: parsed.customSize.width, height: parsed.customSize.height }
          : { ...DEFAULT_CUSTOM_DIMENSIONS },
      source: parsed?.source ?? null,
    };
  } catch {
    return { input: "", presetId: DEFAULT_PREVIEW_SIZE_ID, rotated: false, zoom: "fit" };
  }
}

export function saveMobilePreviewState(state: MobilePreviewPersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadPreviewStudioState(): PreviewStudioPersistedState {
  try {
    const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
    if (!raw) {
      const legacy = loadMobilePreviewState();
      return {
        ...DEFAULT_PREVIEW_STUDIO_STATE,
        input: legacy.input,
        presetId: legacy.presetId,
        rotated: Boolean(legacy.rotated),
        zoom: legacy.zoom ?? "fit",
        customSize: legacy.customSize ?? { ...DEFAULT_CUSTOM_DIMENSIONS },
        source: legacy.source ?? null,
      };
    }
    const parsed = JSON.parse(raw);
    const selectedSizeIds = Array.isArray(parsed?.selectedSizeIds)
      ? parsed.selectedSizeIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      : [...DEFAULT_CANVAS_SIZE_IDS];

    return {
      input: typeof parsed?.input === "string" ? parsed.input : "",
      source: parsed?.source ?? null,
      presetId:
        typeof parsed?.presetId === "string" && parsed.presetId
          ? parsed.presetId
          : DEFAULT_PREVIEW_SIZE_ID,
      rotated: Boolean(parsed?.rotated),
      zoom: normalizeZoom(parsed?.zoom),
      customSize:
        parsed?.customSize &&
        typeof parsed.customSize.width === "number" &&
        typeof parsed.customSize.height === "number"
          ? { width: parsed.customSize.width, height: parsed.customSize.height }
          : { ...DEFAULT_CUSTOM_DIMENSIONS },
      autoRefresh: parsed?.autoRefresh !== false,
      mode: parsed?.mode === "canvas" ? "canvas" : "single",
      selectedSizeIds: selectedSizeIds.length > 0 ? selectedSizeIds : [...DEFAULT_CANVAS_SIZE_IDS],
      rotatedById:
        parsed?.rotatedById && typeof parsed.rotatedById === "object" ? parsed.rotatedById : {},
      canvasTransform:
        parsed?.canvasTransform &&
        typeof parsed.canvasTransform.x === "number" &&
        typeof parsed.canvasTransform.y === "number" &&
        typeof parsed.canvasTransform.k === "number"
          ? parsed.canvasTransform
          : null,
      scrollSync: Boolean(parsed?.scrollSync),
    };
  } catch {
    return { ...DEFAULT_PREVIEW_STUDIO_STATE };
  }
}

export function savePreviewStudioState(patch: Partial<PreviewStudioPersistedState>): PreviewStudioPersistedState {
  const next: PreviewStudioPersistedState = {
    ...loadPreviewStudioState(),
    ...patch,
  };
  try {
    localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota errors
  }
  return next;
}
