/**
 * Issue estimates in points, on Linear's Fibonacci scale. Optional on every issue; "No estimate" is the absence of a
 * value. Lanes and list groups add up the points of their issues.
 */
export const ESTIMATES = [1, 2, 3, 5, 8] as const;
export type Estimate = (typeof ESTIMATES)[number];

export const isEstimate = (value: unknown): value is Estimate => typeof value === "number" && (ESTIMATES as readonly number[]).includes(value);

export const estimateLabel = (value: number) => `${value} ${value === 1 ? "point" : "points"}`;

/** Sum of the estimates of `tasks`; 0 when none has one. */
export function totalEstimate(tasks: readonly { estimate?: number }[]) {
  return tasks.reduce((sum, task) => sum + (isEstimate(task.estimate) ? task.estimate : 0), 0);
}
