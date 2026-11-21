// A shareable template of a bot or a department: its card (in the chat and in the department's Share), what it brings
// (the Details sheet, also Import's preview), and the card's actions.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, ChevronDown, Copy, FolderDown, Github, Library, Loader2, MoreHorizontal, RefreshCw, Trash2, Upload } from "lucide-react";

import { COMMUNITY_UPLOAD_URL, TEMPLATE_UPDATE_MESSAGE, type TemplateAvatar, type TemplateCard, type TemplateDetails, type TemplateRepoPublish } from "../../shared/share-card";
import { botBodyId } from "../../shared/bot-body";
import { MAUS_COLOR_NAMES, type MausColor } from "../../shared/wire";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { addToTeamTemplates, askBot, countsLine, deleteTemplate, githubConnection, publishTemplate, publishToRepo, saveTemplateFolder, templateDetails } from "@/lib/template-share";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { useStore, type Message } from "@/state/store";
import { ASK_CHIP, ASK_CHIP_IDLE, ASK_PRIMARY_BUTTON } from "./AskCard";
import { BotAvatar } from "./Avatar";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

const FACES = 4;
const STATUS_KEY = {
  draft: "template.status.draft",
  publishing: "template.status.publishing",
  published: "template.status.published",
  failed: "template.status.failed",
  gone: "template.status.gone",
} as const;

const colorOf = (value: string): MausColor => (MAUS_COLOR_NAMES as readonly string[]).includes(value) ? value as MausColor : "cyan";

/** A picture read from a template folder; a bot's own picture is a stored attachment and goes through BotAvatar. */
const FOLDER_PICTURE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function Face({ avatar, size }: { avatar: TemplateAvatar; size: number }) {
  if (avatar.picture && FOLDER_PICTURE.test(avatar.picture)) {
    return <img data-template-picture src={avatar.picture} alt={t("avatar.alt", { name: avatar.name })} width={size} height={size} draggable={false}
      className="block max-w-none shrink-0 rounded-full bg-raised object-cover" style={{ width: size, height: size }} />;
  }
  return <BotAvatar size={size} bot={{ name: avatar.name, color: colorOf(avatar.color), avatarUrl: avatar.picture ?? null,
    ...(avatar.picture ? { avatarCrop: "circle" as const } : {}), mascotBody: avatar.mascotBody ? botBodyId(avatar.mascotBody) : null }} />;
}

/** Up to four faces, overlapping, then "+N". */
export function TemplateFaces({ avatars, size = 32 }: { avatars: readonly TemplateAvatar[]; size?: number }) {
  const shown = avatars.slice(0, FACES);
  return (
    <span className="flex shrink-0 items-center -space-x-2">
      {shown.map((avatar) => <span key={avatar.key} className="rounded-full ring-2 ring-panel"><Face avatar={avatar} size={size} /></span>)}
      {avatars.length > FACES && <span className="flex items-center justify-center rounded-full bg-raised text-[11px] text-ink-secondary ring-2 ring-panel tabular-nums"
        style={{ width: size, height: size }}>+{avatars.length - FACES}</span>}
    </span>
  );
}

