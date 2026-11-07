// ＋ at the end of the rail: one sheet of choices. A new workspace on this computer (named here, then main opens it), a new
// organization on the Team plan the person pays for (when they run one), buy a Cloud (the buying sheet: another Cloud right
// here, or the first one on this computer's own sheet), or add a server of the person's own by pasting its pairing link.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Building2, Cloud, Laptop, Loader2, Server, UserRound, X } from "lucide-react";
import type { CloudSwatch } from "../../electron/cloud-list.mjs";
import type { RailAddChoices, RailPlace } from "../../electron/cloud-rail.mjs";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { CLOUD_LIST_NAME_LIMIT, CLOUD_SWATCH_ORDER, SWATCH_COLOR, swatchFill } from "@/lib/cloud-extra";
import { t } from "@/lib/i18n";
import { computerName, createLocal, placeInitials, suggestedLocalName } from "@/lib/places";
import { AddCloudFlow } from "./cloud-buy/AddCloudFlow";
import { NewOrganization } from "./cloud-buy/NewOrganization";
import { BackLink, FIELD, Heading, PRIMARY_WIDE } from "./cloud-buy/parts";
import { SwatchRadios } from "./SwatchRadios";

/** A server's pairing link, pasted here: main checks it and asks "Connect to <host>?" itself, then opens it. The sheet
 * stays open when the person cancels, and says so when the link isn't one. `connect`: a server of theirs that signed in
 * with their account, not connected to this app yet. */
export function OwnServerLink({ onBack, onConnected, connect = null }: { onBack: (() => void) | null; onConnected: () => void; connect?: { name: string } | null }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const pasted = link.trim();
    if (!pasted || busy) return;
    track("rail_add", { step: "link" });
    setBusy(true);
    setFailed(false);
    try {
      if (await window.ogb?.workspaces?.add?.("link", pasted) !== false) onConnected();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return <form data-place-add={connect ? "connect-server" : "own-server"} onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7">
    {onBack && <div><BackLink label={t("rail.back")} onClick={onBack} /></div>}
    <Heading title={connect ? t("rail.connectTitle", { name: connect.name }) : t("rail.own")} sub={t(connect ? "rail.connectPasteLede" : "rail.pasteLede")} />
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("rail.paste")}
      <input data-autofocus data-own-server-link value={link} disabled={busy} onChange={(event) => { setLink(event.target.value); setFailed(false); }}
        placeholder="https://" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} aria-invalid={failed || undefined}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] font-normal text-ink outline-none focus:border-accent/50" />
    </label>
    {failed && <p role="alert" className="text-[13px] text-danger">{t("rail.linkFailed")}</p>}
    <div><button type="submit" disabled={busy || !link.trim()} className="ui-button ui-button-primary inline-flex items-center gap-2">
      {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t("rail.connect")}
    </button></div>
  </form>;
}

function Choice({ icon, title, sub, onClick, kind }: { icon: ReactNode; title: string; sub: string; onClick: () => void; kind: string }) {
  return <button type="button" data-place-add-choice={kind} onClick={onClick}
    className="flex min-w-0 flex-1 flex-col items-start gap-2 rounded-2xl border border-hairline bg-card p-5 text-start transition-colors hover:border-accent/60 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
    <span aria-hidden="true" className="grid size-9 place-items-center rounded-[10px] bg-accent/12 text-accent-text">{icon}</span>
    <span className="text-[15px] font-semibold text-ink">{title}</span>
    <span className="text-[13px] leading-snug text-ink-secondary">{sub}</span>
  </button>;
}

const FOCUSABLE = "button:not([disabled]):not([tabindex='-1']), input:not([disabled]):not([tabindex='-1']), [href], [tabindex='0']";

