import { OutsideWorkspaceFile, REVEALABLE_PATH, revealBridge } from "./AttachmentPreview";
import { t } from "@/lib/i18n";

export const refusedAsOutsideWorkspace = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "outside_workspace";

export function OutsideWorkspacePreview({ filePath }: { filePath: string }) {
  const revealable = Boolean(revealBridge()) && REVEALABLE_PATH.test(filePath);
  return (
    <div className="p-8 text-center text-sm">
      <p role="alert" className="mb-3 text-ink-secondary">{t("attach.previewOutsideWorkspace")}</p>
      {!revealable && <p className="mb-1 text-[12px] text-ink-secondary">{t("attach.outsideWorkspacePath")}</p>}
      <div className="flex flex-wrap items-center justify-center gap-x-1.5 text-[12px]"><OutsideWorkspaceFile filePath={filePath} /></div>
    </div>
  );
}
