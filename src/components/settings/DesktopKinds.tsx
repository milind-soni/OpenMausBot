import { useCallback, useEffect, useState } from "react";
import { Cloud, Laptop, Server } from "lucide-react";
import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { computerInventoryRequest } from "@/lib/computer-requests";
import { useStore } from "@/state/store";
import { LocalComputerSection } from "../LocalComputerSection";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsMark, SettingsRows, StatusDot } from "../SettingsPrimitives";
import { useAccountSummary } from "./account-summary";
import { useOtherPlaces } from "./settings-context";
import { SettingsDialog } from "./SettingsDialog";
import { useSettingsShell } from "./settings-shell";

type PrivateStatus = { runtime: string | null; daemonUp: boolean; image: boolean; ready: boolean } | null;
type Kind = "ready" | "setup" | "none" | "attention" | "elsewhere";

const read = async <T,>(which: "status" | "cloud" | "vps"): Promise<T | null> => {
  const response = await fetch(...computerInventoryRequest(which)).catch(() => null);
  if (!response?.ok) return null;
  return await response.json().catch(() => null) as T | null;
};

function statusLine(kind: Kind, place: string): { tone: "success" | "warning" | null; text: string } {
  if (kind === "ready") return { tone: "success", text: t("settings.ai.ready") };
  if (kind === "attention") return { tone: "warning", text: t("settings.ai.attention") };
  if (kind === "setup") return { tone: null, text: t("settings.desktops.needsSetup") };
  if (kind === "elsewhere") return { tone: null, text: t("settings.account.onPlace", { place }) };
  return { tone: null, text: t("settings.ai.notSetUp") };
}

/** The steps a private desktop needs, in plain words; the builder's own panel only behind Details. */
function PrivateSetup({ status, onCheck, onClose }: { status: PrivateStatus; onCheck: () => void; onClose: () => void }) {
  const [details, setDetails] = useState(false);
  const steps = [
    { title: t("settings.desktops.step1"), done: Boolean(status?.runtime) },
    { title: t("settings.desktops.step2"), done: Boolean(status?.daemonUp) },
    { title: t("settings.desktops.step3"), done: Boolean(status?.image) },
  ];
  return (
    <SettingsDialog title={t("settings.desktops.setupTitle")} onClose={onClose}
      footer={<>
        <button type="button" className="ui-button mr-auto" onClick={() => setDetails((open) => !open)}>{t(details ? "settings.desktops.hideDetails" : "settings.desktops.details")}</button>
        <button type="button" className="ui-button" onClick={onClose}>{t("common.close")}</button>
        <button type="button" className="ui-button ui-button-primary" onClick={onCheck}>{t("settings.desktops.checkAgain")}</button>
      </>}>
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.desktops.stepsLine", { app: productName() })}</p>
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li key={step.title} data-desktop-step={index + 1} data-done={step.done ? "" : undefined} className="flex items-center gap-3 text-[14px] leading-5 text-ink">
            <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[12px] font-medium leading-4 text-ink-secondary">{step.done ? "✓" : index + 1}</span>
            {step.title}
          </li>
        ))}
      </ol>
      {details && <div data-desktop-details="" className="max-h-[40vh] overflow-y-auto"><LocalComputerSection privateOnly /></div>}
    </SettingsDialog>
  );
}

/** Desktops: what each kind is, its state first, and one Set up. */
export function DesktopKinds() {
  const { ctx, place, go } = useSettingsShell();
  const { state } = useStore();
  const cloudHome = state.config?.cloudHome === true;
  const [local, setLocal] = useState<PrivateStatus>(null);
  const [cloud, setCloud] = useState<{ configured: boolean; available: boolean } | null>(null);
  const [vps, setVps] = useState<{ configured: boolean; available: boolean } | null>(null);
  const [setup, setSetup] = useState(false);
  const load = useCallback(() => {
    if (!cloudHome) void read<PrivateStatus>("status").then(setLocal);
    void read<{ configured: boolean; available: boolean }>("cloud").then(setCloud);
    void read<{ configured: boolean; available: boolean }>("vps").then(setVps);
  }, [cloudHome]);
  useEffect(load, [load]);
  const summary = useAccountSummary();
  const others = useOtherPlaces("desktops");
  const myCloud = others.find((other) => other.kind === "cloud");
  // With a paid plan, Cloud desktops are My Cloud's: on This computer the row says so and goes there.
  const onMyCloud = !cloudHome && summary.paid && !cloud?.configured;
  const privateKind: Kind = local?.ready ? "ready" : local?.runtime ? "setup" : "none";
  const cloudKind: Kind = cloudHome ? "elsewhere" : onMyCloud ? "elsewhere" : cloud?.configured ? (cloud.available ? "ready" : "attention") : "none";
  const serversKind: Kind = vps?.configured ? (vps.available ? "ready" : "attention") : "none";
  const row = (kind: Kind, title: string, line: string, icon: React.ReactNode, onSetUp: () => void, data: string) => {
    const status = statusLine(kind, onMyCloud && data === "cloud" ? myCloud?.name ?? t("cloudSetup.myCloud") : place.name);
    if (kind === "elsewhere" && onMyCloud && data === "cloud") {
      return (
        <div data-desktop-kind={data} className="contents">
          <SettingsLinkRow title={title} leading={<SettingsMark>{icon}</SettingsMark>} subtitle={<><StatusDot tone={status.tone} />{status.text} · {line}</>}
            external onClick={() => myCloud?.open()} data={{ "data-desktop-elsewhere": "" }} />
        </div>
      );
    }
    return (
      <div data-desktop-kind={data} className="contents">
        <SettingRow title={title} leading={<SettingsMark>{icon}</SettingsMark>}
          subtitle={<><StatusDot tone={status.tone} />{status.text} · {line}</>}>
          {kind !== "elsewhere" && <button type="button" className="ui-button" onClick={onSetUp}>{t(kind === "ready" ? "settings.simple.ai.manage" : "settings.simple.ai.setUp")}</button>}
        </SettingRow>
      </div>
    );
  };
  return (
    <SettingsGroup label={t("settings.desktops.kinds")} block="desktops">
      <SettingsRows icons>
        {row(cloudKind, t("settings.desktops.cloud"), t("settings.desktops.cloudLine"), <Cloud strokeWidth={1.75} />, () => go(ctx.plan && !cloud?.configured ? "plan" : "ai", ctx.plan && !cloud?.configured ? undefined : "ai-keys"), "cloud")}
        {!cloudHome && row(privateKind, t("settings.desktops.private"), t("settings.desktops.privateLine"), <Laptop strokeWidth={1.75} />, () => setSetup(true), "private")}
        {(ctx.advanced || vps?.configured) && row(serversKind, t("settings.desktops.servers"), t("settings.desktops.serversLine"), <Server strokeWidth={1.75} />, () => go("ai", "ai-keys"), "servers")}
      </SettingsRows>
      {setup && <PrivateSetup status={local} onCheck={load} onClose={() => setSetup(false)} />}
    </SettingsGroup>
  );
}
