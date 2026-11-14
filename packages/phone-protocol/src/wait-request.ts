/** The line a wait (wait_until) posted when it ended (`WireMessage.wait`). */
export interface WaitLine {
  id: string;
  status: "fired" | "expired" | "stopped";
}

/** `WireMessage.wait`: set on the line a wait posted when it ended. */
export interface WaitLineField {
  wait?: WaitLine;
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
