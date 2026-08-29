export type ComputerControlAction = "take" | "release" | "dismiss-help";

export interface ComputerControlSnapshot {
  held: boolean;
  helpReason: string | null;
}

/** Coordinate the public server lease with Electron's private browser gate.
 * Take is local-first; release is server-first. BrowserPanel passes
 * `syncNativeBrowser: false` because it owns the same choreography itself. */
export async function transitionComputerControlLease<
  Action extends ComputerControlAction,
  Snapshot extends ComputerControlSnapshot,
>(input: {
  action: Action;
  syncNativeBrowser: boolean;
  requestControl: (action: Action) => Promise<Snapshot>;
  setNativeBrowserControl: (held: boolean) => Promise<boolean>;
}): Promise<Snapshot> {
  const { action, syncNativeBrowser, requestControl, setNativeBrowserControl } = input;
  if (action === "dismiss-help") return requestControl(action);
  if (action === "take" && syncNativeBrowser && !(await setNativeBrowserControl(true))) {
    throw new Error("OpenMausBot could not pause this bot's browser safely");
  }
  const snap = await requestControl(action);
  if (snap.held !== (action === "take")) {
    throw new Error(`OpenMausBot could not ${action === "take" ? "confirm" : "release"} computer control`);
  }
  if (action === "release" && syncNativeBrowser && !(await setNativeBrowserControl(false))) {
    throw new Error("The computer was released, but the browser remains paused for safety");
  }
  return snap;
}