/** Faces, name, status, one line, counts and the promise that nothing private travels. */
export function TemplateCardBody({ card }: { card: TemplateCard }) {
  const counts = countsLine(card);
  return (
    <div data-template-status={card.status} className="flex min-w-0 items-start gap-3">
      <TemplateFaces avatars={card.avatars} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span dir="auto" className="min-w-0 truncate text-[13px] font-medium text-ink" title={card.name}>{card.name}</span>
          <span className={cn("ui-chip shrink-0 bg-ink/[0.06]", card.status === "failed" ? "text-danger" : "text-ink-secondary")}>
            {card.status === "publishing" && <Loader2 size={11} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
            {t(STATUS_KEY[card.status])}
          </span>
        </div>
        {card.tagline && <p dir="auto" className="mt-0.5 truncate text-[13px] text-ink-secondary" title={card.tagline}>{card.tagline}</p>}
        {counts && <p className="mt-0.5 text-[12px] text-ink-tertiary">{counts}</p>}
        <p className="mt-0.5 text-[12px] text-ink-tertiary">{t("template.neverShared")}</p>
        {card.redacted > 0 && <p className="mt-0.5 text-[12px] text-ink-tertiary">{card.redacted === 1 ? t("template.redactedOne") : t("template.redactedMany", { count: card.redacted })}</p>}
        {card.skipped.length > 0 && <p dir="auto" className="mt-0.5 text-[12px] text-ink-tertiary">{t("template.skipped", { list: card.skipped.join(", ") })}</p>}
      </div>
    </div>
  );
}

/** What the card's buttons do. The card shown is the latest the server answered, until the message brings a newer one. */
export function useTemplateActions(initial: TemplateCard) {
  const [card, setCard] = useState(initial);
  const [busy, setBusy] = useState<"publish" | "save" | "delete" | "team" | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [teamNote, setTeamNote] = useState<string | null>(null);
  useEffect(() => setCard(initial), [initial]);
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("template.failed"));
    } finally {
      setBusy(null);
    }
  };
  return {
    card, busy, error, saved, teamNote,
    /** Adds it to the Team Cloud's own templates, replacing one of the same name there. */
    addToTeam: (team: string) => run("team", async () => {
      setTeamNote(null);
      const added = await addToTeamTemplates(card.id);
      setTeamNote(t(added.replaced ? "template.replacedInTeam" : "template.addedToTeam", { team }));
    }),
    publish: () => run("publish", async () => {
      setCard((current) => ({ ...current, status: "publishing", error: undefined }));
      try {
        setCard(await publishTemplate(card.id));
      } catch (cause) {
        setCard((current) => ({ ...current, status: "failed", error: cause instanceof Error ? cause.message : undefined }));
      }
    }),
    save: () => run("save", async () => setSaved(await saveTemplateFolder(card))),
    remove: () => run("delete", async () => {
      await deleteTemplate(card.id);
      setCard((current) => ({ ...current, status: "gone" }));
    }),
  };
}

export type TemplateActions = ReturnType<typeof useTemplateActions>;

function CopyLinkButton({ link }: { link: string }) {
  const { state, copy } = useCopyFeedback(link);
  return (
    <button type="button" onClick={copy} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
      {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {t(state === "copied" ? "chat.page.copied" : "chat.page.copyLink")}
    </button>
  );
}

const openLink = (url: string) => void openExternalLink(url).catch(() => {});

/** The card's buttons for its status. `primary` names Publish ("Publish" in a chat, "Publish to community" for a
 * department); `viewLabel` the link to the published folder or its pull request. */
export function TemplateButtons({ actions, primary, view, extra }: {
  actions: TemplateActions;
  primary: string;
  view: { label: string; url?: string };
  extra?: ReactNode;
}) {
  const { card, busy } = actions;
  if (card.status === "gone") return null;
  const saveButton = (
    <button type="button" data-template-save onClick={() => void actions.save()} disabled={busy !== null} className={cn(card.fallback ? ASK_PRIMARY_BUTTON : cn(ASK_CHIP, ASK_CHIP_IDLE))}>
      {busy === "save" ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <FolderDown size={14} aria-hidden="true" />}{t("template.saveFolder")}
    </button>
  );
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {card.fallback ? <>
        {saveButton}
        <button type="button" data-template-upload onClick={() => openLink(COMMUNITY_UPLOAD_URL)} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
          <Github size={14} aria-hidden="true" />{t("template.uploadOnGithub")}
        </button>
      </> : card.status === "published" && card.link ? <>
        <CopyLinkButton link={card.link} />
        {view.url && <button type="button" onClick={() => openLink(view.url!)} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
          <ArrowUpRight size={14} aria-hidden="true" />{view.label}
        </button>}
      </> : (
        <button type="button" data-template-publish onClick={() => void actions.publish()} disabled={busy !== null || card.status === "publishing"} className={ASK_PRIMARY_BUTTON}>
          {card.status === "publishing" ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Upload size={14} aria-hidden="true" />}
          {card.status === "failed" ? t("common.tryAgain") : primary}
        </button>
      )}
      {extra}
    </div>
  );
}

