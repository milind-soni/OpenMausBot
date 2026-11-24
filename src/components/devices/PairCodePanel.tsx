import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Loader2 } from "lucide-react";
import { productName } from "@/lib/brand";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { readMembership } from "@/lib/membership";
import { codeUntil } from "@/lib/pairing-time";
import type { SessionState } from "@/lib/session";
import { readSharedSessionState } from "@/lib/shared-session";
import { api } from "@/state/api";
import { useStoreSelector } from "@/state/store-select";
import { canPairDevices, computerLink, pairingBlockedReason, type PairingOffer } from "../ServerPairingCard";
import { TeamPhoneCard } from "../TeamPhoneCard";

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
      <span className="text-[12px] leading-4 text-ink-secondary">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-ink/[0.05] px-3 py-2">
        <code data-server-command="" className="min-w-0 flex-1 select-text break-all font-mono text-[12px] leading-4 text-ink">{command}</code>
        <button type="button" onClick={copy} className="shrink-0 cursor-pointer text-[12px] font-medium leading-4 text-accent-text hover:underline">
          {t(state === "copied" ? "connect.copied" : "connect.copy")}
        </button>
      </div>
    </div>
  );
}

export function Waiting({ connected }: { connected: string | null }) {
  return connected
    ? <p role="status" data-pair-state="connected" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink"><Check size={14} aria-hidden="true" className="text-success" />{t("devicesPage.addFlow.connected", { name: connected })}</p>
    : <p role="status" data-pair-state="waiting" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary"><Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />{t("devicesPage.addFlow.waiting")}</p>;
}

/**
 * A pairing code for another device, from the same endpoint and with the same gates as Phone & devices: only the owner
 * or an admin may make one, never a chat-only session, a team member or a place whose organization turned remote access
 * off. It watches the signed-in devices until one more appears, and cancels a code still unused when it closes.
 */
export function PairCodePanel({ kind, address, onConnected }: { kind: "phone" | "computer"; address: string | null; onConnected: () => void }) {
  const config = useStoreSelector((state) => state.config);
  const [session, setSession] = useState<SessionState | null>(null);
  const [pairingCodes, setPairingCodes] = useState<boolean | null>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<string> | null>(null);
  const open = useRef<PairingOffer | null>(null);
  const policyBlocked = config?.managedPolicy?.remoteAccess === false ? t("policy.remoteBlocked", { organization: config.managedPolicy.organizationName }) : null;
  const allowed = canPairDevices(session) && pairingCodes === true && !policyBlocked && !(session?.kind === "session" && session.team);

  useEffect(() => {
    let alive = true;
    void readSharedSessionState().then((state) => {
      if (!alive) return;
      setSession(state);
      if (canPairDevices(state)) void api("/api/config").then((body) => { if (alive) setPairingCodes(readMembership(body).pairingCodes); }).catch(() => { if (alive) setPairingCodes(false); });
    });
    return () => { alive = false; };
  }, []);

  const create = useCallback(async () => {
    setError(null);
    setConnected(null);
    try {
      const before = await api<{ sessions?: Array<{ id: string }> }>("/api/auth/sessions");
      known.current = new Set((before.sessions ?? []).map((one) => one.id));
      const body = await api<PairingOffer>("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["admin", "client"] }) });
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

  if (session?.kind === "session" && session.team && config?.team?.name) return <TeamPhoneCard team={config.team.name} blocked={policyBlocked} />;
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
      <button type="button" className="ui-button" onClick={() => void create()}>{t("remote.serverPairing.create")}</button>
    </div>;
  }
  return (
    <div className="flex flex-col gap-4" data-pair-panel={kind}>
      {kind === "phone" && offer.url && (
        <div data-pair-qr="" className="self-center rounded-xl bg-white p-3 shadow-[inset_0_0_0_0.5px_var(--settings-edge)]">
          <QRCodeSVG value={offer.url} size={176} level="M" bgColor="#ffffff" fgColor="#111111" />
        </div>
      )}
      <p className="text-[13px] leading-[18px] text-ink">
        {kind === "phone" ? t("phone.code.installAndScan", { app: productName() }) : t("devicesPage.addFlow.computerPaste", { app: productName() })}
      </p>
      {kind === "computer" && link && (
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-ink/[0.05] px-3 py-2">
          <code data-pair-link="" className="min-w-0 flex-1 select-text break-all font-mono text-[12px] leading-4 text-ink">{link.link}</code>
          <button type="button" onClick={copy} data-copy-link="" className="shrink-0 cursor-pointer text-[12px] font-medium leading-4 text-accent-text hover:underline">
            {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[12px] leading-4 text-ink-secondary">{t("connect.code")}</span>
        <span data-pairing-code="" className="text-[16px] font-medium leading-6 tracking-[0.08em] text-ink tabular-nums">{offer.code}</span>
        <span className="text-[12px] leading-4 text-ink-tertiary">{codeUntil(offer.expiresAt)}</span>
      </div>
      <Waiting connected={connected} />
    </div>
  );
}

