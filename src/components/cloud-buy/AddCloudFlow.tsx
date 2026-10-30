// Buying another Cloud, for someone who has one: a plan, then its name and colour, then the Admin's checkout in the
// browser; the sheet follows the payment and the setup by itself and opens the new Cloud. Without an Admin that sells more
// than one Cloud per account it says so calmly. Main keeps the checkout page and the account; the page sees only this.
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import type { CloudOfferPlan } from "../../../electron/cloud-home.mjs";
import type { CloudSwatch } from "../../../electron/cloud-list.mjs";
import type { AddCloudView } from "../../../electron/cloud-rail.mjs";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { addCloudScreen, addCloudStop, CLOUD_LIST_NAME_LIMIT, DEFAULT_SWATCH, swatchFill, type AddCloudScreen, type AddCloudStop } from "@/lib/cloud-extra";
import { offerPlanLabel, usd } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { placeInitials } from "@/lib/places";
import { SwatchRadios } from "../SwatchRadios";
import { ChooseScreen } from "./ChooseScreen";
import { BackLink, Checklist, FIELD, Heading, PRIMARY_WIDE, ProgressBar } from "./parts";

const POLL_MS = 3_000;
const STOP_LINE: Record<Exclude<AddCloudStop, "one">, Parameters<typeof t>[0]> = {
  signups_closed: "cloudBuy.extra.signupsClosed", checkout_open: "cloudBuy.extra.checkoutOpen", rate: "cloudAdd.rateLimited",
};

function NameScreen({ plan, name, color, busy, suggested, onName, onColor, onBack, onContinue }: {
  plan: CloudOfferPlan; name: string; color: CloudSwatch; busy: boolean; suggested: string;
  onName: (value: string) => void; onColor: (value: CloudSwatch) => void; onBack: () => void; onContinue: () => void;
}) {
  const shown = name.trim().replace(/\s+/g, " ") || suggested;
  return <form data-cloud-add="extra-name" className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7" onSubmit={(event) => { event.preventDefault(); onContinue(); }}>
    <div><BackLink label={t("cloudBuy.back")} onClick={onBack} /></div>
    <Heading title={t("cloudBuy.extra.nameTitle")} sub={t("cloudBuy.extra.nameSub")} />
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("cloudBuy.setup.name")}
      <input data-autofocus value={name} maxLength={CLOUD_LIST_NAME_LIMIT} placeholder={suggested} disabled={busy} onChange={(event) => onName(event.target.value)} className={FIELD} />
    </label>
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-[13px] font-medium text-ink">{t("cloudBuy.setup.color")}</span>
      <SwatchRadios value={color} onChange={onColor} label={t("cloudBuy.setup.color")} disabled={busy} />
    </div>
    <div className="flex items-center gap-3 rounded-xl border border-hairline/70 bg-card/70 px-4 py-3">
      <span aria-hidden="true" className={cn("grid size-10 shrink-0 place-items-center rounded-full text-[14px] font-semibold", color === "slate" ? "bg-raised text-ink" : "text-white")}
        style={color === "slate" ? undefined : { background: swatchFill(color) }}>{placeInitials(shown)}</span>
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold text-ink">{shown}</span>
        <span className="block text-[13px] text-ink-secondary">{t("cloudBuy.pay.planPaid", { plan: offerPlanLabel(plan), price: usd(plan.amount / 100) })}</span>
      </span>
    </div>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudBuy.card.paid", { price: usd(plan.amount / 100) })}</p>
    <button type="submit" className={PRIMARY_WIDE} disabled={busy}>
      {busy && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{t("cloudBuy.extra.continue")}
    </button>
  </form>;
}

function Stop({ reason, home, busy, interest, onInterest, onClose }: {
  reason: AddCloudStop; home: string | null; busy: boolean; interest: "sent" | "failed" | null; onInterest: () => void; onClose: () => void;
}) {
  return <div data-cloud-add={`extra-${reason}`} className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
    {reason === "one"
      ? <Heading title={t("cloudBuy.one.title")} sub={t("cloudBuy.one.sub", { name: home ?? t("cloudSetup.myCloud") })} />
      : <><Heading title={t("cloudAdd.title")} /><p role="status" className="text-[14px] leading-relaxed text-ink">{t(STOP_LINE[reason])}</p></>}
    <div className="flex flex-wrap items-center justify-end gap-2">
      {reason === "one" && interest !== "sent" && <button type="button" className="ui-button" disabled={busy} onClick={onInterest}>{t("cloudBuy.one.email")}</button>}
      <button type="button" data-autofocus className="ui-button ui-button-primary" onClick={onClose}>{t("cloudAdd.close")}</button>
    </div>
    <div aria-live="polite" className="text-[13px] empty:-mt-4">
      {interest === "sent" && <p className="text-ink-secondary">{t("cloudBuy.one.thanks")}</p>}
      {interest === "failed" && <p role="alert" className="text-danger">{t("cloudBuy.one.failed")}</p>}
    </div>
  </div>;
}

