import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { InkboxSetupInput, InkboxSetupSnapshot } from "../../shared/inkbox-setup";
import { Card } from "./SettingsPrimitives";

const endpoint = "/api/inkbox/setup";
const inputStyle = "mt-1 w-full rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink disabled:opacity-50";
const buttonStyle = "rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70 disabled:opacity-40";

export function InkboxSetupSection() {
  const { state } = useStore();
  const [snapshot, setSnapshot] = useState<InkboxSetupSnapshot | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [bot, setBot] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [action, setAction] = useState<"connect" | "reconnect" | "disconnect">("connect");
  const active = useRef(false);
  const revision = useRef(0);
  const pending = useRef<"connect" | "reconnect" | "disconnect" | null>(null);
  const bots = (state.bots ?? []).filter(bot => !bot.hidden);
  const botId = bots.some(item => item.id === bot) ? bot : bots[0]?.id ?? "";

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (pending.current || reading) return;
      reading = true;
      const current = revision.current;
      try {
        const result = await api<InkboxSetupSnapshot>(endpoint, { signal: controller.signal, timeoutMs: 15000 });
        if (active.current && current === revision.current) { setSnapshot(result); setReadError(""); }
      } catch {
        if (!controller.signal.aborted && active.current && current === revision.current) setReadError(t("inkbox.loadError"));
      } finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { active.current = false; revision.current++; controller.abort(); clearInterval(timer); };
  }, []);

  useEffect(() => { setCopyState("idle"); }, [snapshot?.pairing?.connectText]);

  const run = async (action: "connect" | "reconnect" | "disconnect", input?: InkboxSetupInput) => {
    if (pending.current && (action !== "disconnect" || pending.current === "disconnect")) return;
    pending.current = action;
    const current = ++revision.current;
    setBusy(true); setAction(action); setError(""); setReadError("");
    // Keep the submitted key only in the request, never in the mounted form.
    if (action === "connect") setApiKey("");
    try {
      const result = await api<InkboxSetupSnapshot>(action === "connect" ? endpoint : `${endpoint}/${action}`, {
        method: "POST", ...(input ? { body: JSON.stringify(input) } : {}), timeoutMs: 90000,
      });
      if (active.current && current === revision.current) { setSnapshot(result); setReplacing(false); }
    } catch (cause) {
      if (active.current && current === revision.current) setError(cause instanceof Error ? cause.message : t("inkbox.requestError"));
    } finally {
      if (current === revision.current) {
        pending.current = null;
        if (active.current) setBusy(false);
      }
    }
  };

  if (!snapshot) return <p role={readError ? "alert" : "status"} className="text-sm text-ink-secondary">{readError || t("inkbox.loading")}</p>;
  if (!snapshot.available) return <Card title={t("settings.section.inkbox")}><p className="text-sm text-ink-secondary">{t("inkbox.desktopRequired")}</p></Card>;
  const working = busy || snapshot.phase === "setting_up" || snapshot.phase === "connecting";
  const pairing = (snapshot.phase === "awaiting_phone" || snapshot.phase === "connected") ? snapshot.pairing : undefined;
  const smsLink = pairing && /^sms:\+[1-9]\d{6,14}(?:(?:\?&?|&)body=[^\s#]*)?$/.test(pairing.smsLink) ? pairing.smsLink : undefined;
  const displayError = error || readError || snapshot.error;
  const showForm = replacing || (!snapshot.canReconnect && (!snapshot.botId || snapshot.phase === "disconnected"));
  const canDisconnect = (snapshot.botId && snapshot.phase !== "disconnected") || (busy && action !== "disconnect");
  return <div className="space-y-4">
    <p className="text-sm text-ink-secondary">{t("inkbox.intro")}</p>
    {displayError && <p role="alert" className="rounded-lg border border-red-500/30 p-3 text-sm text-red-500">{displayError}</p>}
    <Card title={t("inkbox.connection")}>
      <div role="status" aria-live="polite" className="space-y-2 text-sm">
        <p className="font-medium">{busy ? t(action === "disconnect" ? "inkbox.disconnecting" : "inkbox.working") : t(`inkbox.phase.${snapshot.phase}`)}</p>
        {snapshot.botId && <p className="text-ink-secondary">{t("inkbox.bot")}: {bots.find(bot => bot.id === snapshot.botId)?.name ?? t("inkbox.unavailableBot")}</p>}
        {snapshot.ownerPhone && <p className="text-ink-secondary">{t("inkbox.phone")}: {snapshot.ownerPhone}</p>}
        {snapshot.botId && snapshot.approvalMode && <><p className="text-ink-secondary">{t("inkbox.approvals")}: {t(snapshot.approvalMode === "auto" ? "inkbox.approvalsAuto" : "inkbox.approvalsAsk")}</p><p className="text-xs text-ink-secondary">{t("inkbox.approvalsHelp")}</p></>}
        {snapshot.phase === "awaiting_phone" && <p className="text-ink-secondary">{t("inkbox.awaitingNote")}</p>}
        {snapshot.phase === "connected" && <p className="text-ink-secondary">{t("inkbox.connectedNote")}</p>}
      </div>
      {showForm && <form className="mt-4" onSubmit={event => {
        event.preventDefault();
        if (!working && apiKey.trim() && botId && /^\+[1-9]\d{6,14}$/.test(phone.trim())) void run("connect", { apiKey: apiKey.trim(), botId, ownerPhone: phone.trim() });
      }}>
        <fieldset disabled={working} className="space-y-3">
          <label className="block text-xs text-ink-secondary">{t("inkbox.apiKey")}<input aria-label={t("inkbox.apiKey")} className={inputStyle} type="password" autoComplete="off" spellCheck={false} required value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
          <p className="text-xs text-ink-secondary">{t("inkbox.keyNote")}</p>
          <a href="https://inkbox.ai/console" target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-accent underline underline-offset-2">{t("inkbox.getKey")}</a>
          <label className="block text-xs text-ink-secondary">{t("inkbox.bot")}<select aria-label={t("inkbox.bot")} className={inputStyle} value={botId} required onChange={event => setBot(event.target.value)}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
          {!bots.length && <p className="text-sm text-ink-secondary">{t("inkbox.noBots")}</p>}
          <label className="block text-xs text-ink-secondary">{t("inkbox.phone")}<input aria-label={t("inkbox.phone")} className={inputStyle} type="tel" autoComplete="tel" placeholder="+919876543210" pattern="\+[1-9][0-9]{6,14}" required value={phone} onChange={event => setPhone(event.target.value)} /></label>
          <p className="text-xs text-ink-secondary">{t("inkbox.phoneNote")}</p>
          <button className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40" disabled={working || !botId || !apiKey.trim() || !/^\+[1-9]\d{6,14}$/.test(phone.trim())}>{working ? t("inkbox.working") : t("inkbox.connect")}</button>
        </fieldset>
      </form>}
      {(snapshot.botId || canDisconnect) && <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {snapshot.canReconnect && (snapshot.phase === "disconnected" || snapshot.phase === "error") && <button className={buttonStyle} disabled={working} onClick={() => void run("reconnect")}>{t("inkbox.reconnect")}</button>}
          {canDisconnect && <button className={buttonStyle} disabled={busy && action === "disconnect"} onClick={() => void run("disconnect")}>{t("inkbox.disconnect")}</button>}
          {snapshot.phase === "disconnected" && snapshot.canReconnect && !replacing && <button className={buttonStyle} disabled={working} onClick={() => { setReplacing(true); setBot(snapshot.botId ?? ""); setPhone(snapshot.ownerPhone ?? ""); }}>{t("inkbox.replace")}</button>}
        </div>
        <p className="text-xs text-ink-secondary">{t(snapshot.canReconnect ? "inkbox.disconnectNote" : "inkbox.incompleteNote")}</p>
      </div>}
    </Card>
    {pairing && <Card title={t("inkbox.pairPhone")} subtitle={t("inkbox.pairNote")}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {smsLink && <div className="w-fit shrink-0 rounded-xl bg-white p-3"><QRCodeSVG role="img" aria-label={t("inkbox.qrLabel")} value={smsLink} size={168} level="M" /></div>}
        <div className="min-w-0 space-y-3 text-sm">
          <p>{t("inkbox.sendTo", { number: pairing.number })}</p>
          <p className="break-words rounded-lg bg-control px-3 py-2 font-mono text-ink">{pairing.connectText}</p>
          <button className={buttonStyle} onClick={async () => {
            try { await navigator.clipboard.writeText(pairing.connectText); setCopyState("copied"); }
            catch { setCopyState("error"); }
          }}>{t("inkbox.copyMessage")}</button>
          {copyState === "copied" && <p role="status" className="text-ink-secondary">{t("inkbox.messageCopied")}</p>}
          {copyState === "error" && <p role="alert" className="text-red-500">{t("inkbox.copyError")}</p>}
          <p className="text-ink-secondary">{t("inkbox.hello")}</p>
        </div>
      </div>
    </Card>}
    {!!snapshot.resources?.length && <Card title={t("inkbox.resources")}>
      <p className="mb-3 text-sm text-ink-secondary">{t(snapshot.capabilitiesAvailable ? "inkbox.resourcesActive" : "inkbox.resourcesPaused")}</p>
      {snapshot.eventSubscriptionError && <p role="alert" className="mb-3 text-sm text-red-500">{snapshot.eventSubscriptionError}</p>}
      <dl className="divide-y divide-hairline">{snapshot.resources.map(resource => <div key={resource.channel} className="py-3 first:pt-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <dt className="text-sm font-medium">{t(`inkbox.channel.${resource.channel}`)}</dt>
          <dd className={`text-xs ${resource.status === "ready" ? "text-ink-secondary" : "text-ink-tertiary"}`}>{t(`inkbox.resourceStatus.${resource.status}`)}</dd>
        </div>
        {resource.address && <dd className="mt-1 break-words text-sm text-ink">{resource.address}</dd>}
        <dd className="mt-1 text-xs text-ink-secondary">{resource.reason}</dd>
      </div>)}</dl>
      <a href="https://inkbox.ai/console" target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-xs text-accent underline underline-offset-2">{t("inkbox.manageChannels")}</a>
    </Card>}
    {snapshot.deliveries.length > 0 && <Card title={t("inkbox.deliveries")} subtitle={t("inkbox.deliveriesNote")}>
      <div className="space-y-3">{snapshot.deliveries.slice(-10).reverse().map(delivery => {
        const channel = delivery.channel === "text" ? "sms" : delivery.channel;
        return <article key={delivery.id} className="rounded-lg border border-hairline p-3 text-xs">
          <div className="flex flex-wrap justify-between gap-2"><strong>{delivery.sender}</strong><span>{delivery.status}</span></div>
          {channel && <p className="mt-1 text-ink-tertiary">{channel === "email" || channel === "imessage" || channel === "sms" || channel === "calls" || channel === "slack" || channel === "a2a" ? t(`inkbox.channel.${channel}`) : channel}</p>}
          {delivery.text && <p className="mt-2 whitespace-pre-wrap break-words text-ink-secondary">{delivery.text}</p>}
          {delivery.previewNotice && <p className="mt-2 text-ink-tertiary">{delivery.previewNotice}</p>}
          {(delivery.error || delivery.reply) && <p className="mt-2 whitespace-pre-wrap break-words">{delivery.error ?? delivery.reply}</p>}
        </article>;
      })}</div>
    </Card>}
  </div>;
}
