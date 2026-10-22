import { intlLocale, t } from "@/lib/i18n";
import type { AttachProblem } from "@/lib/composer-attachments";

function numberText(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${numberText(bytes)} B`;
  if (bytes < 1024 * 1024) return `${numberText(bytes / 1024, 1)} KB`;
  return `${numberText(bytes / (1024 * 1024), 1)} MB`;
}

export function pasteSummaryText(a: { lines: number; size: number }): string {
  return t("composer.chip.pasteSummary", { lines: numberText(a.lines), size: sizeText(a.size) });
}

function problemText(problem: AttachProblem): string {
  switch (problem.kind) {
    case "too-large":
      return t("attach.tooLarge", { name: problem.name, limit: numberText(problem.limitMb) });
    case "unsupported":
      return t("attach.unsupported", { names: problem.names.join(", ") });
    case "upload-failed":
      return t("attach.uploadFailed", { name: problem.name, reason: problem.reason });
  }
}

export function attachNoticeText(problems: readonly AttachProblem[]): string | null {
  const unsupported = problems.filter((problem) => problem.kind === "unsupported").map(problemText).join(" ");
  const failed = problems.filter((problem) => problem.kind !== "unsupported").map(problemText).join("; ");
  if (unsupported && failed) return `${unsupported} (${failed})`;
  return unsupported || failed || null;
}
