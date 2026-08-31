export type ComputerControlAction = "take" | "release" | "dismiss-help";

export interface ComputerControlSnapshot {
  held: boolean;
  helpReason: string | null;
}

/** Drive the server's human-control lease and refuse to report success when
 * the returned snapshot disagrees with the action that was requested. */
export async function transitionComputerControlLease<
  Action extends ComputerControlAction,
  Snapshot extends ComputerControlSnapshot,
>(input: {
  action: Action;
  requestControl: (action: Action) => Promise<Snapshot>;
}): Promise<Snapshot> {
  const { action, requestControl } = input;
  if (action === "dismiss-help") return requestControl(action);
  const snap = await requestControl(action);
  if (snap.held !== (action === "take")) {
    throw new Error(`OpenMausBot could not ${action === "take" ? "confirm" : "release"} computer control`);
  }
  return snap;
}
