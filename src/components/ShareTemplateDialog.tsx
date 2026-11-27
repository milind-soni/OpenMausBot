import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import type { TemplateCard } from "../../shared/share-card";
import { t } from "@/lib/i18n";
import { exportTemplate } from "@/lib/template-share";
import type { PublishAction } from "./publish-template";
import { TemplateButtons, TemplateCardBody, TemplateModal, TemplateNotes, TemplateRepoPublishDialog, useRepoPublishOffered, useTeamTemplatesOwner, useTemplateActions } from "./TemplateCard";

/** The template's card and its buttons. `action` is the one chosen from a bot's Publish menu, run once the card is here;
 * Publish waits for the name Published by starts with, and never runs for a card that can't be published. */
function Shared({ card, action }: { card: TemplateCard; action?: PublishAction }) {
  const actions = useTemplateActions(card);
  const team = useTeamTemplatesOwner();
  const repoOffered = useRepoPublishOffered();
  const [repo, setRepo] = useState(action === "repo");
  const pending = useRef(action === "repo" ? undefined : action);
  const { authorKnown } = actions;
  useEffect(() => {
    const chosen = pending.current;
    if (!chosen || (chosen === "community" && !authorKnown)) return;
    pending.current = undefined;
    if (chosen === "community") {
      if (!card.fallback && !card.secret && card.status !== "published") void actions.publish();
    } else if (chosen === "team") {
      if (team) void actions.addToTeam(team);
    } else if (chosen === "save") void actions.save();
    else void actions.download();
  });
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

export type ShareTemplateTarget = { department: string } | { botId: string; name: string; action: PublishAction };

/** A department's Share, or what a bot's Publish chose: its template, made at once, with Publish to community and Save
 * folder…. No fields, nothing to tick. */
export function ShareTemplateDialog({ target, onClose }: { target: ShareTemplateTarget; onClose: () => void }) {
  const [card, setCard] = useState<TemplateCard | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const titleId = useId();
  const department = "department" in target ? target.department : null;
  const botId = "botId" in target ? target.botId : null;
  useEffect(() => {
    let live = true;
    setError("");
    exportTemplate(department !== null ? { department } : { botId: botId! }).then((made) => { if (live) setCard(made); },
      (cause: unknown) => { if (live) setError(cause instanceof Error && cause.message ? cause.message : t("template.failed")); });
    return () => { live = false; };
  }, [department, botId, attempt]);
  return (
    <TemplateModal title={department !== null ? t("template.shareDepartment", { name: department }) : t("template.publishTitle", { name: "name" in target ? target.name : "" })}
      labelledBy={titleId} onClose={onClose}
      footer={<button type="button" className="ui-button ui-button-md" onClick={onClose}>{t("common.close")}</button>}>
      <div data-share-department={department ?? undefined} data-publish-bot={botId ?? undefined}>
        {card ? <Shared card={card} action={"action" in target ? target.action : undefined} />
          : error ? <div role="alert" className="text-[13px] text-danger">
            <p dir="auto">{error}</p>
            <button type="button" className="ui-button ui-button-md mt-2" onClick={() => setAttempt((value) => value + 1)}>{t("common.tryAgain")}</button>
          </div>
          : <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{t("template.making")}</p>}
      </div>
    </TemplateModal>
  );
}
