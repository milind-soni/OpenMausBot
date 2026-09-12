export type StudioLamps = "auto" | "on" | "off";
export interface StudioPreferences { presentation: "map" | "studio"; room: string; calm: boolean; lamps: StudioLamps }
const defaults: StudioPreferences = { presentation: "map", room: "", calm: false, lamps: "auto" };
const isLamps = (value: unknown): value is StudioLamps => value === "auto" || value === "on" || value === "off";
/** Restore validated workspace preferences, falling back when storage is unavailable. */
export function readStudioPreferences(workspaceId: string, storage: Pick<Storage, "getItem"> | undefined): StudioPreferences {
  try {
    const value = JSON.parse(storage?.getItem(`omb-studio:${workspaceId}`) ?? "null");
    return { presentation: value?.presentation === "studio" ? "studio" : "map", room: typeof value?.room === "string" ? value.room.slice(0, 200) : "", calm: value?.calm === true, lamps: isLamps(value?.lamps) ? value.lamps : "auto" };
  } catch { return { ...defaults }; }
}
/** Persist workspace preferences without letting storage failures block navigation. */
export function saveStudioPreferences(workspaceId: string, preferences: StudioPreferences, storage: Pick<Storage, "setItem"> | undefined): void {
  try { storage?.setItem(`omb-studio:${workspaceId}`, JSON.stringify(preferences)); } catch { /* Preferences must not break navigation. */ }
}
