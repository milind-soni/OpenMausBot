import type { WorkerJobRecord } from "./worker-jobs.ts";

function resultText(job: Readonly<WorkerJobRecord>): string {
  if (job.error?.trim()) return job.error.trim();
  if (job.result === undefined || job.result === null) return "Completed without a text result.";
  const value = typeof job.result === "string"
    ? job.result
    : !Array.isArray(job.result) && typeof job.result === "object" && typeof job.result.text === "string"
      ? job.result.text
      : JSON.stringify(job.result, null, 2) ?? "Completed without a text result.";
  return value.trim() || "Completed without a text result.";
}

/** One final owner-thread receipt; private prompts and tool transcripts never enter it. */
export function workerBatchReceiptText(label: string, jobs: readonly WorkerJobRecord[]): string {
  const visible = jobs.filter((job) => job.status !== "canceled" || job.result !== undefined || Boolean(job.error));
  if (visible.length === 0) return "";
  const needsAttention = visible.some((job) => job.status === "failed");
  const sections = visible.map((job) => {
    const status = job.status === "failed"
      ? " — failed"
      : job.status === "canceled"
        ? " — canceled"
        : "";
    return `**${job.label?.trim() || "Worker"}${status}**\n${resultText(job)}`;
  });
  return [
    `${needsAttention ? "Parallel work needs attention" : "Parallel work finished"}: ${label}`,
    ...sections,
  ].join("\n\n");
}
