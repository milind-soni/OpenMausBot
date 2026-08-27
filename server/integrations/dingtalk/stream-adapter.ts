import { normalizeBotMessage, normalizeCardAction } from "./normalizer.ts";
import type { DingTalkInboundSink, DingTalkOwnerActionSink, DingTalkStreamSdkPort } from "./ports.ts";
import {
  NullDingTalkSafeLogger,
  safeErrorCode,
  stableIdentifierHash,
  type DingTalkSafeLogger,
} from "./safe-log.ts";
import { DingTalkSessionReplyRegistry } from "./reply-router.ts";
import type { DingTalkStreamEnvelope } from "./types.ts";

export type DingTalkStreamState = "stopped" | "connecting" | "connected" | "reconnecting" | "stopping";

export class DingTalkStreamAdapter {
  private readonly sdk: DingTalkStreamSdkPort;
  private readonly inbound: DingTalkInboundSink;
  private readonly ownerActions: DingTalkOwnerActionSink;
  private readonly replyChannels: DingTalkSessionReplyRegistry;
  private readonly logger: DingTalkSafeLogger;
  private currentState: DingTalkStreamState = "stopped";
  private handlersRegistered = false;
  private connectPromise: Promise<DingTalkStreamState> | null = null;
  private lifecycleGeneration = 0;

  constructor(
    sdk: DingTalkStreamSdkPort,
    inbound: DingTalkInboundSink,
    ownerActions: DingTalkOwnerActionSink,
    replyChannels: DingTalkSessionReplyRegistry,
    logger: DingTalkSafeLogger = new NullDingTalkSafeLogger(),
  ) {
    this.sdk = sdk;
    this.inbound = inbound;
    this.ownerActions = ownerActions;
    this.replyChannels = replyChannels;
    this.logger = logger;
  }

  state(): DingTalkStreamState {
    return this.currentState;
  }

  start(): Promise<DingTalkStreamState> {
    if (this.connectPromise) return this.connectPromise;
    if (this.currentState === "connected" || this.currentState === "reconnecting") {
      return Promise.resolve(this.currentState);
    }
    if (!this.handlersRegistered) {
      this.sdk.subscribe("robot", (message) => this.receiveRobot(message));
      this.sdk.subscribe("card", (message) => this.receiveCard(message));
      this.handlersRegistered = true;
    }
    this.currentState = "connecting";
    const generation = ++this.lifecycleGeneration;
    this.connectPromise = this.sdk
      .connect()
      .then(({ connected }) => {
        if (generation !== this.lifecycleGeneration || this.currentState === "stopping" || this.currentState === "stopped") {
          return this.currentState;
        }
        this.currentState = connected ? "connected" : "reconnecting";
        return this.currentState;
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  stop(): void {
    if (this.currentState === "stopped") return;
    this.currentState = "stopping";
    this.lifecycleGeneration += 1;
    this.sdk.disconnect();
    this.replyChannels.clear();
    this.currentState = "stopped";
  }

  private async receiveRobot(envelope: DingTalkStreamEnvelope): Promise<void> {
    try {
      const normalized = normalizeBotMessage(envelope);
      if (normalized.replyChannel) this.replyChannels.capture(normalized.replyChannel);
      const outcome = await this.inbound.ingest(normalized.message);
      // Success/duplicate both mean the authoritative transaction is durable.
      this.sdk.acknowledge(envelope.headers.messageId);
      this.logger.write({
        event: "dingtalk.message.committed",
        topic: "robot",
        transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
        sourceEventIdHash: stableIdentifierHash(normalized.message.sourceEventId),
        workItemId: outcome.workItemId,
        duplicate: outcome.duplicate,
      });
    } catch (error) {
      // No acknowledgement: DingTalk may redeliver and core idempotency converges it.
      this.logger.write({
        event: "dingtalk.message.not_acknowledged",
        topic: "robot",
        transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
        code: safeErrorCode(error),
      });
    }
  }

  private async receiveCard(envelope: DingTalkStreamEnvelope): Promise<void> {
    try {
      const action = normalizeCardAction(envelope);
      const outcome = await this.ownerActions.perform(action);
      this.sdk.acknowledge(envelope.headers.messageId);
      this.logger.write({
        event: "dingtalk.card_action.committed",
        topic: "card",
        transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
        sourceEventIdHash: stableIdentifierHash(action.transportEventId),
        workItemId: outcome.workItemId,
        duplicate: outcome.duplicate,
      });
    } catch (error) {
      this.logger.write({
        event: "dingtalk.card_action.not_acknowledged",
        topic: "card",
        transportMessageIdHash: stableIdentifierHash(envelope.headers.messageId),
        code: safeErrorCode(error),
      });
    }
  }
}
