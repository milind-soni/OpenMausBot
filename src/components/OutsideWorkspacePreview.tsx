import { OutsideWorkspaceFile } from "./AttachmentPreview";
import { t } from "@/lib/i18n";

export const refusedAsOutsideWorkspace = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "outside_workspace";

/** A file preview the server refused as outside the chat's folders: saving or retrying would be refused the same way. */
export function OutsideWorkspacePreview({ filePath }: { filePath: string }) {
  return (
    <div className="p-8 text-center text-sm">
      <p role="alert" className="mb-3 text-ink-secondary">{t("attach.previewOutsideWorkspace")}</p>
      <div className="flex flex-wrap items-center justify-center gap-x-1.5 text-[12px]"><OutsideWorkspaceFile filePath={filePath} /></div>
    </div>
  );
}
