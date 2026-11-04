import { intlLocale, t } from "@/lib/i18n";
import { intakeFiles, TURN_IMAGE_MAX_BYTES, TURN_IMAGE_MAX_COUNT, type AttachProblem, type DroppedFile } from "@/lib/composer-attachments";

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
    case "archives":
      return t("attach.archivesUnsupported", { names: problem.names.join(", ") });
    case "image-limit":
      return t(problem.names.length === 1 ? "attach.imagesLeftOutOne" : "attach.imagesLeftOutMany", { count: TURN_IMAGE_MAX_COUNT, megabytes: TURN_IMAGE_MAX_BYTES / (1024 * 1024), names: problem.names.join(", ") });
    case "upload-failed":
      return t("attach.uploadFailed", { name: problem.name, reason: problem.reason });
  }
}

export function attachNoticeText(problems: readonly AttachProblem[]): string | null {
  const limited = problems.filter((problem) => problem.kind === "image-limit").map(problemText).join(" ");
  const rejected = ["unsupported", "archives"].flatMap((kind) => problems.filter((problem) => problem.kind === kind).map(problemText)).join(" ");
  const failed = problems.filter((problem) => problem.kind === "too-large" || problem.kind === "upload-failed").map(problemText).join("; ");
  const notice = rejected && failed ? `${rejected} (${failed})` : rejected || failed;
  return [limited, notice].filter(Boolean).join(" ") || null;
}

export async function intakeFilesWithNotice<T extends DroppedFile & { type: string }>(files: readonly T[], options: Parameters<typeof intakeFiles<T>>[1]) {
  const { attachments, problems } = await intakeFiles(files, options);
  return { attachments, notice: attachNoticeText(problems) };
}
