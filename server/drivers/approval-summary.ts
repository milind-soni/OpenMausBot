// Permission classifiers must see the executable request, not a display
// preview. Keep a generous bounded copy for cards/logs and mark any lossy
// representation so guarded autonomy asks instead of approving a safe prefix.

export const MAX_APPROVAL_SUMMARY_CHARS = 16_384;

export interface ApprovalSummary {
  summary: string;
  summaryComplete: boolean;
}

export function approvalSummary(value: unknown, fallback: string, reliable = true): ApprovalSummary {
  let text: string;
  try {
    if (typeof value === "string") text = value;
    else if (Array.isArray(value) && value.every((part) => typeof part === "string")) text = value.join(" ");
    else if (value === undefined || value === null) {
      text = fallback;
      reliable = false;
    } else {
      text = JSON.stringify(value);
      if (!text) {
        text = fallback;
        reliable = false;
      }
    }
  } catch {
    text = fallback;
    reliable = false;
  }
  const complete = text.length <= MAX_APPROVAL_SUMMARY_CHARS;
  return {
    summary: complete ? text : text.slice(0, MAX_APPROVAL_SUMMARY_CHARS),
    summaryComplete: reliable && complete,
  };
}
