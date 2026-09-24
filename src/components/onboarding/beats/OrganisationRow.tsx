// Engines beat, first row: the optional way in for people who use the app
// at work. It drives the same desktop bridge as Settings → Organisation, with
// the default Admin address, and nothing starts until the person presses
// Sign in. Another Admin address, disconnecting and every other decision stay
// in Settings; this row only starts, follows and cancels one sign-in. It adds
// no dialog and gates nothing: Continue works in every state.
import { useEffect, useRef, useState } from "react";
import { Building2, Check } from "lucide-react";
import type { ManagedDesktopBridge, ManagedDesktopState } from "../../../../electron/managed-desktop.mjs";
import { brand } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { companyModelCount, DEFAULT_ADMIN_ORIGIN } from "@/lib/onboarding";
import { staggerIndex } from "./shared";

const linkClass = "w-fit text-[12px] text-ink-secondary underline-offset-2 transition-colors hover:text-ink hover:underline";

export function OrganisationRow({
  bridge,
  onOpenSettings,
  onConnected,
}: {
  bridge: ManagedDesktopBridge;
  /** Settings → Organisation: another Admin address and everything else. */
  onOpenSettings: () => void;
  /** The Company models arrive with the connection; the beat counts again. */
  onConnected?: () => void;
}) {
  const [connection, setConnection] = useState<ManagedDesktopState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const revision = useRef(0);
  const status = useRef<ManagedDesktopState["status"] | undefined>(undefined);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  const accept = (next: ManagedDesktopState) => {
    const changed = status.current !== next.status;
    const arrived = changed && next.status === "connected" && status.current !== undefined;
    status.current = next.status;
    setConnection(next);
    // Heartbeats republish the same state; keep an error until it changes.
    if (changed) setFailed(false);
    if (arrived) connected.current?.();
  };

  useEffect(() => {
    // Same guards as Settings: a push can land while the first snapshot or
    // an action is in flight, and nothing from a closed beat may render.
    const current = ++generation.current;
    const initialRevision = revision.current;
    const receive = (next: ManagedDesktopState) => {
      if (generation.current !== current) return;
      revision.current++;
      accept(next);
    };
    const unsubscribe = bridge.onState(receive);
    void bridge
      .state()
      .then((next) => {
        if (revision.current === initialRevision) receive(next);
      })
      .catch(() => {});
    return () => {
      generation.current++;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  const perform = async (action: () => Promise<ManagedDesktopState>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    const current = generation.current;
    const startedRevision = revision.current;
    try {
      const next = await action();
      if (generation.current === current && revision.current === startedRevision) accept(next);
    } catch {
      // IPC errors can carry internal detail; show product copy only.
      if (generation.current === current && revision.current === startedRevision) setFailed(true);
    } finally {
      pending.current = false;
      if (generation.current === current) setBusy(false);
    }
  };

  if (!connection) return null;
  const count = companyModelCount(connection);
  const name = connection.organization?.name;

  let body: React.ReactNode;
  let action: React.ReactNode = null;
  if (connection.status === "signed-out") {
    body = (
      <>
        <p className="text-[13px] leading-snug text-ink-secondary">
          <span className="font-medium text-ink">{t("onboarding.org.title", { app: brand().name })}</span>{" "}
          {t("onboarding.org.body")}
        </p>
        <button type="button" onClick={onOpenSettings} className={linkClass}>
          {t("onboarding.org.otherAddress")}
        </button>
      </>
    );
    action = (
      <button
        type="button"
        disabled={busy}
        onClick={() => void perform(() => bridge.begin({ portalOrigin: DEFAULT_ADMIN_ORIGIN }))}
        className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-50"
      >
        {busy ? t("organization.working") : t("onboarding.org.signIn")}
      </button>
    );
  } else if (connection.status === "connecting") {
    body = (
      <>
        <p role="status" className="text-[13px] font-medium text-ink">{t("onboarding.org.finish")}</p>
        {connection.enrollment && (
          <p className="text-[12px] text-ink-secondary">
            {t("onboarding.org.finishHelp")}{" "}
            <code dir="ltr" className="select-all rounded bg-inset px-1.5 py-0.5 tracking-widest text-ink">
              {connection.enrollment.userCode}
            </code>
          </p>
        )}
      </>
    );
    action = (
      <button
        type="button"
        disabled={busy}
        onClick={() => void perform(() => bridge.cancelEnrollment())}
        className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
      >
        {t("organization.cancel")}
      </button>
    );
  } else if (connection.status === "connected") {
    body = (
      <>
        <p className="truncate text-[13px] font-medium text-ink">{t("onboarding.org.connected", { organization: name ?? "" })}</p>
        <p className="text-[12px] text-ink-secondary">
          {count > 0 ? t("onboarding.org.models", { count }) : t("organization.noModels")}
        </p>
      </>
    );
    action = count > 0 ? <Check size={16} strokeWidth={2.5} className="shrink-0 text-success" aria-hidden="true" /> : null;
  } else {
    // Needs a new sign-in, unavailable, or a state this build does not know:
    // Settings says why and offers the way out; this row only points there.
    body = (
      <>
        {name && <p className="truncate text-[13px] font-medium text-ink">{name}</p>}
        <button type="button" onClick={onOpenSettings} className={linkClass}>
          {t("onboarding.org.manage")}
        </button>
      </>
    );
  }

  return (
    <div
      className="animate-rise mt-4 flex items-center gap-3 rounded-xl border border-hairline/40 bg-card px-3.5 py-3"
      style={staggerIndex(1)}
    >
      <Building2 size={18} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {body}
        {connection.message && (
          <p role="status" className="text-[12px] text-ink-secondary">{connection.message}</p>
        )}
        {failed && <p role="alert" className="text-[12px] text-danger">{t("organization.actionFailed")}</p>}
      </div>
      {action}
    </div>
  );
}
