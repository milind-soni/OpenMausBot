const DEFAULT_BOUNDS = Object.freeze({ width: 1100, height: 780 });
const MIN_BOUNDS = Object.freeze({ width: 840, height: 620 });

const integer = (value) => Number.isFinite(value) && Number.isInteger(value);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function parseWindowState(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !value.bounds || typeof value.bounds !== "object") return null;
  const { x, y, width, height } = value.bounds;
  if (![x, y, width, height].every(integer) || width <= 0 || height <= 0) return null;
  return {
    bounds: { x, y, width, height },
    maximized: value.maximized === true,
  };
}

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function validWorkAreas(workAreas) {
  return workAreas.filter(
    (area) =>
      area &&
      [area.x, area.y, area.width, area.height].every(integer) &&
      area.width > 0 &&
      area.height > 0,
  );
}

/** Keep restored windows reachable after monitor, resolution, or DPI changes.
 * workAreas must put the primary display first. */
function resolveWindowState(state, workAreas, defaults = DEFAULT_BOUNDS) {
  const areas = validWorkAreas(workAreas);
  const primary = areas[0];
  const defaultBounds = {
    width: primary ? Math.min(defaults.width, primary.width) : defaults.width,
    height: primary ? Math.min(defaults.height, primary.height) : defaults.height,
  };
  const parsed = parseWindowState(state);
  if (!parsed || !primary) return { bounds: defaultBounds, maximized: false };

  let target = primary;
  let bestArea = 0;
  for (const area of areas) {
    const overlap = intersectionArea(parsed.bounds, area);
    if (overlap > bestArea) {
      bestArea = overlap;
      target = area;
    }
  }

  const minWidth = Math.min(MIN_BOUNDS.width, target.width);
  const minHeight = Math.min(MIN_BOUNDS.height, target.height);
  const width = clamp(parsed.bounds.width, minWidth, target.width);
  const height = clamp(parsed.bounds.height, minHeight, target.height);
  if (bestArea === 0) {
    return {
      bounds: {
        x: target.x + Math.round((target.width - width) / 2),
        y: target.y + Math.round((target.height - height) / 2),
        width,
        height,
      },
      maximized: parsed.maximized,
    };
  }
  return {
    bounds: {
      x: clamp(parsed.bounds.x, target.x, target.x + target.width - width),
      y: clamp(parsed.bounds.y, target.y, target.y + target.height - height),
      width,
      height,
    },
    maximized: parsed.maximized,
  };
}

function normalizeUnreadCount(value) {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.trunc(value), 0, 999);
}

module.exports = {
  DEFAULT_BOUNDS,
  MIN_BOUNDS,
  normalizeUnreadCount,
  parseWindowState,
  resolveWindowState,
};
