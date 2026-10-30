export type MoveKind = "routine" | "call" | "webhook" | "app-event" | "imported-skill" | "library-skill";
export type SendKind = "bot" | "skill" | "login" | "1password" | "setting" | MoveKind;

export interface SendItem {
  key: string;
  kind: SendKind;
  label: string;
  detail?: string;
  id?: string;
  bot?: string;
  parts: Record<string, string>;
}
/** `chats`: the server takes chats by row (server/cloud-send-chats.ts). */
export interface SendSummary { v: 1; appVersion: string | null; items: SendItem[]; chats?: true }

export type RowState = "only-here" | "on-both" | "to-update" | "differs" | "removed" | "off";
export interface PlanRow {
  key: string;
  kind: SendKind;
  label: string;
  detail?: string;
  id?: string;
  bot?: string;
  state: RowState;
  parts?: string[];
  differs?: string[];
}
export interface SendPlan {
  rows: PlanRow[];
  cloudOnly: Array<{ key: string; kind: SendKind; label: string; detail?: string; bot?: string }>;
  baseline: Record<string, Record<string, [string, string]>>;
  removed: string[];
}
export type SentRecord = Record<string, Record<string, [string, string]>>;
export type OffReason = "you" | "removed";

export declare const BOT_PARTS: Readonly<Record<string, readonly string[]>>;
export declare const MOVE_LINE: string;
export declare const TEAM_MOVE_LINE: "team-move";
export declare const MOVE_BOT_PARTS: Readonly<Record<string, readonly string[]>>;
export declare const AUTOMATION_KINDS: readonly MoveKind[];
export declare const MOVE_KINDS: readonly MoveKind[];
export declare const PICTURE_PART: "picture";
export declare const SETTINGS: readonly ["profile", "language"];
export declare const KINDS: readonly SendKind[];
export declare const EMPTY: "-";
export declare const itemKey: Readonly<{
  bot(id: string): string;
  skill(botId: string, name: string): string;
  login(site: string, username: string, exactHost?: string): string;
  onePassword(): string;
  setting(name: string): string;
  moved(kind: MoveKind, id: string): string;
}>;
export declare function parseSendSummary(value: unknown): SendSummary | null;
export declare function planSend(input: { local: SendSummary | null; cloud: SendSummary | null; sent?: SentRecord; off?: Record<string, OffReason>; force?: string[] }): SendPlan;
export declare function pendingRows(plan: Pick<SendPlan, "rows">): PlanRow[];
export declare function differenceSignature(plan: SendPlan): string;
export function failedSummary(outcome: import("./cloud-send.mjs").CloudSendOutcome): import("./cloud-send.mjs").CloudSendFailure;
export function resultKey(last: { at: number }): string;