/** One line under the buttons: why Publish isn't offered, the publish error, the last action's error, or where the folder went. */
export function TemplateNotes({ actions }: { actions: TemplateActions }) {
  const { card, error, saved, teamNote } = actions;
  return <>
    {card.fallback && <p className="mt-1.5 text-[12px] text-ink-secondary">{t(card.fallback === "sign_in" ? "template.signInToPublish" : "template.publishUnavailable")}</p>}
    {card.status === "failed" && card.error && <p role="alert" dir="auto" className="mt-1.5 text-[12px] text-danger">{card.error}</p>}
    {error && <p role="alert" dir="auto" className="mt-1.5 text-[12px] text-danger">{error}</p>}
    {saved && <p role="status" dir="auto" className="mt-1.5 truncate text-[12px] text-ink-secondary" title={saved}>{t("template.savedTo", { path: saved })}</p>}
    {teamNote && <p role="status" dir="auto" className="mt-1.5 text-[12px] text-ink-secondary">{teamNote}</p>}
  </>;
}

/** On a Team Cloud, its name when the person is its owner or an admin, who add templates to its library; else null. */
export function useTeamTemplatesOwner(): string | null {
  const { state } = useStore();
  const admin = useOwnerOrAdmin();
  const team = state.config?.team?.name;
  return team && admin === true ? team : null;
}

/** Publishing to one's own repository goes through Share's routes, which a Team Cloud keeps for its owner and admins. */
export function useRepoPublishOffered(): boolean {
  const { state } = useStore();
  const admin = useOwnerOrAdmin();
  return !state.config?.team || admin === true;
}

/** The template card a bot posts in its chat. `botId` and `threadId` are this chat's, for Update; a group chat leaves them out. */
export function TemplateChatCard({ message, botId, threadId }: { message: Message; botId?: string; threadId?: string }) {
  const { dispatch } = useStore();
  const actions = useTemplateActions(message.template!);
  const [details, setDetails] = useState(false);
  const [repo, setRepo] = useState(false);
  const team = useTeamTemplatesOwner();
  const repoOffered = useRepoPublishOffered();
  const { card } = actions;
  const overflow: SidebarMenuItem[] = card.status === "gone" ? [] : [
    ...(botId ? [{ key: "update", label: t("template.update"), icon: <RefreshCw size={16} />, onSelect: () => askBot(dispatch, botId, threadId, TEMPLATE_UPDATE_MESSAGE) }] : []),
    ...(team ? [{ key: "team", label: t("template.addToTeam", { team }), icon: <Library size={16} />, onSelect: () => void actions.addToTeam(team) }] : []),
    ...(repoOffered ? [{ key: "repo", label: t("template.publishToRepo"), icon: <Github size={16} />, onSelect: () => setRepo(true) }] : []),
    ...(card.fallback ? [] : [{ key: "save", label: t("template.saveFolder"), icon: <FolderDown size={16} />, onSelect: () => void actions.save() }]),
    { key: "delete", label: t("template.delete"), icon: <Trash2 size={16} />, separatorBefore: true, onSelect: () => void actions.remove() },
  ];
  return (
    <div data-template-card={card.id} className="w-full max-w-md overflow-hidden rounded-xl border border-hairline/40 bg-panel px-3 py-2.5">
      <TemplateCardBody card={card} />
      <TemplateButtons actions={actions} primary={t("template.publish")} view={{ label: t("template.viewOnGithub"), url: card.link }}
        extra={card.status === "gone" ? null : <>
          <button type="button" data-template-details onClick={() => setDetails(true)} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>{t("template.details")}</button>
          <SidebarPopoverMenu items={overflow} ariaLabel={t("template.more")} triggerTitle={t("template.more")} align="end"
            triggerClassName="flex shrink-0 rounded-full"
            renderTrigger={() => <span className={cn(ASK_CHIP, ASK_CHIP_IDLE, "px-2")}><MoreHorizontal size={14} aria-hidden="true" /></span>} />
        </>} />
      <TemplateNotes actions={actions} />
      {details && <TemplateDetailsSheet id={card.id} name={card.name} onClose={() => setDetails(false)} />}
      {repo && <TemplateRepoPublishDialog card={card} onClose={() => setRepo(false)} />}
    </div>
  );
}

