import type { InboundMessageOutcome } from "../../collaboration/inbound.ts";
import type { DingTalkInboundMessage } from "./types.ts";

export interface IgnoredFakeMessage {
  accepted: false;
  reason: "not_addressed";
}

/**
 * Test transport only: it normalizes the delivery boundary and invokes the
 * collaboration service. It never owns or mutates Work Item state.
 */
export class FakeDingTalkAdapter {
  constructor(private readonly ingest: (message: DingTalkInboundMessage) => InboundMessageOutcome) {}

  receive(message: DingTalkInboundMessage): InboundMessageOutcome | IgnoredFakeMessage {
    if (!message.addressedToBot) return { accepted: false, reason: "not_addressed" };
    return this.ingest(structuredClone(message));
  }
}
