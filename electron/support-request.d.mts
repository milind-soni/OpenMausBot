export type SupportTopic = "billing" | "broken" | "question" | "other";
export declare const SUPPORT_TOPICS: readonly SupportTopic[];
export declare const SUPPORT_LIMITS: { readonly message: number; readonly replyTo: number; readonly diagnostics: number; readonly field: number };
export declare const RETRY_MS: readonly number[];
export declare const MAX_OUTBOX: number;
export declare function diagnosticsByDefault(topic: SupportTopic | ""): boolean;
export declare function replyAddress(value: unknown): string | null;

/** What the page sends main (`cloudPlan.support`): main names the place and the app's version itself. */
export interface SupportInput { topic: SupportTopic; message: string; replyTo: string; diagnostics?: string | null }
export interface SupportBody {
  kind: "support"; topic: SupportTopic; message: string; replyTo: string; appVersion: string; platform: string; place?: string; diagnostics?: string;
}
export declare function supportBody(input: unknown, facts: { place: string | null; appVersion: string; platform: string }): SupportBody;

/** What one send came to, as the page shows it. `queued`: saved, it goes by itself; `full`: too many are waiting already. */
export type SupportResult =
  | { outcome: "sent"; id: string }
  | { outcome: "off"; email: string }
  | { outcome: "queued" }
  | { outcome: "unavailable" }
  | { outcome: "signin" }
  | { outcome: "full" }
  | { outcome: "refused"; detail: string };
export declare function supportOutcome(answer: { status: number; body: unknown } | null): SupportResult | { outcome: "retry" };

export interface SupportOutbox {
  submit(body: SupportBody): Promise<SupportResult>;
  flush(): Promise<void>;
  waiting(): number;
  stop(): void;
}
export declare function createSupportOutbox(options: {
  store: { read(): unknown; write(value: unknown): void };
  send: (body: SupportBody) => Promise<{ status: number; body: unknown } | null>;
  account: () => string | null;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?: (line: string) => void;
}): SupportOutbox;