function Disclosure({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="border-b border-hairline/35 last:border-b-0">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 w-full items-center gap-2 rounded-md px-1 text-start text-[13px] text-ink hover:bg-ink/[0.06]">
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {count !== undefined && <span className="text-[12px] text-ink-tertiary tabular-nums">{count}</span>}
        <ChevronDown size={14} aria-hidden="true" className={cn("shrink-0 text-ink-tertiary transition-transform duration-[120ms] motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      <div id={id} hidden={!open} className="px-1 pb-3 text-[13px] leading-relaxed text-ink-secondary">{children}</div>
    </div>
  );
}

const textBlock = (value: string) => <p dir="auto" className="whitespace-pre-wrap break-words">{value}</p>;

/** What a template brings, one expandable row per part, nothing to tick. */
export function TemplateDetailsBody({ details }: { details: TemplateDetails }) {
  const withInstructions = details.bots.filter((bot) => bot.instructions?.trim() || bot.description?.trim());
  return (
    <div data-template-details-body>
      {details.summary && <p dir="auto" className="mb-3 text-[13px] leading-relaxed text-ink-secondary">{details.summary}</p>}
      <ul className="mb-3 flex flex-col gap-2">
        {details.bots.map((bot) => (
          <li key={bot.key} className="flex min-w-0 items-center gap-2.5">
            <Face avatar={{ key: bot.key, name: bot.name, color: bot.color, ...(bot.picture ? { picture: bot.picture } : {}) }} size={28} />
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate text-[13px] font-medium text-ink">{bot.name}{bot.lead && <span className="ms-1.5 font-normal text-ink-tertiary">{t("template.lead")}</span>}</span>
              {bot.title && <span dir="auto" className="block truncate text-[12px] text-ink-tertiary">{bot.title}</span>}
            </span>
          </li>
        ))}
      </ul>
      {withInstructions.length > 0 && <Disclosure label={t("template.row.instructions")}>
        {withInstructions.map((bot) => <div key={bot.key} className="mt-2 first:mt-0">
          {details.bots.length > 1 && <div dir="auto" className="font-medium text-ink">{bot.name}</div>}
          {textBlock([bot.description, bot.instructions].filter((part) => part?.trim()).join("\n\n"))}
        </div>)}
      </Disclosure>}
      {details.skills.length > 0 && <Disclosure label={t("template.row.skills")} count={details.skills.length}>
        <ul className="flex flex-col gap-1.5">{details.skills.map((skill) => <li key={skill.name}><span className="font-medium text-ink">{skill.name}</span>{skill.description && <span dir="auto"> · {skill.description}</span>}</li>)}</ul>
      </Disclosure>}
      {details.routines.length > 0 && <Disclosure label={t("template.row.routines")} count={details.routines.length}>
        <ul className="flex flex-col gap-2">{details.routines.map((routine, index) => <li key={`${routine.name}-${index}`}>
          <div dir="auto" className="font-medium text-ink">{routine.name} <span className="font-normal text-ink-tertiary">· {routine.bot}</span></div>
          {textBlock(routine.prompt)}
        </li>)}</ul>
      </Disclosure>}
      {details.apps.length > 0 && <Disclosure label={t("template.row.apps")} count={details.apps.length}>
        <ul className="flex flex-col gap-1">{details.apps.map((app, index) => <li key={`${app.label}-${index}`} dir="auto"><span className="font-medium text-ink">{app.label}</span>{app.reason && ` · ${app.reason}`}</li>)}</ul>
      </Disclosure>}
      {details.groupChats.length > 0 && <Disclosure label={t("template.row.groupChats")} count={details.groupChats.length}>
        <ul className="flex flex-col gap-1">{details.groupChats.map((room, index) => <li key={`${room.name}-${index}`} dir="auto"><span className="font-medium text-ink">{room.name}</span> · {room.members.join(", ")}</li>)}</ul>
      </Disclosure>}
      {details.brief?.trim() && <Disclosure label={t("template.row.brief")}>{textBlock(details.brief)}</Disclosure>}
      <p className="mt-3 text-[12px] text-ink-tertiary">{t("template.arrives")}</p>
    </div>
  );
}

/** A modal frame: title, a scrolling body and a footer. Escape and a click outside close it. */
export function TemplateModal({ title, onClose, children, footer, labelledBy }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; labelledBy: string;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalDialog(dialogRef, onClose);
  return createPortal(
    <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}
        className="ui-modal flex max-h-full w-full max-w-[480px] flex-col text-ink shadow-2xl outline-none animate-pop-in motion-reduce:animate-none">
        <header className="px-5 pb-2 pt-4">
          <h2 id={labelledBy} className="min-w-0 truncate text-[17px] font-semibold">{title}</h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 px-5 pb-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** The read-only Details sheet for a template this app made. */
export function TemplateDetailsSheet({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [details, setDetails] = useState<TemplateDetails | null>(null);
  const [error, setError] = useState("");
  const titleId = useId();
  useEffect(() => {
    let live = true;
    templateDetails(id).then((answer) => { if (live) setDetails(answer.details); },
      (cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : t("template.failed")); });
    return () => { live = false; };
  }, [id]);
  return (
    <TemplateModal title={name} labelledBy={titleId} onClose={onClose}
      footer={<button type="button" className="ui-button ui-button-md" onClick={onClose}>{t("common.close")}</button>}>
      {details ? <TemplateDetailsBody details={details} />
        : error ? <p role="alert" className="text-[13px] text-danger">{error}</p>
        : <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{t("template.loading")}</p>}
    </TemplateModal>
  );
}

/** Share's second GitHub target: the person's own repository, through the GitHub connection in Apps. A pull request from
 * a new branch, or one commit on the default branch when they tick it. */

/** `missing`: connect GitHub in Apps; `refused`: the server's own sentence (the team's Rules, Apps unreachable, no access). */
type Connection = { state: "checking" } | { state: "connected" } | { state: "missing" } | { state: "refused"; error: string };

const repoField = "h-8 w-full min-w-0 rounded-lg border border-hairline bg-inset px-2.5 text-[13px] text-ink focus:border-focus focus:outline-none";
const repoSpinner = <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;

export function TemplateRepoPublishDialog({ card, onClose }: { card: Pick<TemplateCard, "id" | "name">; onClose: () => void }) {
  const { dispatch } = useStore();
  const [connection, setConnection] = useState<Connection>({ state: "checking" });
  const [repo, setRepo] = useState("");
  const [folder, setFolder] = useState("");
  const [direct, setDirect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<TemplateRepoPublish | null>(null);
  const titleId = useId(), repoId = useId(), folderId = useId();

  useEffect(() => {
    let live = true;
    githubConnection().then((answer) => {
      if (!live) return;
      setConnection(answer.connected ? { state: "connected" } : answer.reason === "not_connected" || !answer.error ? { state: "missing" } : { state: "refused", error: answer.error });
    }, (cause: unknown) => { if (live) setConnection({ state: "refused", error: cause instanceof Error && cause.message ? cause.message : t("template.failed") }); });
    return () => { live = false; };
  }, []);

  const publish = async () => {
    if (busy || !repo.trim()) return;
    setBusy(true);
    setError("");
    try {
      setDone(await publishToRepo(card.id, { repo: repo.trim(), ...(folder.trim() ? { folder: folder.trim() } : {}), direct }));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("template.failed"));
    } finally {
      setBusy(false);
    }
  };

  const openApps = () => {
    dispatch({ type: "togglePlugins", open: true });
    onClose();
  };

  const footer = done ? <>
    <button type="button" className="ui-button ui-button-md" onClick={onClose}>{t("common.close")}</button>
    <button type="button" className="ui-button ui-button-md ui-button-primary" onClick={() => void openExternalLink(done.url).catch(() => {})}>
      <ArrowUpRight size={14} aria-hidden="true" />{t(done.kind === "pull_request" ? "template.viewPullRequest" : "template.viewOnGithub")}
    </button>
  </> : connection.state === "missing" ? <>
    <button type="button" className="ui-button ui-button-md" onClick={onClose}>{t("common.cancel")}</button>
    <button type="button" data-template-open-apps className="ui-button ui-button-md ui-button-primary" onClick={openApps}>{t("template.repo.openApps")}</button>
  </> : connection.state === "refused" ? (
    <button type="button" className="ui-button ui-button-md" onClick={onClose}>{t("common.close")}</button>
  ) : <>
    <button type="button" className="ui-button ui-button-md" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
    <button type="submit" form={titleId} data-template-repo-publish className="ui-button ui-button-md ui-button-primary" disabled={busy || connection.state !== "connected" || !repo.trim()}>
      {busy && repoSpinner}{t(busy ? "template.repo.working" : direct ? "template.repo.commit" : "template.repo.openPullRequest")}
    </button>
  </>;

  return (
    <TemplateModal title={t("template.repo.title")} labelledBy={`${titleId}-title`} onClose={() => { if (!busy) onClose(); }} footer={footer}>
      <div data-template-repo={card.id}>
        {done ? (
          <p role="status" dir="auto" className="text-[13px] text-ink-secondary">{t(done.kind === "pull_request" ? "template.repo.pullRequestOpened" : "template.repo.committed", { branch: done.branch })}</p>
        ) : connection.state === "checking" ? (
          <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary">{repoSpinner}{t("template.repo.checking")}</p>
        ) : connection.state === "missing" ? (
          <p role="alert" dir="auto" className="text-[13px] text-ink-secondary">{t("template.repo.connectFirst")}</p>
        ) : connection.state === "refused" ? (
          <p role="alert" dir="auto" className="text-[13px] text-ink-secondary">{connection.error}</p>
        ) : (
          <form id={titleId} onSubmit={(event) => { event.preventDefault(); void publish(); }} className="flex flex-col gap-3">
            <div>
              <label htmlFor={repoId} className="text-[13px] font-medium text-ink">{t("template.repo.repoLabel")}</label>
              <input id={repoId} dir="ltr" autoFocus value={repo} onChange={(event) => setRepo(event.target.value)} placeholder={t("template.repo.repoPlaceholder")} spellCheck={false} className={`mt-1.5 ${repoField}`} />
            </div>
            <div>
              <label htmlFor={folderId} className="text-[13px] font-medium text-ink">{t("template.repo.folderLabel")}</label>
              <input id={folderId} dir="ltr" value={folder} onChange={(event) => setFolder(event.target.value)} spellCheck={false} className={`mt-1.5 ${repoField}`} />
            </div>
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={direct} onChange={(event) => setDirect(event.target.checked)} />{t("template.repo.direct")}
            </label>
            <p className="text-[12px] text-ink-tertiary">{t("template.repo.note")}</p>
          </form>
        )}
        {error && <p role="alert" dir="auto" className="mt-3 text-[13px] text-danger">{error}</p>}
      </div>
    </TemplateModal>
  );
}
