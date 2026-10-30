import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FileText, Folder, MessagesSquare, Users, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { closeRoomPanel } from "@/lib/room-panel";
import { responderShortLabel } from "@/lib/room-responder";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot, type Group } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { useCaptionChrome } from "../DesktopCapabilities";
import { ManageMembersPanel } from "../ManageMembersPanel";
import { useBulletinEditor } from "../RoomBulletin";
import { RoomMoreMenu } from "../RoomMoreMenu";
import { RoomWorkingFolder, roomWorkingFolder } from "../RoomWorkingFolder";
import { buttonCls, Card, ColRow, NavRow, PageHeader, roundButtonCls, rowCls, RowText } from "../bot-panel/rows";
import { sidePanelCls } from "../bot-panel/side-panel";
import { ResponderPage } from "./ResponderPage";

type RoomPage = "responder" | "folder";

const PAGES: Record<RoomPage, { title: LocaleKey; intro: LocaleKey }> = {
  responder: { title: "room.panel.whoResponds", intro: "room.panel.responder.intro" },
  folder: { title: "room.folder.title", intro: "room.folder.detail" },
};

function RoomHero({ group, members }: { group: Group; members: Bot[] }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div data-room-panel-faces className="mt-0.5 flex -space-x-3">
        {members.slice(0, 3).map((member) => (
          <BotAvatar key={member.id} bot={member} state="happy" size={52} animated={false} />
        ))}
      </div>
      <h2 id="room-panel-title" className="mt-2.5 max-w-full truncate px-1.5 text-[18px] font-semibold text-ink">{group.name}</h2>
      {group.description && <p className="mt-px line-clamp-2 max-w-full text-[13px] text-ink-secondary">{group.description}</p>}
    </div>
  );
}

function InstructionsRow({ group }: { group: Group }) {
  const bulletin = useBulletinEditor(group);
  const editRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (bulletin.open || !refocus.current) return;
    refocus.current = false;
    editRef.current?.focus();
  }, [bulletin.open]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) refocus.current = true;
    bulletin.onKeyDown(event);
  };

  if (bulletin.open) {
    return (
      <ColRow data-panel-row="instructions">
        <RowText title={t("room.panel.instructions")} />
        <textarea
          autoFocus
          dir="auto"
          aria-label={t("room.panel.instructions")}
          value={bulletin.draft}
          onChange={(event) => bulletin.setDraft(event.target.value)}
          onBlur={bulletin.save}
          onKeyDown={onKeyDown}
          placeholder={t("room.bulletin.placeholder")}
          rows={6}
          className="w-full resize-y rounded-lg border border-hairline bg-inset px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border"
        />
        <div className="flex justify-end">
          <button
            type="button"
            data-panel-done="instructions"
            // Keeps the field focused, so its blur does not save before Done does.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              refocus.current = true;
              bulletin.save();
            }}
            className={buttonCls}
          >
            {t("botSettings.simple.done")}
          </button>
        </div>
      </ColRow>
    );
  }
  const firstLine = group.bulletin.split("\n")[0]?.trim();
  return (
    <button
      ref={editRef}
      type="button"
      data-panel-edit="instructions"
      aria-label={`${t("botSettings.simple.edit")}: ${t("room.panel.instructions")}`}
      onClick={bulletin.start}
      className={cn(rowCls, "w-full text-left hover:bg-ink/[0.03]")}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] text-ink-secondary max-md:size-8 max-md:rounded-full" aria-hidden="true">
        <FileText size={15} />
      </span>
      <RowText
        title={t("room.panel.instructions")}
        hint={<span dir="auto" className="line-clamp-1">{firstLine || t("room.panel.instructionsHint")}</span>}
      />
      <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
    </button>
  );
}

export function RoomPanel({ group, overlay = false }: { group: Group; overlay?: boolean }) {
  const { state } = useStore();
  const { padClass, dragProps } = useCaptionChrome();
  const [page, setPage] = useState<RoomPage | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const membersRowRef = useRef<HTMLButtonElement>(null);
  const leftPage = useRef<RoomPage | null>(null);
  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot)),
    [group.memberIds, state.bots],
  );
  const folder = roomWorkingFolder(group);
  const closeMembers = useCallback(() => setMembersOpen(false), []);

  const openPage = (next: RoomPage) => {
    setPage(next);
    bodyRef.current?.scrollTo({ top: 0 });
  };
  const back = () => {
    leftPage.current = page;
    setPage(null);
  };

  // The row or Back button that was pressed is gone with the view it sat in: focus moves to its counterpart, so the
  // next Escape still lands in the panel.
  useEffect(() => {
    if (page !== null) {
      bodyRef.current?.querySelector<HTMLElement>("[data-panel-back]")?.focus();
    } else if (leftPage.current) {
      bodyRef.current?.querySelector<HTMLElement>(`[data-panel-page="${leftPage.current}"]`)?.focus();
      leftPage.current = null;
    }
  }, [page]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      event.preventDefault();
      closeRoomPanel({ refocus: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || page === null) return;
    event.preventDefault();
    event.stopPropagation();
    back();
  };

  return (
    <>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-labelledby="room-panel-title"
        tabIndex={-1}
        data-room-panel
        onKeyDown={onKeyDown}
        className={sidePanelCls(overlay, true)}
      >
        <div {...dragProps} className={cn("flex h-[52px] shrink-0 items-center justify-end gap-2 px-3.5", padClass)}>
          <RoomMoreMenu group={group} />
          <button type="button" onClick={() => closeRoomPanel({ refocus: true })} aria-label={t("botSettings.simple.close")} className={roundButtonCls}>
            <X size={16} className="pointer-events-none" />
          </button>
        </div>

        <div ref={bodyRef} className="@container relative min-h-0 flex-1 overflow-y-auto px-5 pb-7">
          {page === null ? (
            <>
              <RoomHero group={group} members={members} />
              <Card>
                <NavRow
                  data-panel-page="responder"
                  icon={MessagesSquare}
                  title={t("room.panel.whoResponds")}
                  value={responderShortLabel(group, members)}
                  onClick={() => openPage("responder")}
                />
                <NavRow
                  data-panel-page="folder"
                  icon={Folder}
                  title={t("room.folder.title")}
                  value={folder?.name ?? t("room.panel.folder.own")}
                  tooltip={folder?.path}
                  onClick={() => openPage("folder")}
                />
                <InstructionsRow group={group} />
                <NavRow
                  ref={membersRowRef}
                  data-panel-row="members"
                  icon={Users}
                  title={t("room.panel.members")}
                  value={String(members.length)}
                  onClick={() => setMembersOpen(true)}
                />
              </Card>
            </>
          ) : (
            <div data-panel-page-view={page}>
              <span id="room-panel-title" className="sr-only">{group.name}</span>
              <PageHeader back={group.name} title={t(PAGES[page].title)} intro={t(PAGES[page].intro)} onBack={back} />
              <div className="mt-4 flex flex-col gap-3">
                {page === "responder" ? <ResponderPage group={group} members={members} /> : <RoomWorkingFolder group={group} heading={false} />}
              </div>
            </div>
          )}
        </div>
      </aside>
      {membersOpen && createPortal(
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersRowRef} />,
        document.body,
      )}
    </>
  );
}
