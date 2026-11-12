import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Monitor } from "lucide-react";

import { usePageVisible } from "@/lib/page-visible";
import { remoteScreenshotSource } from "@/lib/remote-desktop";
import { t } from "@/lib/i18n";
import { api, useStore, type Bot } from "@/state/store";
import type { CloudBackend } from "../../shared/wire";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";

type WatchStatus = {
  configured: boolean;
  ready?: boolean;
  box?: { state?: string } | null;
  container?: string;
  problem?: string | null;
};
type WatchTarget = CloudBackend | "vm";

const BOAT_READY = new Set(["idle", "ready", "running"]);

export function ComputerWatchGallery({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const pageVisible = usePageVisible();
  const [open, setOpen] = useState(false);
  const [targetBotId, setTargetBotId] = useState(bot.id);
  const [backend, setBackend] = useState<WatchTarget>(bot.cloudBackend === "vps" ? "box" : "vps");
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibleBots = state.bots.filter((candidate) => !candidate.hidden);
  const targetBot = visibleBots.find((candidate) => candidate.id === targetBotId);

  useEffect(() => {
    if (!open || !pageVisible || !targetBot) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(null);
    setFrame(null);
    setError(null);
    const poll = async () => {
      try {
        const path = `/api/bots/${encodeURIComponent(targetBotId)}/${backend === "vm" ? "local-computer" : `computer?watchBackend=${backend}`}`;
        const latest: WatchStatus = await api(path, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        });
        if (controller.signal.aborted) return;
        setStatus(latest);
        const ready = backend === "vps" || backend === "vm" ? latest.ready === true : BOAT_READY.has(latest.box?.state ?? "");
        if (ready) {
          const shotPath = `/api/bots/${encodeURIComponent(targetBotId)}/${backend === "vm" ? "local-computer/screenshot" : `computer/screenshot?watchBackend=${backend}`}`;
          const screenshot = await api(shotPath, {
            method: "POST", body: "{}", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
          });
          if (controller.signal.aborted) return;
          const source = backend === "vm"
            ? typeof screenshot?.image === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(screenshot.image) ? screenshot.image : null
            : remoteScreenshotSource(screenshot);
          if (!source) throw new Error(t("computer.err.emptyFrame"));
          setFrame(source);
        } else {
          setFrame(null);
        }
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, targetBot.busy ? 4_000 : 30_000);
      }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, pageVisible, targetBotId, targetBot?.busy, backend]);

  if (ownerOrAdmin === false || visibleBots.length === 0) return null;
  return <section className="mt-3 rounded-xl border border-hairline/40 bg-card p-3" data-testid="computer-watch-gallery">
    <button type="button" className="flex w-full items-center justify-between gap-2 text-left text-[13px] font-medium text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="flex items-center gap-2"><Monitor size={15} aria-hidden="true" />{t("computer.watchGallery.title")}</span>
      {open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
    </button>
    {open && <div className="mt-3 space-y-2">
      <p className="text-[11px] leading-4 text-ink-secondary">{t("computer.watchGallery.hint")}</p>
      <div className="flex gap-2">
        <label className="min-w-0 flex-1 text-[11px] text-ink-secondary">{t("computer.watchGallery.bot")}
          <select className="mt-1 w-full rounded-md bg-inset px-2 py-1.5 text-[12px] text-ink" value={targetBotId} onChange={(event) => setTargetBotId(event.target.value)}>
            {visibleBots.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-[11px] text-ink-secondary">{t("computer.watchGallery.computer")}
          <select className="mt-1 w-full rounded-md bg-inset px-2 py-1.5 text-[12px] text-ink" value={backend} onChange={(event) => setBackend(event.target.value as WatchTarget)}>
            <option value="box">{t("botAccess.cloud.boat")}</option>
            <option value="vps">{t("botAccess.cloud.selfHostedVps")}</option>
            <option value="vm">{t("vm.dest.vm")}</option>
          </select>
        </label>
      </div>
      <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg bg-black text-center text-[12px] text-white/70">
        {frame ? <img src={frame} alt={t("computer.screenOf", { name: targetBot?.name ?? bot.name })} className="size-full object-contain" />
          : status === null && !error ? <Loader2 size={18} className="animate-spin" aria-label={t("computer.phase.checking")} />
          : <span className="px-4">{error ?? (status?.configured === false ? t("computer.watchGallery.notConfigured")
            : status?.problem ?? (status?.box?.state || status?.container || t("computer.watchGallery.notReady")))}</span>}
      </div>
      {frame && <p className="text-[11px] text-ink-secondary">{t("computer.watchGallery.readOnly")}</p>}
    </div>}
  </section>;
}
