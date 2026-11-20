export interface OutsideWriteCardField {
  /** What work from outside asked to write where later turns read it; nothing is written until a person says yes. */
  outsideWrite?: { kind: "room-bulletin"; roomId: string; bulletin: string } | { kind: "memory"; action: string; text?: string; oldText?: string; until?: string };
}
