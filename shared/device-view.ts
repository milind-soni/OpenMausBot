// What a paired device is limited to. Set by an admin when pairing, or later on
// the device's row; a device with a view is never an admin.

/** Departments (`sections`, "" is General), bots and group chats the device sees: their union.
 * Absent: everything the device's scopes allow. Every list empty: nothing. */
export type DeviceView = { sections: string[]; bots: string[]; groups: string[] };

const ID = /^[\w-]{1,128}$/;
const MAX_SECTION = 80;
const MAX_TARGETS = 50;

/** Nothing named: what an unreadable stored view becomes, so damage never widens a device's reach. */
export const SEES_NOTHING: DeviceView = { sections: [], bots: [], groups: [] };

/** One target (`{ section }`, `{ bot }`, `{ group }`) or several (`{ sections?, bots?, groups? }`). */
function readTargets(value: unknown): DeviceView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && (keys[0] === "section" || keys[0] === "bot" || keys[0] === "group")) {
    const plural = { section: "sections", bot: "bots", group: "groups" }[keys[0]] as keyof DeviceView;
    return readTargets({ [plural]: [record[keys[0]]] });
  }
  if (keys.some((key) => key !== "sections" && key !== "bots" && key !== "groups")) return null;
  const list = (key: keyof DeviceView, valid: (item: string) => boolean, clean: (item: string) => string = (item) => item) => {
    const raw = key in record ? record[key] : [];
    if (!Array.isArray(raw) || raw.length > MAX_TARGETS) return null;
    if (!raw.every((item): item is string => typeof item === "string" && valid(clean(item)))) return null;
    return [...new Set(raw.map(clean))];
  };
  const sections = list("sections", (section) => section.length <= MAX_SECTION, (section) => section.trim());
  const bots = list("bots", (id) => ID.test(id));
  const groups = list("groups", (id) => ID.test(id));
  return sections && bots && groups ? { sections, bots, groups } : null;
}

/** `allowNothing`: every list may be empty, for a paired device an admin pauses; a new pairing must name something. */
export function parseDeviceView(value: unknown, { allowNothing = false } = {}): { ok: true; view: DeviceView | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, view: null };
  const view = readTargets(value);
  const named = Boolean(view && (view.sections.length || view.bots.length || view.groups.length));
  if (view && (named || (allowNothing && Object.keys(value as object).length))) return { ok: true, view };
  return { ok: false, error: 'view must be null or { "sections": [names], "bots": [ids], "groups": [ids] } naming at least one, at most 50 per list' };
}

export function storedDeviceView(value: unknown): DeviceView | undefined {
  if (value === undefined) return undefined;
  return readTargets(value) ?? SEES_NOTHING;
}
