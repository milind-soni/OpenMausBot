/** What long-running panel action is in flight, if any. */
export type PendingAction =
  | "join"
  | "sleep"
  | "provision"
  | "vps-replace"
  | "vm-create"
  | "vm-recreate"
  | "vm-delete"
  | null;