/** `onFirstCloud`: there is no Cloud of the person's own yet, so this computer's own sheet buys the first (with its sign-in
 * and trial). `onWide`: the plan cards want the wide sheet. `onBack`: back to ＋'s two choices. */
export function AddCloudFlow({ onClose, onFirstCloud, onWide = () => {}, onBack = null, now = Date.now }: {
  onClose: () => void; onFirstCloud: () => void; onWide?: (wide: boolean) => void; onBack?: (() => void) | null; now?: () => number;
}) {
  const bridge = window.ogb?.cloudAdd;
  const [view, setView] = useState<AddCloudView | null | undefined>(undefined);
  const [tier, setTier] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<CloudSwatch>(DEFAULT_SWATCH);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stop, setStop] = useState<AddCloudStop | null>(null);
  const [note, setNote] = useState<"copied" | "pay-failed" | "open-failed" | null>(null);
  const [interest, setInterest] = useState<"sent" | "failed" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const read = () => bridge?.state().then(setView, () => setView(null)) ?? Promise.resolve(setView(null));
  useEffect(() => {
    void read();
    const off = window.ogb?.workspaces?.onChanged?.(() => void read());
    void bridge?.sheet(true).catch(() => {});
    return () => { off?.(); void bridge?.sheet(false).catch(() => {}); };
  }, []);
  const screen: AddCloudScreen = addCloudScreen(view, { now: now(), tier, failed, stop });
  const following = screen.kind === "waiting" || screen.kind === "starting";
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(timer);
  }, [following]);
  useEffect(() => { onWide(screen.kind === "choose"); }, [screen.kind]);
  useEffect(() => {
    if (screen.kind === "first") onFirstCloud();
    if (screen.kind === "ready") track("cloud_add_another", { step: "ready" });
  }, [screen.kind]);
  useEffect(() => {
    if (root.current?.contains(document.activeElement)) return;
    (root.current?.querySelector<HTMLElement>("[data-autofocus]") ?? root.current?.querySelector<HTMLElement>("#cloud-add-title"))?.focus();
  }, [screen.kind]);
  const count = view && view.signedIn ? view.count : 1;
  const suggested = t("cloudBuy.extra.defaultName", { number: count + 1 });
  const act = (step: () => Promise<unknown>, fail: () => void) => {
    if (busy) return;
    setBusy(true); setNote(null);
    void step().catch(fail).finally(() => setBusy(false));
  };
  const start = () => act(async () => {
    if (screen.kind !== "name" || !bridge) return;
    const result = await bridge.start(screen.plan.tier, name.trim().replace(/\s+/g, " ") || suggested, color);
    if (result.outcome === "opened") { track("cloud_add_another", { step: "checkout_opened", plan: screen.plan.tier }); setTier(null); await read(); return; }
    // Another Cloud's checkout still open: main keeps its page, and the sheet follows that one (Reopen, Copy link).
    if (result.outcome === "blocked") { setStop(addCloudStop(result.blocked)); if (result.blocked === "checkout_open") await read(); }
    else if (result.outcome === "unsupported") setStop("one");
    else setFailed(true);
  }, () => setFailed(true));
  const body = (() => {
    switch (screen.kind) {
      case "checking": case "first": return <div data-cloud-add="extra-checking" className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
        <Heading title={t("cloudAdd.title")} />
        <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("cloudAdd.checking")}</p>
      </div>;
      case "unreachable": case "error": return <div data-cloud-add={`extra-${screen.kind}`} className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
        <Heading title={t("cloudAdd.title")} />
        <p role="alert" className="text-[14px] leading-relaxed text-ink">{t(screen.kind === "error" ? "cloudAdd.failed" : "cloudAdd.unreachable")}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="ui-button" onClick={onClose}>{t("cloudAdd.close")}</button>
          <button type="button" data-autofocus className="ui-button ui-button-primary" onClick={() => { setFailed(false); setView(undefined); void read(); }}>{t("cloudAdd.tryAgain")}</button>
        </div>
      </div>;
      case "stop": return <Stop reason={screen.reason} home={screen.home} busy={busy} interest={interest} onClose={onClose}
        onInterest={() => act(async () => { await bridge?.interest(); setInterest("sent"); }, () => setInterest("failed"))} />;
      case "choose": return <div>
        {onBack && <div className="px-7 pt-5"><BackLink label={t("rail.back")} onClick={onBack} /></div>}
        <ChooseScreen offer={screen.offer} now={now()} busy={busy} signedOut={false} notice={null} onSignIn={() => {}}
          onStart={(chosen) => { track("cloud_add_another", { step: "plan", plan: chosen }); setTier(chosen); }} />
      </div>;
      case "name": return <NameScreen plan={screen.plan} name={name} color={color} busy={busy} suggested={suggested} onName={setName} onColor={setColor}
        onBack={() => setTier(null)} onContinue={start} />;
      case "waiting": return <div data-cloud-add={screen.late ? "extra-waiting-late" : "extra-waiting"} className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
        <Heading title={screen.late ? t("cloudBuy.pay.lateTitle") : t("cloudAdd.browserTitle")} sub={screen.late ? t("cloudBuy.extra.lateSub") : t("cloudBuy.pay.sub")} />
        <Checklist items={[
          { key: "payment", state: "now", title: t("cloudBuy.pay.waiting"), detail: screen.adding.name },
          { key: "setup", state: "next", title: t("cloudBuy.pay.setup"), detail: t("cloudBuy.pay.setupHint") },
        ]} />
        {screen.adding.link && <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-autofocus className={screen.late ? "ui-button ui-button-primary" : "ui-button"} disabled={busy}
            onClick={() => act(async () => { if (!(await bridge?.reopen())) setNote("pay-failed"); }, () => setNote("pay-failed"))}>
            <ExternalLink size={14} aria-hidden="true" />{t("cloudAdd.reopenCheckout")}</button>
          <button type="button" className="ui-button" disabled={busy}
            onClick={() => act(async () => setNote((await bridge?.copyLink()) ? "copied" : "pay-failed"), () => setNote("pay-failed"))}>
            <Copy size={14} aria-hidden="true" />{t("cloudBuy.pay.copy")}</button>
        </div>}
        <div aria-live="polite" className="text-[13px] empty:-mt-4">
          {note === "copied" && <p className="text-ink-secondary">{t("cloudBuy.pay.copied")}</p>}
          {note === "pay-failed" && <p role="alert" className="text-danger">{t("cloudBuy.pay.failed")}</p>}
        </div>
      </div>;
      case "starting": return <div data-cloud-add="extra-starting" className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
        <Heading title={t("cloudBuy.extra.setupTitle", { name: screen.adding.name })} sub={t("cloudBuy.extra.setupSub")} />
        <ProgressBar value={screen.adding.progress ?? 0} label={t("cloudBuy.setup.progress")} />
        <div className="flex justify-end"><button type="button" data-autofocus className="ui-button" onClick={onClose}>{t("cloudAdd.close")}</button></div>
      </div>;
      case "ready": return <div data-cloud-add="extra-ready" className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
        <Heading title={t("cloudBuy.ready.title", { name: screen.adding.name })} sub={t("cloudBuy.extra.readySub")} />
        <button type="button" data-autofocus className={PRIMARY_WIDE} disabled={busy}
          onClick={() => act(async () => { await bridge?.open(); onClose(); }, () => setNote("open-failed"))}>{t("cloudBuy.setup.open", { name: screen.adding.name })}</button>
        {note === "open-failed" && <p role="alert" className="text-[13px] text-danger">{t("cloudBuy.openFailed", { name: screen.adding.name })}</p>}
      </div>;
      case "problem": return <div data-cloud-add="extra-problem" className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
        <Heading title={t("cloudAdd.title")} />
        <p role="alert" className="text-[14px] leading-relaxed text-ink">{t("cloudBuy.extra.problem", { name: screen.adding.name })}</p>
        <div className="flex justify-end"><button type="button" data-autofocus className="ui-button ui-button-primary" onClick={onClose}>{t("cloudAdd.close")}</button></div>
      </div>;
    }
  })();
  return <div ref={root} data-add-cloud-flow={screen.kind} className="contents">{body}</div>;
}
