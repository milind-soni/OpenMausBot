/** The line a wait (wait_until) posted when it ended (`WireMessage.wait`). */
export interface WaitLine {
  id: string;
  status: "fired" | "expired" | "stopped";
}

/** `WireMessage.wait` and `WireMessage.waitId`: the lines a wait wrote. */
export interface WaitLineField {
  wait?: WaitLine;
  /** On a wait follow-up's line: that wait's id, so the chat names it when two waits write the same words. */
  waitId?: string;
}

/** A wait with a follow-up a bot set up from chat (wait_until, `OptionCardData.waitRequest`); its Cancel stops it until it settles. */
export interface WaitCardData {
  waitId: string;
  label: string;
  followUp: string;
  settled?: "fired" | "expired" | "cancelled";
}

/** `OptionCardData.waitRequest`: set on the card a wait with a follow-up showed. */
export interface WaitCardField {
  waitRequest?: WaitCardData;
}
