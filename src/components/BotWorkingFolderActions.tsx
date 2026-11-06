import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, FolderOpen, LoaderCircle } from "lucide-react";
import type { BotWorkingFolder } from "../../shared/bot-working-folder";
import { api, type Bot } from "@/state/store";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { MENU_ITEM } from "./menu-recipe";
import { NoticeToast } from "./NoticeCard";

type Props = { bot: Pick<Bot, "id" | "cwd" | "computer">; menu?: boolean; onOpened?: () => void; className?: string };

export function BotWorkingFolderActions(props: Props) {
  const { bot } = props;
  return <WorkingFolderActions key={JSON.stringify([bot.id, bot.cwd, bot.computer])} {...props} />;
}

function WorkingFolderActions({ bot, menu = false, onOpened, className }: Props) {
  const [folder, setFolder] = useState<BotWorkingFolder | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    void api<BotWorkingFolder>(`/api/bots/${bot.id}/working-folder`)
      .then((value) => { if (active.current) setFolder(value); })
      .catch(() => { if (active.current) setFeedback(t("botFolder.loadFailed")); });
    return () => { active.current = false; };
  }, [bot.id]);

  const reveal = window.ogb?.remoteClient?.active ? undefined : window.ogb?.revealInFolder;
  const local = Boolean(folder?.path && folder.local && reveal);
  const open = async () => {
    if (!local || !reveal || pending.current) return;
    pending.current = true;
    setBusy(true);
    setFeedback("");
    try {
      const prepared = await api<BotWorkingFolder>(`/api/bots/${bot.id}/working-folder`, { method: "POST", body: "{}" });
      if (!active.current) return;
      if (!prepared.local || !prepared.path || await reveal(prepared.path) !== "shown") {
        if (active.current) setFeedback(t("botFolder.openFailed"));
      } else if (active.current) {
        onOpened?.();
      }
    } catch {
      if (active.current) setFeedback(t("botFolder.openFailed"));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  const copy = async () => {
    if (!folder?.path) return;
    const result = await copyText(folder.path);
    if (active.current) setFeedback(t(result === "copied" ? "botFolder.copied" : "botFolder.copyFailed"));
  };
  const title = folder?.path ?? t("botFolder.unavailable");
  const cls = `${menu ? MENU_ITEM : className ?? "rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"} disabled:opacity-40`;
  return <>
    {local && <button type="button" role={menu ? "menuitem" : undefined} className={cls} disabled={busy} aria-busy={busy || undefined} title={title} aria-label={t("botFolder.openLocal")} onClick={() => { void open(); }}>
      {busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <FolderOpen size={16} aria-hidden="true" />}{menu && t("botFolder.open")}
    </button>}
    {!local && folder?.path && <button type="button" role={menu ? "menuitem" : undefined} className={cls} title={title} aria-label={t("botFolder.copyLabel")} onClick={() => { void copy(); }}>
      {feedback === t("botFolder.copied") ? <Check size={16} className="text-success" aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{menu && t("botFolder.copy")}
    </button>}
    {feedback && createPortal(<NoticeToast text={feedback} onDone={() => setFeedback("")} />, document.body)}
  </>;
}