/** The sheet over the app, like the buying sheet's: Escape and Close close it, Tab stays in it, focus goes back after. */
export function RailSheet({ wide = false, focusKey, onClose, children }: { wide?: boolean; focusKey: string; onClose: () => void; children: ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement);
      controls[at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (opener?.isConnected) opener.focus(); };
  }, [onClose]);
  useEffect(() => {
    if (sheet.current?.contains(document.activeElement) && document.activeElement !== sheet.current) return;
    (sheet.current?.querySelector<HTMLElement>("[data-autofocus]") ?? sheet.current?.querySelector<HTMLElement>("#cloud-add-title"))?.focus();
  }, [focusKey]);
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 sm:p-6" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div ref={sheet} role="dialog" aria-modal="true" aria-labelledby="cloud-add-title" data-place-add-sheet tabIndex={-1}
      className={cn("animate-pop-in relative max-h-full w-full overflow-y-auto overscroll-contain rounded-2xl border border-hairline/70 bg-panel shadow-2xl outline-none", wide ? "max-w-[900px]" : "max-w-[560px]")}>
      <button type="button" onClick={onClose} aria-label={t("cloudAdd.close")} className="ui-icon-button absolute end-3.5 top-3.5 z-10"><X size={18} /></button>
      {children}
    </div>
  </div>;
}

/** The names and colours already on the rail: a new workspace's first name and colour are ones no place has yet. */
function placesTaken(places: readonly RailPlace[]): { names: string[]; swatches: Set<CloudSwatch> } {
  const names = places.map((place) => (place.kind === "computer" ? computerName(place) : place.name));
  return { names, swatches: new Set(places.map((place) => place.paint?.swatch ?? CLOUD_SWATCH_ORDER.find((swatch) => place.color !== null && SWATCH_COLOR[swatch] === place.color)).filter((swatch): swatch is CloudSwatch => Boolean(swatch))) };
}

/** A new workspace on this computer: its name (Work, Personal or Workspace 2 to start) and its colour, then main makes it
 * and opens it. A name another place here has is said at once; main says it too, for one the rail doesn't list. */
export function NewLocalWorkspace({ places, onBack, onDone }: { places: readonly RailPlace[]; onBack: (() => void) | null; onDone: () => void }) {
  const [taken] = useState(() => placesTaken(places));
  const [name, setName] = useState(() => suggestedLocalName(taken.names));
  const [color, setColor] = useState<CloudSwatch>(() => CLOUD_SWATCH_ORDER.find((swatch) => swatch !== "slate" && !taken.swatches.has(swatch)) ?? "slate");
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState<"taken" | "failed" | null>(null);
  const shown = name.trim().replace(/\s+/g, " ");
  const clash = taken.names.some((other) => other.toLocaleLowerCase() === shown.toLocaleLowerCase());
  const create = async () => {
    if (!shown || busy) return;
    if (clash) { setProblem("taken"); return; }
    setBusy(true); setProblem(null);
    const outcome = await createLocal(shown, color === "slate" ? null : color);
    setBusy(false);
    if (outcome === "made") { track("rail_add", { step: "local" }); onDone(); return; }
    setProblem(outcome === "taken" ? "taken" : "failed");
  };
  return <form data-place-add="local" className="flex flex-col gap-4 px-[30px] pb-[26px] pt-7" onSubmit={(event) => { event.preventDefault(); void create(); }}>
    {onBack && <div><BackLink label={t("rail.back")} onClick={onBack} /></div>}
    <Heading title={t("rail.local")} sub={t("rail.localSub")} />
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">{t("rail.orgName")}
      <input data-autofocus data-local-name value={name} maxLength={CLOUD_LIST_NAME_LIMIT} disabled={busy} aria-invalid={problem === "taken" || undefined}
        onChange={(event) => { setName(event.target.value); setProblem(null); }} onFocus={(event) => event.currentTarget.select()} className={FIELD} />
    </label>
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-[13px] font-medium text-ink">{t("rail.orgColor")}</span>
      <SwatchRadios value={color} onChange={setColor} label={t("rail.orgColor")} disabled={busy} none />
    </div>
    <div className="flex items-center gap-3 rounded-xl border border-hairline/70 bg-card/70 px-4 py-3">
      <span aria-hidden="true" className={cn("relative grid size-10 shrink-0 place-items-center rounded-[12px] text-[14px] font-semibold", color === "slate" ? "bg-raised text-ink" : "text-white")}
        style={color === "slate" ? undefined : { background: swatchFill(color) }}>{placeInitials(shown || t("rail.localWork"))}
        <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full border border-hairline bg-panel text-ink-secondary"><Laptop size={9} strokeWidth={2.25} /></span>
      </span>
      <span className="min-w-0">
        <span data-local-preview className="block truncate text-[14px] font-semibold text-ink">{shown || t("rail.localWork")}</span>
        <span className="block text-[13px] text-ink-secondary">{t("rail.localPreview")}</span>
      </span>
    </div>
    {problem && <p role="alert" data-local-problem className="text-[13px] leading-relaxed text-danger">{t(problem === "taken" ? "rail.localTaken" : "rail.localFailed")}</p>}
    <button type="submit" data-local-create className={PRIMARY_WIDE} disabled={busy || !shown}>
      {busy && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{t("rail.localCreate")}
    </button>
  </form>;
}

/** The Server menu's New workspace on this computer, where no rail stands beside this computer's own page: the same step
 * on a sheet of its own. */
export function NewLocalFromMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => (window.ogb?.remoteClient?.active ? undefined : window.ogb?.workspaces?.onNewLocal?.(() => setOpen(true))), []);
  if (!open) return null;
  return <RailSheet focusKey="local" onClose={() => setOpen(false)}>
    <NewLocalWorkspace places={[]} onBack={null} onDone={() => setOpen(false)} />
  </RailSheet>;
}

