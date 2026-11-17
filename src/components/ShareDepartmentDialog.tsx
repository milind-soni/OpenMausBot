import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";

import type { TemplateCard } from "../../shared/share-card";
import { t } from "@/lib/i18n";
import { exportDepartment } from "@/lib/template-share";
import { TemplateButtons, TemplateCardBody, TemplateModal, TemplateNotes, TemplateRepoPublishDialog, useRepoPublishOffered, useTeamTemplatesOwner, useTemplateActions } from "./TemplateCard";

function Shared({ card }: { card: TemplateCard }) {
  const actions = useTemplateActions(card);
  const team = useTeamTemplatesOwner();
  const repoOffered = useRepoPublishOffered();
  const [repo, setRepo] = useState(false);
  return <>
    <div className="rounded-xl border border-hairline/40 px-3 py-2.5">
      <TemplateCardBody card={actions.card} />
    </div>
    {!actions.card.fallback && actions.card.status !== "published" && <p className="mt-2 text-[12px] text-ink-secondary">{t("template.publicNote")}</p>}
    <TemplateButtons actions={actions} primary={t("template.publishToCommunity")}
      view={{ label: t("template.viewPullRequest"), url: actions.card.prUrl ?? actions.card.link }}
      extra={actions.card.status === "gone" ? null : <>
        {repoOffered && <button type="button" data-template-repo onClick={() => setRepo(true)} disabled={actions.busy !== null} className="ui-button ui-button-md">
          {t("template.publishToRepo")}
        </button>}
        {team && <button type="button" data-template-team onClick={() => void actions.addToTeam(team)} disabled={actions.busy !== null} className="ui-button ui-button-md">
          {actions.busy === "team" && <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}{t("template.addToTeam", { team })}
        </button>}
        {!actions.card.fallback && <button type="button" data-template-save onClick={() => void actions.save()} disabled={actions.busy !== null} className="ui-button ui-button-md">
          {t("template.saveFolder")}
        </button>}
      </>} />
    <TemplateNotes actions={actions} />
    {repo && <TemplateRepoPublishDialog card={actions.card} onClose={() => setRepo(false)} />}
  </>;
}

/** A department's Share: its template, made at once, with Publish to community and Save folder…. No fields, nothing to tick. */
export function ShareDepartmentDialog({ department, onClose }: { department: string; onClose: () => void }) {
  const [card, setCard] = useState<TemplateCard | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const titleId = useId();
  useEffect(() => {
    let live = true;
    setError("");
    exportDepartment(department).then((made) => { if (live) setCard(made); },
      (cause: unknown) => { if (live) setError(cause instanceof Error && cause.message ? cause.message : t("template.failed")); });
    return () => { live = false; };
  }, [department, attempt]);
  return (
    <TemplateModal title={t("template.shareDepartment", { name: department })} labelledBy={titleId} onClose={onClose}
      footer={<button type="button" className="ui-button ui-button-md" onClick={onClose}>{t("common.close")}</button>}>
      <div data-share-department={department}>
        {card ? <Shared card={card} />
          : error ? <div role="alert" className="text-[13px] text-danger">
            <p dir="auto">{error}</p>
            <button type="button" className="ui-button ui-button-md mt-2" onClick={() => setAttempt((value) => value + 1)}>{t("common.tryAgain")}</button>
          </div>
          : <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{t("template.making")}</p>}
      </div>
    </TemplateModal>
  );
}
