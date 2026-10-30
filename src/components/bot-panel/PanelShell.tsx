import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Settings, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot, BotSettingsSection } from "@/state/store";
import { ChatShareMenu } from "@/components/ChatMoreMenu";
import { useCaptionChrome } from "../DesktopCapabilities";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { AvatarEditorCard } from "./AvatarEditorCard";
import { ComputerTab } from "./ComputerTab";
import { DetailsTab } from "./DetailsTab";
import { LibraryTab } from "./LibraryTab";
import { PANEL_TABS, PAGES, TAB_LABEL, type PanelTab, type PanelTarget, type SimplePageId } from "./page-registry";
import { PageBody, pageSurfaceCls } from "./pages";
import { linkTarget, usePanelLink, type PanelLink } from "./panel-link";
import { PanelHero } from "./PanelHero";
import { PageHeader, roundButtonCls } from "./rows";

function initialTarget(section: BotSettingsSection | null, link: PanelLink | null): PanelTarget {
  return section ? linkTarget(section, link) : { tab: "details" };
}

export function BotPanel({ bot, derived, headerClassName, linkedSection, onClose }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  headerClassName?: string;
  linkedSection: BotSettingsSection | null;
  onClose: () => void;
}) {
  const { dragProps } = useCaptionChrome();
  const link = usePanelLink();
  const [tab, setTab] = useState<PanelTab>(() => initialTarget(linkedSection, link).tab);
  const [stack, setStack] = useState<SimplePageId[]>(() => {
    const page = initialTarget(linkedSection, link).page;
    return page ? [page] : [];
  });
  const [anchor, setAnchor] = useState<string | null>(() => initialTarget(linkedSection, link).anchor ?? null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingInstructions, setEditingInstructions] = useState(() => Boolean(initialTarget(linkedSection, link).editInstructions));
  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const page = stack.at(-1) ?? null;

  const scrollTop = () => bodyRef.current?.scrollTo({ top: 0 });
  const go = (target: PanelTarget) => {
    setTab(target.tab);
    setStack(target.page ? [target.page] : []);
    setAnchor(target.anchor ?? null);
    setEditorOpen(false);
    setEditingInstructions(Boolean(target.editInstructions));
    scrollTop();
  };
  const openTab = (next: PanelTab) => go({ tab: next });
  const openPage = (next: SimplePageId) => {
    setStack((current) => [...current, next]);
    setEditorOpen(false);
    scrollTop();
  };
  const closeEditor = () => {
    setEditorOpen(false);
    // The card held focus: hand it back to the avatar that opened it, before the card goes, not to the page body.
    editorRef.current?.querySelector<HTMLElement>("[data-panel-avatar]")?.focus();
  };
  const back = () => {
    setStack((current) => current.slice(0, -1));
    scrollTop();
  };

  // A new link re-runs this even when it names the section already linked, so a repeated link lands there again.
  useEffect(() => {
    if (linkedSection) go(linkTarget(linkedSection, link));
  }, [linkedSection, link]);

  useEffect(() => {
    if (!anchor) return;
    bodyRef.current?.querySelector(`[data-panel-card="${anchor}"]`)?.scrollIntoView({ block: "start" });
    setAnchor(null);
  }, [anchor, page, tab]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as Partial<Element> | null;
    const inDialog = typeof target?.closest === "function" ? target.closest('[role="dialog"], [role="alertdialog"]') : null;
    // A dialog of its own (one this panel opened, perhaps portaled) owns its Escape; the settings dialog this panel
    // sits in, and the avatar editor, do not.
    const ownDialog = inDialog && !inDialog.contains(event.currentTarget) && inDialog !== editorRef.current && !editorRef.current?.contains(inDialog);
    if (ownDialog) return;
    if (editorOpen) closeEditor();
    else if (stack.length > 0) back();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const backLabel = stack.length > 1 ? t(PAGES[stack[stack.length - 2]!].title, { name: bot.name }) : t(TAB_LABEL[tab]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div {...dragProps} className={cn("flex h-[50px] shrink-0 items-start justify-end gap-2.5 px-[13px] pt-[13px]", headerClassName)}>
        <ChatShareMenu bot={bot} className={roundButtonCls} />
        <button
          type="button"
          data-panel-gear
          aria-label={t("botPanel.page.settings")}
          title={t("botPanel.page.settings")}
          aria-current={page === "settings" ? "page" : undefined}
          onClick={() => go({ tab: "details", page: "settings" })}
          className={roundButtonCls}
        >
          <Settings size={16} className="pointer-events-none" />
        </button>
        <button type="button" onClick={onClose} aria-label={t("botSettings.simple.close")} className={roundButtonCls}>
          <X size={16} className="pointer-events-none" />
        </button>
      </div>

      <div ref={bodyRef} className="@container relative min-h-0 flex-1 overflow-y-auto px-4 pb-7">
        {page === null ? (
          <>
            <div className="relative mt-3.5" ref={editorRef}>
              <PanelHero
                bot={bot}
                activeState={derived.activeState}
                patch={derived.patch}
                editorOpen={editorOpen}
                onToggleEditor={() => setEditorOpen((open) => !open)}
              />
              {editorOpen && (
                <>
                  <div className="fixed inset-0 z-20" aria-hidden="true" data-panel-scrim onClick={closeEditor} />
                  <AvatarEditorCard bot={bot} activeState={derived.activeState} onPatch={derived.patch} onClose={closeEditor} />
                </>
              )}
            </div>
            <div
              role="tablist"
              aria-label={t("botSettings.simple.tabs")}
              className="sticky top-0 z-[1] -mx-4 mt-[15px] flex justify-center gap-0.5 bg-app px-4 pb-2.5 pt-1 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-linear-to-b after:from-app after:to-transparent"
            >
              {PANEL_TABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  data-panel-tab={id}
                  onClick={() => openTab(id)}
                  className={cn(
                    "h-[26px] min-w-0 shrink truncate rounded-full px-2 text-[13px] leading-[18px] transition-colors",
                    tab === id ? "bg-ink/[0.07] text-ink" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {t(TAB_LABEL[id])}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === "details" && <DetailsTab bot={bot} derived={derived} onOpen={openPage} />}
              {tab === "library" && <LibraryTab bot={bot} onOpen={openPage} />}
              {tab === "computer" && <ComputerTab bot={bot} derived={derived} onOpen={openPage} />}
            </div>
          </>
        ) : (
          <div data-panel-page-view={page}>
            <span id="bot-settings-title" className="sr-only">{bot.name}</span>
            <PageHeader
              back={backLabel}
              title={t(PAGES[page].title, { name: bot.name })}
              intro={PAGES[page].intro ? t(PAGES[page].intro, { name: bot.name }) : undefined}
              onBack={back}
            />
            <div className={cn("mt-4", pageSurfaceCls)}>
              <PageBody
                page={page}
                bot={bot}
                derived={derived}
                onOpen={openPage}
                editingInstructions={editingInstructions}
                onEditInstructions={setEditingInstructions}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
