// A message a person sends while their bot works: steer it into the running turn, queue it for after that turn, or
// restart the turn with it. The composer resolves the choice; the server's direct-busy admission applies it.

export const FOLLOW_UPS = ["steer", "queue", "restart"] as const;
export type FollowUp = (typeof FOLLOW_UPS)[number];
/** What Enter does while a turn runs (the person's setting); Ctrl/⌘+Enter does the other one. */
export type FollowUpDefault = Exclude<FollowUp, "restart">;

export const DEFAULT_FOLLOW_UP: FollowUpDefault = "steer";

/** undefined when absent, null when present but not a follow-up. */
export function parseFollowUp(value: unknown): FollowUp | null | undefined {
  if (value === undefined || value === null) return undefined;
  return FOLLOW_UPS.find((followUp) => followUp === value) ?? null;
}

/** null: nothing is running, so it is an ordinary send. A turn that cannot take steering input always queues. */
export function resolveFollowUp(input: {
  running: boolean;
  /** Ctrl/⌘ held with the send key, or with the click. */
  alternate: boolean;
  preferred?: FollowUpDefault;
  canSteer: boolean;
}): FollowUp | null {
  if (!input.running) return null;
  if (!input.canSteer) return "queue";
  const preferred = input.preferred ?? DEFAULT_FOLLOW_UP;
  if (input.alternate) return preferred === "queue" ? "steer" : "queue";
  return preferred;
}

/** The send menu while a turn runs: what Enter does first, then the other one where the turn can be steered, then restart. */
export function followUpChoices(preferred: FollowUpDefault, canSteer: boolean): FollowUp[] {
  const first = resolveFollowUp({ running: true, alternate: false, preferred, canSteer })!;
  const other = resolveFollowUp({ running: true, alternate: true, preferred, canSteer })!;
  return [...new Set<FollowUp>([first, other, "restart"])];
}
