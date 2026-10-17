import { EFFORT_LEVELS, type EffortLevel, type ModelSelection } from "./wire.ts";

export const MAX_APPROVAL_REVIEW_INSTRUCTIONS_LENGTH = 24_000;

/** Provider-native review takes precedence. An absent selection follows the
 * session's exact model and variant. Review uses None when supported, otherwise
 * the lowest supported effort; an explicit reviewer effort remains exact. */
export interface ApprovalReviewSettings {
  model?: ModelSelection;
  instructions?: string;
}

export const DEFAULT_APPROVAL_REVIEW_SETTINGS: Readonly<ApprovalReviewSettings> = {};

export interface ApprovalReviewCapabilities {
  effortLevels?: readonly EffortLevel[];
  approvalReviewEffortLevels?: readonly EffortLevel[];
  modelVariants?: boolean;
}

export function approvalReviewEffortLevels(capabilities: ApprovalReviewCapabilities): readonly EffortLevel[] {
  return capabilities.modelVariants ? [] : capabilities.approvalReviewEffortLevels ?? capabilities.effortLevels ?? [];
}

export function defaultApprovalReviewEffort(capabilities: ApprovalReviewCapabilities): EffortLevel | undefined {
  const levels = approvalReviewEffortLevels(capabilities);
  return EFFORT_LEVELS.find(level => levels.includes(level));
}
