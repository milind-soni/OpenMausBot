/** Where work one bot handed another stands: accepted, being worked on, waiting on someone, or ended. */
export type HandoffState = "claimed" | "working" | "waiting" | "done" | "failed";

/** A hand-off's status, on its "Sent to" row in the asking conversation (`WireMessage.handoff`) and on the conversation
 * that does the work (`WireTask.handoff`). Names appear only on a Team Cloud; elsewhere a person waited on is "you". */
export interface HandoffStatusLine {
  /** The assignment's id. */
  id: string;
  state: HandoffState;
  /** While waiting: on a bot (its name), or on a person (their name on a Team Cloud, none anywhere else). */
  waitingOn?: { kind: "bot" | "person"; name?: string };
  /** Failed: one line saying why. */
  why?: string;
  /** On a Team Cloud: whose request this is. `private`: it runs in their private chat, so a shared place shows only this. */
  forPerson?: { name: string; private?: true };
  /** When the state last changed, epoch ms. */
  at: number;
}

/** `WireMessage.handoff` and `WireTask.handoff`. */
export interface HandoffStatusField {
  handoff?: HandoffStatusLine;
}
