/** Requested-job states shared by API producers and bounded wait consumers. */
export type JobState = "running" | "needs-input" | "blocked" | "cancelled" | "completed" | "failed" | "stalled" | "idle";
export const FINAL_JOB_STATES: ReadonlySet<JobState> = new Set(["blocked", "cancelled", "needs-input", "completed", "failed", "stalled", "idle"]);
