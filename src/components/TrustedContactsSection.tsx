import { useCallback, useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";
import type { ContactRequestRecord, TrustedContact, TrustedContactsSnapshot } from "../../shared/trusted-contacts";

const root = "/api/trusted-contacts";
const inputStyle = "w-full rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink";
const buttonStyle = "rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70 disabled:opacity-40";
const when = (at: number) => new Date(at).toLocaleString();
function localDate(at: number) { const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
interface Snapshot extends TrustedContactsSnapshot {
  ingress: { available: boolean; baseUrl: string };
  peers: { peers: Array<{ id: string; name: string; endpoint: string }>; requests: Array<{ id: string; peerId: string; status: string; reply?: { status: string; text: string; slots?: Array<{ start: number; end: number }> }; error?: string }> };
  messaging: { configured: boolean; ownerPhone?: string; botId?: string; deliveries: Array<{ id: string; sender: string; status: string; reply?: string; error?: string }> };
}
export function ContactInbox({ requests, contacts, busy, onDecision }: {
  requests: ContactRequestRecord[]; contacts: TrustedContact[]; busy: boolean;
  onDecision: (id: string, decision: "approve" | "deny") => void;
}) {
  const proposals = requests.filter(r => r.input.kind === "proposal").slice().reverse();
  return <div className="space-y-3">{!proposals.length && <p className="text-sm text-ink-secondary">{t("contacts.noRequests")}</p>}
    {proposals.map(r => <article className="rounded-lg border border-hairline p-3" key={r.id}>
      <div className="flex items-center justify-between gap-3"><strong className="text-sm">{contacts.find(c => c.id === r.contactId)?.name ?? t("contacts.removedContact")}</strong><span className="text-xs text-ink-secondary">{r.status}</span></div>
      <p className="mt-2 break-words text-sm">{r.input.kind === "proposal" && r.input.subject}</p>
      <p className="mt-1 text-xs text-ink-secondary">{when(r.input.start)} — {when(r.input.end)}</p>
      {r.status === "pending" && <><p className="mt-1 text-xs text-ink-secondary">{t("contacts.expires")} {when(r.expiresAt)}</p><div className="mt-3 flex gap-2"><button className={buttonStyle} disabled={busy} onClick={() => onDecision(r.id, "approve")}>{t("contacts.approve")}</button><button className={buttonStyle} disabled={busy} onClick={() => onDecision(r.id, "deny")}>{t("contacts.decline")}</button></div></>}
      {r.status === "completed" && <a className="mt-3 inline-block text-sm text-accent" href={`${root}/requests/${r.id}/invitation`} download="meeting.ics">{t("contacts.download")}</a>}
    </article>)}
  </div>;
}
export function TrustedContactsSection() {
  const { state, dispatch } = useStore();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [bot, setBot] = useState("");
  const [selected, setSelected] = useState(""); const [token, setToken] = useState("");
  const [from, setFrom] = useState(() => localDate(Date.now() + 86400000));
  const [until, setUntil] = useState(() => localDate(Date.now() + 90000000));
  const [expires, setExpires] = useState(() => localDate(Date.now() + 90000000));
  const [canPropose, setCanPropose] = useState(true); const [canRead, setCanRead] = useState(true);
  const [source, setSource] = useState<"manual" | "google">("manual"); const [calendarIds, setCalendarIds] = useState("primary");
  const [accountId, setAccountId] = useState("");
  const [command, setCommand] = useState(""); const [reply, setReply] = useState("");
  const [peerName, setPeerName] = useState(""); const [endpoint, setEndpoint] = useState(""); const [peerToken, setPeerToken] = useState(""); const [peerId, setPeerId] = useState("");
  const [subject, setSubject] = useState("");
  const refresh = useCallback(async () => { setSnapshot(await api<Snapshot>(root)); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const update = () => { api<Snapshot>(root, { signal: controller.signal }).then(setSnapshot).catch(e => { if (!controller.signal.aborted) setError(String(e.message)); }); };
    update(); const timer = setInterval(update, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await work(); await refresh(); setNotice(t("contacts.saved")); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const post = (path: string, body?: unknown, method = "POST") => api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const botId = bot || state.bots.find(b => !b.hidden)?.id || "";
  const contacts = snapshot?.contacts.filter(c => !c.disabled) ?? [];
  const contactId = selected || contacts[0]?.id || "";
  const peer = peerId || snapshot?.peers.peers[0]?.id || "";
  const savedGrant = JSON.stringify(contacts.find(c => c.id === contactId)?.grant ?? null);
  useEffect(() => {
    const grant = JSON.parse(savedGrant) as TrustedContact["grant"];
    setCanRead(grant?.capabilities.includes("availability") ?? true);
    setCanPropose(grant?.capabilities.includes("propose") ?? true);
    if (grant) { setFrom(localDate(grant.start)); setUntil(localDate(grant.end)); setExpires(localDate(grant.expiresAt)); }
  }, [contactId, savedGrant]);
  const savedCalendar = JSON.stringify(snapshot?.calendars.find(c => c.botId === botId) ?? null);
  useEffect(() => {
    const calendar = JSON.parse(savedCalendar) as TrustedContactsSnapshot["calendars"][number] | null;
    setSource(calendar?.source ?? "manual"); setCalendarIds(calendar?.calendarIds.join(", ") ?? "primary"); setAccountId(calendar?.accountId ?? "");
  }, [botId, savedCalendar]);
  const dates = () => {
    const start = new Date(from).getTime(), end = new Date(until).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(t("contacts.invalidDates"));
    return { start, end };
  };
  const dateFields = <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-ink-secondary">{t("contacts.from")}<input className={inputStyle} type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="text-xs text-ink-secondary">{t("contacts.until")}<input className={inputStyle} type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} /></label></div>;
  if (!snapshot) return <p role="status" className="text-sm text-ink-secondary">{error || t("contacts.loading")}</p>;
  return <div className="space-y-4">
    <p className="text-sm text-ink-secondary">{t("contacts.intro")}</p>
    {error && <p role="alert" className="rounded-lg border border-red-500/30 p-3 text-sm text-red-500">{error}</p>}
    {notice && <p role="status" className="text-xs text-ink-secondary">{notice}</p>}
    <Card title={t("contacts.inbox")} subtitle={t("contacts.invitationNote")}><ContactInbox requests={snapshot.requests} contacts={snapshot.contacts} busy={busy} onDecision={(id, decision) => void run(() => post(`${root}/requests/${id}/decision`, { decision }))} /></Card>
    <Card title={t("contacts.addContact")} subtitle={t("contacts.noAccess")}>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(async () => { const result = await post(`${root}/contacts`, { name, botId, ...(phone ? { phone } : {}) }); setToken(result.token); setSelected(result.contact.id); setName(""); setPhone(""); }); }}>
        <label className="block text-xs text-ink-secondary">{t("contacts.name")}<input required className={inputStyle} value={name} onChange={e => setName(e.target.value)} maxLength={80} /></label>
        <label className="block text-xs text-ink-secondary">{t("contacts.phone")}<input className={inputStyle} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+919876543210" /></label>
        <label className="block text-xs text-ink-secondary">{t("contacts.bot")}<select className={inputStyle} value={botId} onChange={e => setBot(e.target.value)}>{state.bots.filter(b => !b.hidden).map(b => <option value={b.id} key={b.id}>{b.name}</option>)}</select></label>
        <button className={buttonStyle} disabled={busy || !botId}>{t("contacts.create")}</button>
      </form>
      {token && <div className="mt-3 space-y-2 rounded-lg border border-hairline p-3"><p className="text-xs text-ink-secondary">{t("contacts.tokenNote")}</p><input aria-label={t("contacts.token")} className={inputStyle} readOnly value={token} onFocus={e => e.target.select()} /><button className={buttonStyle} onClick={() => setToken("")}>{t("contacts.dismiss")}</button></div>}
    </Card>
    <Card title={t("contacts.permissions")} subtitle={t("contacts.timezone")}>
      <div className="space-y-3"><label className="block text-xs text-ink-secondary">{t("contacts.contact")}<select className={inputStyle} value={contactId} onChange={e => setSelected(e.target.value)}><option value="">{t("contacts.choose")}</option>{contacts.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
        {dateFields}
        <label className="block text-xs text-ink-secondary">{t("contacts.expiry")}<input type="datetime-local" className={inputStyle} value={expires} onChange={e => setExpires(e.target.value)} /></label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={canRead} onChange={e => setCanRead(e.target.checked)} />{t("contacts.allowRead")}</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={canPropose} onChange={e => setCanPropose(e.target.checked)} />{t("contacts.allowPropose")}</label>
        <div className="flex flex-wrap gap-2"><button className={buttonStyle} disabled={busy || !contactId || (!canRead && !canPropose)} onClick={() => void run(() => post(`${root}/contacts/${contactId}/grant`, { ...dates(), expiresAt: new Date(expires).getTime(), capabilities: [...canRead ? ["availability"] : [], ...canPropose ? ["propose"] : []] }))}>{t("contacts.grant")}</button><button className={buttonStyle} disabled={busy || !contactId} onClick={() => void run(() => post(`${root}/contacts/${contactId}/revoke`))}>{t("contacts.revoke")}</button><button className={buttonStyle} disabled={busy || !contactId} onClick={() => void run(async () => { setToken((await post(`${root}/contacts/${contactId}/rotate`)).token); })}>{t("contacts.rotate")}</button></div>
        <div className="space-y-2">{contacts.map(c => <div key={c.id} className="rounded-lg bg-control/40 p-3 text-xs"><strong>{c.name}</strong><p className="mt-1 text-ink-secondary">{c.grant ? `${c.grant.capabilities.join(", ")} · ${when(c.grant.start)} — ${when(c.grant.end)} · ${t("contacts.expires")} ${when(c.grant.expiresAt)}` : t("contacts.noGrant")}</p></div>)}</div>
      </div>
    </Card>
    <Card title={t("contacts.availability")} subtitle={t("contacts.availabilityNote")}>
      <div className="space-y-3"><label className="block text-xs text-ink-secondary">{t("contacts.bot")}<select className={inputStyle} value={botId} onChange={e => setBot(e.target.value)}>{state.bots.filter(b => !b.hidden).map(b => <option value={b.id} key={b.id}>{b.name}</option>)}</select></label>
        <select aria-label={t("contacts.source")} className={inputStyle} value={source} onChange={e => setSource(e.target.value as "manual" | "google")}><option value="manual">{t("contacts.manual")}</option><option value="google">{t("contacts.google")}</option></select>
        {source === "google" && <label className="block text-xs text-ink-secondary">{t("contacts.calendars")}<input className={inputStyle} value={calendarIds} onChange={e => setCalendarIds(e.target.value)} /></label>}
        {source === "google" && <label className="block text-xs text-ink-secondary">{t("contacts.account")}<input className={inputStyle} value={accountId} onChange={e => setAccountId(e.target.value)} maxLength={128} /></label>}
        <p className="text-xs text-ink-secondary">{t("contacts.useWindow")}</p>
        <button className={buttonStyle} disabled={busy || !botId} onClick={() => void run(() => post(`${root}/calendar`, { botId, source, ...(accountId.trim() ? { accountId: accountId.trim() } : {}), slots: [dates()], calendarIds: calendarIds.split(",").map(s => s.trim()).filter(Boolean) }, "PUT"))}>{t("contacts.saveAvailability")}</button>
        {snapshot.calendars.map(c => <p key={c.botId} className="text-xs text-ink-secondary">{state.bots.find(b => b.id === c.botId)?.name ?? c.botId} · {c.source} · {c.slots.map(s => `${when(s.start)} — ${when(s.end)}`).join(", ")}</p>)}
      </div>
    </Card>
    <Card title={t("contacts.simulator")} subtitle={t("contacts.simulatorNote")}>
      <div className="space-y-3"><button className={buttonStyle} onClick={() => { try { const d = dates(); setCommand(`free ${new Date(d.start).toISOString()} ${new Date(d.end).toISOString()} 30`); } catch (e) { setError(String(e)); } }}>{t("contacts.example")}</button>
        <textarea aria-label={t("contacts.message")} className={inputStyle} value={command} onChange={e => setCommand(e.target.value)} rows={3} />
        <button className={buttonStyle} disabled={busy || !contactId || !command} onClick={() => void run(async () => setReply((await post(`${root}/simulate`, { contactId, id: crypto.randomUUID(), text: command })).text))}>{t("contacts.sendTest")}</button>
        {reply && <pre className="whitespace-pre-wrap break-words rounded-lg bg-control p-3 text-xs">{reply}</pre>}
      </div>
    </Card>
    <Card title={t("settings.section.inkbox")} subtitle={t("inkbox.contactsNote")}>
      <button className={buttonStyle} onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "inkbox" })}>{t("inkbox.openSetup")}</button>
    </Card>
    <Card title={t("contacts.peers")} subtitle={t("contacts.peerNote")}>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(async () => { const added = await post(`${root}/peers`, { name: peerName, endpoint, token: peerToken }); setPeerId(added.id); setPeerToken(""); setPeerName(""); setEndpoint(""); }); }}>
        <label className="block text-xs text-ink-secondary">{t("contacts.peerName")}<input required className={inputStyle} value={peerName} onChange={e => setPeerName(e.target.value)} /></label>
        <label className="block text-xs text-ink-secondary">{t("contacts.peerAddress")}<input required className={inputStyle} value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://maus.example.com" /></label>
        <label className="block text-xs text-ink-secondary">{t("contacts.token")}<input required type="password" autoComplete="off" className={inputStyle} value={peerToken} onChange={e => setPeerToken(e.target.value)} /></label>
        <button className={buttonStyle} disabled={busy}>{t("contacts.addPeer")}</button>
      </form>
      <div className="mt-4 space-y-3"><select aria-label={t("contacts.peerName")} className={inputStyle} value={peer} onChange={e => setPeerId(e.target.value)}><option value="">{t("contacts.choose")}</option>{snapshot.peers.peers.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select>
        <label className="block text-xs text-ink-secondary">{t("contacts.subject")}<input className={inputStyle} value={subject} onChange={e => setSubject(e.target.value)} maxLength={200} /></label>
        <p className="text-xs text-ink-secondary">{t("contacts.useWindow")}</p>
        <div className="flex flex-wrap gap-2"><button className={buttonStyle} disabled={busy || !peer} onClick={() => void run(() => post(`${root}/peers/${peer}/requests`, { id: crypto.randomUUID(), kind: "availability", ...dates(), durationMinutes: 30 }))}>{t("contacts.askFree")}</button><button className={buttonStyle} disabled={busy || !peer || !subject} onClick={() => void run(() => post(`${root}/peers/${peer}/requests`, { id: crypto.randomUUID(), kind: "proposal", ...dates(), subject }))}>{t("contacts.propose")}</button><button className={buttonStyle} disabled={busy || !peer} onClick={() => void run(async () => { await post(`${root}/peers/${peer}`, undefined, "DELETE"); setPeerId(""); })}>{t("contacts.removePeer")}</button></div>
        {snapshot.peers.requests.slice().reverse().map(r => <article className="rounded-lg border border-hairline p-3 text-xs" key={r.id}><strong>{snapshot.peers.peers.find(p => p.id === r.peerId)?.name ?? t("contacts.removedContact")}</strong> · {r.reply?.status ?? r.status}<p className="mt-1 break-words">{r.error ?? r.reply?.text}</p>{r.reply?.slots?.slice(0, 10).map(s => <p key={s.start}>{when(s.start)} — {when(s.end)}</p>)}{r.reply?.status === "pending" && <button className={`${buttonStyle} mt-2`} disabled={busy} onClick={() => void run(() => post(`${root}/outbound/${r.id}/refresh`))}>{t("contacts.refresh")}</button>}</article>)}
      </div>
    </Card>
  </div>;
}
