import { useState } from "react";
import { FolderOpen } from "lucide-react";

import { REVEALABLE_PATH, revealBridge, revealHostPath, revealProblemText } from "@/lib/reveal-host-path";
import { t } from "@/lib/i18n";

export function OutsideWorkspaceFile({
  filePath,
  standalone = false,
  onOpenOutside,
  openOutsideLabel,
}: {
  filePath: string;
  standalone?: boolean;
  onOpenOutside?: () => void;
  openOutsideLabel?: string;
}) {
  const [problem, setProblem] = useState("");
  const reveal = revealBridge();
  const openButton = onOpenOutside ? (
    <button
      type="button"
      onClick={onOpenOutside}
      className={standalone ? "ui-button touch:min-h-10" : "inline-flex max-w-full min-w-0 items-center gap-1 text-accent underline decoration-accent/40 hover:decoration-accent"}
    >
      {openOutsideLabel ?? t("attach.openOutsideFile")}
    </button>
  ) : null;
  if (!reveal || !REVEALABLE_PATH.test(filePath)) {
    const pathCode = (
      <code title={t("attach.outsideWorkspacePath")} className="select-all whitespace-pre-wrap break-all text-ink">
        {filePath}
      </code>
    );
    if (!openButton) return pathCode;
    return (
      <>
        {openButton}
        {pathCode}
      </>
    );
  }
  const show = async () => {
    setProblem("");
    const result = await revealHostPath(filePath);
    const text = revealProblemText(result);
    if (text) setProblem(text);
  };
  return (
    <>
      {openButton}
      <button
        type="button"
        onClick={() => void show()}
        title={filePath}
        className={standalone ? "ui-button touch:min-h-10" : "inline-flex max-w-full min-w-0 items-center gap-1 text-accent underline decoration-accent/40 hover:decoration-accent"}
      >
        <FolderOpen size={standalone ? 14 : 12} className="shrink-0" aria-hidden="true" />
        {t("attach.showInFolder")}
      </button>
      {problem && <span role="alert" className="text-danger">{problem}</span>}
    </>
  );
}

export const refusedAsOutsideWorkspace = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "outside_workspace";

export const canOpenOutsideWorkspace = (error: unknown): boolean =>
  refusedAsOutsideWorkspace(error) && (error as { canOpenOutside?: unknown } | null)?.canOpenOutside === true;

export function OutsideWorkspacePreview({ filePath, onOpenOutside }: { filePath: string; onOpenOutside?: () => void }) {
  const absolute = REVEALABLE_PATH.test(filePath) || /^(?:\\\\|\/\/)/.test(filePath);
  const revealable = Boolean(revealBridge()) && REVEALABLE_PATH.test(filePath);
  return (
    <div className="p-8 text-center text-sm">
      <p role="alert" className="mb-3 text-ink-secondary">{t("attach.previewOutsideWorkspace")}</p>
      {onOpenOutside && !absolute && (
        <div className="mb-2 flex justify-center">
          <button type="button" onClick={onOpenOutside} className="ui-button touch:min-h-10">{t("attach.openOutsideFile")}</button>
        </div>
      )}
      {absolute && <>
        {!revealable && <p className="mb-1 text-[12px] text-ink-secondary">{t("attach.outsideWorkspacePath")}</p>}
        <div className="flex flex-col items-center gap-2 text-[12px]">
          <OutsideWorkspaceFile filePath={filePath} standalone onOpenOutside={onOpenOutside} />
          {revealable && <code className="select-all whitespace-pre-wrap break-all text-ink-secondary">{filePath}</code>}
        </div>
      </>}
    </div>
  );
}
