import type { CloudTrial, CloudTrialState } from "./cloud-home.mjs";
import type { CloudAccountState } from "./cloud-account.mjs";

export declare const TRIAL_ENDING_SOON_MS: number;
export declare const PROCESSING_NOTICE_AFTER_MS: number;
export declare function trialNoticeState(trial: CloudTrial | null | undefined, now: number): CloudTrialState | null;
export declare function localDay(now: number): string;
export interface TrialNotices {
  due(state: CloudAccountState | null | undefined): CloudTrialState | null;
  seen(state: CloudAccountState | null | undefined): void;
}
export declare function createTrialNotices(options: { read(): unknown; write(value: { day: string; shown: string[] }): void; now?: () => number }): TrialNotices;