export function PlaceAddSheet({ choices, places = [], connect = null, onClose, onAccount }: { choices: RailAddChoices; places?: readonly RailPlace[]; connect?: { name: string } | null; onClose: () => void; onAccount?: () => void }) {
  const server = choices.link, organization = choices.organization === true, account = choices.account === true && Boolean(onAccount), local = choices.local === true;
  const several = [local, organization, choices.cloud, server, account].filter(Boolean).length > 1;
  const [view, setView] = useState<"choose" | "local" | "cloud" | "server" | "organization">(connect ? "server" : several ? "choose" : local ? "local" : organization ? "organization" : choices.cloud ? "cloud" : "server");
  const [wide, setWide] = useState(false);
  const workspaces = window.ogb?.workspaces;
  const firstCloud = () => {
    track("rail_add", { step: "cloud" });
    onClose();
    void workspaces?.add?.("cloud").catch(() => {});
  };
  return <RailSheet wide={view === "cloud" && wide} focusKey={view} onClose={onClose}>
    {view === "choose" && <div data-place-add="choose" className="flex flex-col gap-5 px-[30px] pb-[26px] pt-7">
      <Heading title={t(local ? "rail.addAny" : "rail.add")} />
      {local && <Choice kind="local" icon={<Laptop size={19} />} title={t("rail.local")} sub={t("rail.localSub")} onClick={() => setView("local")} />}
      <div className="flex flex-col gap-3 sm:flex-row">
        {organization && <Choice kind="organization" icon={<Building2 size={19} />} title={t("rail.org")} sub={t("rail.orgSub")} onClick={() => setView("organization")} />}
        {choices.cloud && <Choice kind="cloud" icon={<Cloud size={19} />} title={t("rail.buy")} sub={t("rail.buySub")} onClick={() => setView("cloud")} />}
        {server && <Choice kind="server" icon={<Server size={19} />} title={t("rail.own")} sub={t("rail.ownSub")} onClick={() => setView("server")} />}
        {account && <Choice kind="account" icon={<UserRound size={19} />} title={t("accounts.add")} sub={t("rail.accountSub")} onClick={() => onAccount!()} />}
      </div>
    </div>}
    {view === "local" && <NewLocalWorkspace places={places} onBack={several ? () => setView("choose") : null} onDone={onClose} />}
    {view === "server" && <OwnServerLink onBack={several && !connect ? () => setView("choose") : null} onConnected={onClose} connect={connect} />}
    {view === "cloud" && <AddCloudFlow onClose={onClose} onFirstCloud={firstCloud} onWide={setWide} onBack={several ? () => setView("choose") : null} />}
    {view === "organization" && <NewOrganization onClose={onClose} onBack={several ? () => setView("choose") : null} />}
  </RailSheet>;
}
