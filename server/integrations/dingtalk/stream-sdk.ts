import {
  DWClient,
  TOPIC_CARD,
  TOPIC_ROBOT,
  type DWClientDownStream,
} from "dingtalk-stream";

import type { DingTalkStreamSdkPort, MaybePromise } from "./ports.ts";
import type { DingTalkStreamEnvelope } from "./types.ts";

function envelope(message: DWClientDownStream): DingTalkStreamEnvelope {
  return {
    type: message.type,
    headers: {
      messageId: message.headers.messageId,
      topic: message.headers.topic,
      ...(message.headers.eventId ? { eventId: message.headers.eventId } : {}),
      ...(message.headers.time ? { time: message.headers.time } : {}),
    },
    data: message.data,
  };
}

/** The only module that imports the vendor SDK. dingtalk-stream owns reconnect backoff. */
export class RealDingTalkStreamSdk implements DingTalkStreamSdkPort {
  private readonly client: DWClient;
  private readonly subscriptions = new Set<"robot" | "card">();
  private readonly onHandlerError: (error: unknown) => void;

  constructor(
    credentials: { clientId: string; clientSecret: string },
    onHandlerError: (error: unknown) => void = () => {},
  ) {
    this.onHandlerError = onHandlerError;
    this.client = new DWClient({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      debug: false,
      keepAlive: true,
    });
  }

  subscribe(topic: "robot" | "card", handler: (message: DingTalkStreamEnvelope) => MaybePromise<void>): void {
    if (this.subscriptions.has(topic)) throw new Error(`dingtalk_${topic}_handler_already_registered`);
    this.subscriptions.add(topic);
    const sdkTopic = topic === "robot" ? TOPIC_ROBOT : TOPIC_CARD;
    this.client.registerCallbackListener(sdkTopic, (message) => {
      void Promise.resolve(handler(envelope(message))).catch((error: unknown) => this.onHandlerError(error));
    });
  }

  async connect(): Promise<{ connected: boolean }> {
    await this.client.connect();
    return { connected: this.client.connected };
  }

  disconnect(): void {
    this.client.disconnect();
  }

  acknowledge(transportMessageId: string): void {
    this.client.socketCallBackResponse(transportMessageId, { status: "SUCCESS" });
  }
}
