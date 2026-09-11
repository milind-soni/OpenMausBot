export interface StudioPreferences { presentation: "map" | "studio"; room: string; calm: boolean }
const defaults: StudioPreferences = { presentation: "map", room: "", calm: false };
export function readStudioPreferences(workspaceId: string, storage: Pick<Storage, "getItem"> | undefined): StudioPreferences {
  try {
    const value = JSON.parse(storage?.getItem(`omb-studio:${workspaceId}`) ?? "null");
    return { presentation: value?.presentation === "studio" ? "studio" : "map", room: typeof value?.room === "string" ? value.room.slice(0, 200) : "", calm: value?.calm === true };
  } catch { return { ...defaults }; }
}
export function saveStudioPreferences(workspaceId: string, preferences: StudioPreferences, storage: Pick<Storage, "setItem"> | undefined): void {
  try { storage?.setItem(`omb-studio:${workspaceId}`, JSON.stringify(preferences)); } catch { /* Preferences must not break navigation. */ }
}
