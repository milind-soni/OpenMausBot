import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronRight, Copy, Loader2 } from "lucide-react";
import { productName } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { readMembership } from "@/lib/membership";
import type { SessionState } from "@/lib/session";
import { readSharedSessionState } from "@/lib/shared-session";
import { api } from "@/state/api";
import { useStoreSelector } from "@/state/store-select";
import { canPairDevices, computerLink, pairingBlockedReason, phoneSecretNote, sameWifiOnlyLink, type PairingOffer } from "../ServerPairingCard";
import { Select } from "../Select";
import { TeamPhoneCard } from "../TeamPhoneCard";
import { PhoneCodeCard, TypedCode, Waiting } from "./CodeCard";

/** One copyable line to run on a new server: the sign-in a tunnel needs, then the server, in one go. */
export const SERVER_COMMANDS = {
  anywhere: "npx openmausbot account login && npx openmausbot serve --tunnel",
  tailscale: "npx openmausbot serve --tailscale",
} as const;

/** How often an open code checks whether a device has used it. */
export const PAIR_WATCH_MS = 2_000;

export function CommandRow({ label, command }: { label: string; command: string }) {
  const { state, copy } = useCopyFeedback(command);
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-[12px] leading-4 text-ink-secondary">{label}</span>}
      <div className="flex min-w-0 items-start gap-2 rounded-lg bg-ink/[0.05] py-1 ps-3 pe-1">
        <code data-server-command="" className="min-w-0 flex-1 select-text py-1.5 font-mono text-[12px] leading-4 text-ink [overflow-wrap:anywhere]">{command}</code>
        <button type="button" onClick={copy} aria-label={state === "failed" ? t("common.copyFailed") : t("devicesPage.addFlow.copyCommand")} title={t("devicesPage.addFlow.copyCommand")} className="ui-icon-button shrink-0">
          {state === "copied" ? <Check size={14} aria-hidden="true" className="text-success" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

/** The computer a link opens, by its first name: "ada-macbook". */
const hostName = (link: string): string | null => {
  try { return new URL(link).hostname.split(".")[0] || null; } catch { return null; }
};

/** Who is asking here and whether this place makes pairing codes at all (an organization's Admin may sign people in
 * instead); null while unread. */
export function usePairAccess(): { session: SessionState | null; pairingCodes: boolean | null } {
  const [session, setSession] = useState<SessionState | null>(null);
  const [pairingCodes, setPairingCodes] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void readSharedSessionState().then((state) => {
      if (!alive) return;
      setSession(state);
      if (canPairDevices(state)) void api("/api/config").then((body) => { if (alive) setPairingCodes(readMembership(body).pairingCodes); }).catch(() => { if (alive) setPairingCodes(false); });
    });
    return () => { alive = false; };
  }, []);
  return { session, pairingCodes };
}

/** What a device paired with a code may do here: everything, or chat and approvals only. */
type Scope = "admin" | "client";

/**
 * A pairing code for another device: only the owner or an admin may make one, never a chat-only session, a team member
 * or a place whose organization turned remote access off. It watches the signed-in devices until one more appears, and
 * cancels a code still unused when it closes or a new one replaces it. `advanced` offers a chat-only code (never on a
 * Cloud, where every device is its owner's).
 */
