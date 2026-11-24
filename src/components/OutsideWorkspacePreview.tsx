import { OutsideWorkspaceFile } from "./AttachmentPreview";
import { REVEALABLE_PATH, revealBridge } from "@/lib/reveal-host-path";
import { t } from "@/lib/i18n";

export const refusedAsOutsideWorkspace = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "outside_workspace";

export function OutsideWorkspacePreview({ filePath }: { filePath: string }) {
  const absolute = REVEALABLE_PATH.test(filePath) || /^(?:\\\\|\/\/)/.test(filePath);
  const revealable = Boolean(revealBridge()) && REVEALABLE_PATH.test(filePath);
  return (
    <div className="p-8 text-center text-sm">
      <p role="alert" className="mb-3 text-ink-secondary">{t("attach.previewOutsideWorkspace")}</p>
      {absolute && <>
        {!revealable && <p className="mb-1 text-[12px] text-ink-secondary">{t("attach.outsideWorkspacePath")}</p>}
        <div className="flex flex-col items-center gap-1 text-[12px]">
          <OutsideWorkspaceFile filePath={filePath} standalone />
          {revealable && <code className="select-all whitespace-pre-wrap break-all text-ink-secondary">{filePath}</code>}
        </div>
      </>}
    </div>
  );
}
