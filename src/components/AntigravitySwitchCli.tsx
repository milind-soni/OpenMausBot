import { useState } from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";

import { api, type InstanceInfo } from "@/state/store";
import { useStoreActions } from "@/state/store-select";
import { t } from "@/lib/i18n";
import { runsAntigravityCli } from "./EngineSetup";

/** A Google account that runs the Classic runtime because nothing named another: no path, the retired `agy`, or the
 * pinned runtime's own name. A path of the person's own is theirs to change. */
export function offersAntigravityCliSwitch(instance: InstanceInfo): boolean {
  if (instance.driverKind !== "antigravityAgent" || instance.snapshot.state !== "available" || runsAntigravityCli(instance)) return false;
  return /^(?:|agy|agy_acp_server)$/iu.test(instance.cli?.trim() ?? "");
}

/** The one way from the Classic runtime to Google's Antigravity CLI, and one way only: the account's CLI path becomes
 * `antigravity` and the CLI is installed. When the install fails the path goes back, so a working account keeps working. */
export function AntigravitySwitchCli({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStoreActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!offersAntigravityCliSwitch(instance) && !busy) return null;
  const path = `/api/instances/${encodeURIComponent(instance.instanceId)}`;
  const setCli = (cli: string) => api(path, { method: "PATCH", body: JSON.stringify({ cli }) });
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await setCli("antigravity");
      try {
        await api(`${path}/install`, { method: "POST" });
      } catch (cause) {
        await setCli(instance.cli ?? "").catch(() => {});
        throw cause;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await refreshInstances().catch(() => {});
      setBusy(false);
    }
  };
  return (
    <div data-antigravity-switch-cli className="mt-3 rounded-xl border border-hairline/60 bg-app p-2.5">
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("engines.antigravity.switchCliNote")}</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] font-semibold text-ink hover:bg-raised-hover disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
        {busy ? t("engineSetup.installing") : t("engines.antigravity.switchCli")}
      </button>
      {error && <p role="alert" className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-danger">{error}</p>}
    </div>
  );
}
