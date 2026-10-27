import { profilePatch, type WelcomeFields } from "@/lib/welcome-draft";
import { api, type useStore } from "@/state/store";

type Dispatch = ReturnType<typeof useStore>["dispatch"];

/** The name as the welcome last saved it (or is saving it), shared by its greeting and its finish so it is sent once,
 * however the welcome ends. `pending` is a save still on its way. */
export interface SavedProfile {
  current: { name?: string } | undefined;
  pending?: Promise<unknown>;
}

/** Saves the name the welcome's greeting typed (profilePatch) to this computer's profile. Nothing here ties analytics
 * to anyone: the email is asked once, by the product-updates question. */
export async function saveWelcomeProfile(fields: WelcomeFields, saved: SavedProfile, dispatch: Dispatch): Promise<void> {
  const patch = profilePatch(fields, saved.current);
  if (!patch) return;
  const before = saved.current;
  const sending = { ...before, ...patch.profile };
  saved.current = sending;
  const request = api("/api/config", { method: "PUT", body: JSON.stringify(patch), signal: AbortSignal.timeout(10_000) });
  saved.pending = request;
  try {
    dispatch({ type: "configStatus", config: await request });
  } catch (error) {
    if (saved.current === sending) saved.current = before;
    throw error;
  } finally {
    if (saved.pending === request) saved.pending = undefined;
  }
}

/** The welcome's end: waits for a save already on its way, then sends what it did not save (so a failed one is tried once more). */
export async function settleWelcomeProfile(fields: WelcomeFields, saved: SavedProfile, dispatch: Dispatch): Promise<void> {
  await saved.pending?.catch(() => {});
  await saveWelcomeProfile(fields, saved, dispatch);
}