export function PairCodePanel({ kind, address, onConnected, cloudHome = false, advanced = false }: {
  kind: "phone" | "computer"; address: string | null; onConnected: () => void; cloudHome?: boolean; advanced?: boolean;
}) {
  const config = useStoreSelector((state) => state.config);
  const { session, pairingCodes } = usePairAccess();
  const [scope, setScope] = useState<Scope>("admin");
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [typing, setTyping] = useState(false);
  const typedId = useId();
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<string> | null>(null);
  const open = useRef<PairingOffer | null>(null);
  const policyBlocked = config?.managedPolicy?.remoteAccess === false ? t("policy.remoteBlocked", { organization: config.managedPolicy.organizationName }) : null;
  const allowed = canPairDevices(session) && pairingCodes === true && !policyBlocked && !(session?.kind === "session" && session.team);
  const chooseScope = advanced && !cloudHome && kind === "phone";

  const create = useCallback(async (asked: Scope = "admin") => {
    setError(null);
    setConnected(null);
    const unused = open.current;
    open.current = null;
    if (unused) void api(`/api/auth/pairing/${encodeURIComponent(unused.id)}`, { method: "DELETE" }).catch(() => {});
    try {
      const before = await api<{ sessions?: Array<{ id: string }> }>("/api/auth/sessions");
      known.current = new Set((before.sessions ?? []).map((one) => one.id));
      const body = await api<PairingOffer>("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: asked === "admin" ? ["admin", "client"] : ["client"] }) });
      open.current = body;
      setOffer(body);
      setNow(Date.now());
    } catch (cause) {
      setError(t("remote.serverPairing.error", { error: cause instanceof Error ? cause.message : String(cause) }));
    }
  }, []);

  useEffect(() => {
    if (allowed) void create();
  }, [allowed, create]);

  useEffect(() => {
    if (!offer || connected) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void Promise.all([
        api<{ sessions?: Array<{ id: string; label: string; person?: string }> }>("/api/auth/sessions", { background: true }),
        api<{ pairings?: Array<{ id: string }> }>("/api/auth/pairing", { background: true }),
      ]).then(([body, codes]) => {
        // Another device signing in meanwhile is not this one: while this code is still open, every session is known.
        if ((codes.pairings ?? []).some((pairing) => pairing.id === offer.id)) {
          known.current = new Set([...(known.current ?? []), ...(body.sessions ?? []).map((one) => one.id)]);
          return;
        }
        const fresh = (body.sessions ?? []).find((one) => known.current && !known.current.has(one.id));
        if (!fresh) return;
        open.current = null;
        setConnected(fresh.person ?? fresh.label);
        onConnected();
      }).catch(() => {});
    }, PAIR_WATCH_MS);
    return () => window.clearInterval(timer);
  }, [offer, connected, onConnected]);

  useEffect(() => () => {
    const unused = open.current;
    if (unused) void api(`/api/auth/pairing/${encodeURIComponent(unused.id)}`, { method: "DELETE" }).catch(() => {});
  }, []);

  const link = offer ? (kind === "computer" ? computerLink(offer, address) : offer.url ? { link: offer.url, address: "" } : null) : null;
  const { state: copied, copy } = useCopyFeedback(link?.link ?? "");

  if (session?.kind === "session" && session.team && config?.team?.name) {
    return <TeamPhoneCard team={config.team.name} blocked={config.managedPolicy?.remoteAccess === false ? t("policy.teamRemoteBlocked", { organization: config.managedPolicy.organizationName }) : null} />;
  }
  if (session && !canPairDevices(session)) {
    return <p data-pair-blocked="" className="text-[13px] leading-[18px] text-ink-secondary">{t(pairingBlockedReason(session) === "chat-only" ? "remote.serverPairing.chatOnlyShort" : "devicesPage.addFlow.adminOnly")}</p>;
  }
  if (policyBlocked) return <p data-pair-blocked="" className="text-[13px] leading-[18px] text-ink-secondary">{policyBlocked}</p>;
  if (pairingCodes === false) return <p data-pair-blocked="" className="text-[13px] leading-[18px] text-ink-secondary">{t("remote.serverPairing.portalShort")}</p>;
  if (error) return <p role="alert" className="text-[13px] leading-[18px] text-danger">{error}</p>;
  if (!offer) return <p className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary"><Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />{t("remote.serverPairing.creating")}</p>;
  if (offer.expiresAt <= now && !connected) {
    return <div className="flex flex-col items-start gap-3">
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("remote.serverPairing.expired")}</p>
      <button type="button" className="ui-button" onClick={() => void create(scope)}>{t("remote.serverPairing.create")}</button>
    </div>;
  }
  if (kind === "phone") {
    const secretNote = phoneSecretNote(offer);
    const notes = <>
      {link && <button type="button" onClick={copy} data-copy-link="" className="ui-button ui-button-sm w-fit">
        {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
      </button>}
      {chooseScope && <Select variant="ghost" value={scope} aria-label={t("remote.serverPairing.title")} data-pair-scope=""
        onChange={(event) => { const next: Scope = event.target.value === "client" ? "client" : "admin"; setScope(next); void create(next); }}>
        <option value="admin">{t("remote.serverPairing.scope.admin")}</option>
        <option value="client">{t("remote.serverPairing.scope.client")}</option>
      </Select>}
      <p className="text-[12px] leading-4 text-ink-secondary">{t(cloudHome ? "phone.pair.cloudPersonal" : "remote.serverPairing.subtitle", { app: productName() })}</p>
      {secretNote && <p data-pair-no-phone-secrets="" className="text-[12px] leading-4 text-ink-secondary">{secretNote}</p>}
      {sameWifiOnlyLink(offer.url) && <p data-pair-same-wifi="" className="text-[12px] leading-4 text-ink-secondary">{t("remote.serverPairing.sameWifiOnly", { app: productName() })}</p>}
    </>;
    if (link) return <PhoneCodeCard link={link.link} code={offer.code} expiresAt={offer.expiresAt} connected={connected}>{notes}</PhoneCodeCard>;
    return <div className="flex flex-col gap-3" data-pair-panel="phone">
      <p className="text-[13px] leading-[18px] text-ink">{t("phone.code.typeIntro", { app: productName() })}</p>
      <TypedCode label={t("connect.code")} code={offer.code} expiresAt={offer.expiresAt} />
      <Waiting connected={connected} waiting={t("devicesPage.addFlow.waitingPhone")} />
      {notes}
    </div>;
  }
  return (
    <div className="flex flex-col gap-3" data-pair-panel={kind}>
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("devicesPage.addFlow.computerPasteOther", { app: productName() })}</p>
      {link && (
        <div className="flex flex-col items-start gap-1.5">
          <button type="button" onClick={copy} data-copy-link="" data-pair-link={link.link} className="ui-button ui-button-primary">
            {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
          </button>
          {address && hostName(link.link) && <span className="text-[12px] leading-4 text-ink-tertiary">{t("devicesPage.addFlow.linkOpens", { host: hostName(link.link)! })}</span>}
        </div>
      )}
      <Waiting connected={connected} />
      {link && <div data-pair-type-instead="" data-open={typing ? "" : undefined} className="flex flex-col text-[12px] leading-4 text-ink-secondary">
        <button type="button" aria-expanded={typing} aria-controls={typedId} onClick={() => setTyping(!typing)}
          className="inline-flex w-fit cursor-pointer items-center gap-1 rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0 transition-transform duration-150 motion-reduce:transition-none rtl:-scale-x-100", typing && "rotate-90")} />
          {t("devicesPage.addFlow.typeInstead")}
        </button>
        <div id={typedId} hidden={!typing}>
          <div className="mt-2 flex flex-col gap-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-ink-tertiary">{t("connect.address")}</span>
              <span data-pairing-address="" className="select-text break-all text-[13px] leading-[18px] text-ink">{link.address}</span>
            </span>
            <TypedCode label={t("connect.code")} code={offer.code} expiresAt={offer.expiresAt} />
          </div>
        </div>
      </div>}
      {!link && <TypedCode label={t("connect.code")} code={offer.code} expiresAt={offer.expiresAt} />}
    </div>
  );
}

