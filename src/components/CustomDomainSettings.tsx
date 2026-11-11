import { useEffect, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { SETTINGS_INPUT, SettingRow, SettingsEmptyRow, SettingsField, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

export interface CustomDomainStatus {
  publicUrl: string | null;
  customDomain: string | null;
  fallbackUrl: string | null;
  supported: boolean;
  appPort: number;
  webhookPort: number;
  serverIpv4?: string | null;
}

/** Preview only; the server validates. Keep the full DNS name rather than guessing a provider's zone (co.uk). */
export function customDomainDnsName(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[\s\\?#@%]/.test(value)) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const host = url.hostname.replace(/\.$/, "");
    if (url.protocol !== "https:" || url.port || url.pathname !== "/" || !host.includes(".")
      || host.length > 253 || /^[\d.]+$/.test(host)
      || !host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
      || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) return null;
    return host;
  } catch { return null; }
}

/** The DNS record to copy, as plain lines with a copy button each: no box of its own inside the card. */
export function CustomDomainDnsRecord({ domain, serverIpv4 }: { domain: string; serverIpv4?: string | null }) {
  const name = customDomainDnsName(domain);
  if (!name) return <p className="text-[12px] leading-4 text-ink-secondary">{t("settings.domain.enterDomain")}</p>;
  const rows = [
    [t("settings.domain.recordType"), "A"],
    [t("settings.domain.recordName"), name],
    [t("settings.domain.recordValue"), serverIpv4],
  ] as const;
  return (
    <section aria-label={t("settings.domain.dnsRecord")} className="flex flex-col gap-1.5">
      <p className="text-[13px] font-medium leading-[18px] text-ink">{t("settings.domain.dnsRecord")}</p>
      <dl className="flex flex-col">
        {rows.map(([label, value]) => (
          <div key={label} className="grid min-h-7 grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
            <dt className="text-[12px] leading-4 text-ink-secondary">{label}</dt>
            <dd className="min-w-0">{value
              ? <CopyValue key={value} value={value} label={t("settings.domain.copyField", { field: label })} />
              : <p className="text-[12px] leading-4 text-ink-secondary">{t("settings.domain.missingIp")}</p>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("settings.domain.recordHint")}</p>
    </section>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const { state, copy } = useCopyFeedback(value);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 select-all truncate font-mono text-[12px] leading-4 text-ink">{value}</code>
      <button type="button" onClick={copy} aria-label={state === "failed" ? t("common.copyFailed") : label}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-secondary hover:bg-menu-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
        {state === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      </button>
    </span>
  );
}

/** Security: a fixed placeholder, so a partially typed domain never becomes shell or Caddy configuration. */
export function customDomainProxyExample(status: Pick<CustomDomainStatus, "appPort" | "webhookPort">): string {
  return `bots.example.com {
    handle /hooks/* {
        reverse_proxy 127.0.0.1:${status.webhookPort}
    }
    handle {
        reverse_proxy 127.0.0.1:${status.appPort} {
            flush_interval -1
        }
    }
}`;
}

/** Advanced server setup: a fold row in the domain's own card (no native triangle); the steps join that card. */
export function CustomDomainGuide({ status, open = false, onToggle }: { status: CustomDomainStatus; open?: boolean; onToggle?: () => void }) {
  return <>
    <div data-settings-disclosure="domain-guide" data-settings-fold="">
      <button type="button" aria-expanded={open} onClick={onToggle}
        className="flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
        <span className="min-w-0 flex-1 text-[14px] leading-5 text-ink">{t("settings.domain.guide")}</span>
        <ChevronRight size={14} aria-hidden="true" className={cn("-mr-1 shrink-0 text-ink-tertiary transition-transform duration-150 motion-reduce:transition-none rtl:-scale-x-100", open && "rotate-90")} />
      </button>
    </div>
    <div hidden={!open} className="flex flex-col gap-3 px-4 py-3 text-[13px] leading-[18px] text-ink-secondary">
      <ol className="flex list-decimal flex-col gap-3 pl-4">
        <li>{t("settings.domain.dns")}</li>
        <li>
          {t("settings.domain.proxy")}
          <pre className="mt-2 overflow-x-auto font-mono text-[12px] leading-4 text-ink"><code>{customDomainProxyExample(status)}</code></pre>
          <p className="mt-2">{t("settings.domain.proxyHint")}</p>
        </li>
        <li>{t("settings.domain.verifyHint")}</li>
      </ol>
      <p>{t("settings.domain.loopbackWarning")}</p>
      {!status.serverIpv4 && <p>{t("settings.domain.ipAdminHint")}</p>}
      <p>{t("settings.domain.scope")}{" "}
        <a className="text-accent-text hover:underline focus-visible:underline" href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/self-hosting.md#connect-a-custom-domain-in-settings" target="_blank" rel="noopener noreferrer">{t("settings.domain.fullGuide")}</a>
      </p>
    </div>
  </>;
}

export function CustomDomainSettings() {
  const [status, setStatus] = useState<CustomDomainStatus | null>(null);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState<"loading" | "saving" | "removing" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [guide, setGuide] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api("/api/settings/custom-domain", { signal: controller.signal })
      .then((next: CustomDomainStatus) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        setDomain(next.customDomain ?? "");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("settings.domain.failed"));
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(null); });
    return () => controller.abort();
  }, []);

  const save = async (remove: boolean) => {
    setBusy(remove ? "removing" : "saving");
    setError(null);
    setNotice(null);
    try {
      const next: CustomDomainStatus = await api("/api/settings/custom-domain", {
        method: remove ? "DELETE" : "POST",
        ...(remove ? {} : { body: JSON.stringify({ domain: domain.trim() }) }),
      });
      setStatus(next);
      setDomain(next.customDomain ?? "");
      setNotice(remove ? t("settings.domain.removed") : t("settings.domain.saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.domain.failed"));
    } finally { setBusy(null); }
  };

  return (
    <SettingsGroup label={t("settings.domain.title")} description={t("settings.domain.subtitle")} block="address">
      <SettingsRows>
        {busy === "loading" && <SettingsEmptyRow><span role="status">{t("settings.domain.loading")}</span></SettingsEmptyRow>}
        {status && !status.supported && <SettingsEmptyRow>{t("settings.domain.serverOnly")}</SettingsEmptyRow>}
        {status?.supported && <>
          <form data-custom-domain-settings="" onSubmit={(event) => { event.preventDefault(); if (domain.trim() && !busy) void save(false); }} className="flex flex-col gap-3 px-4 py-3">
            <SettingsField label={t("settings.domain.label")}>
              <input id="custom-domain" type="text" value={domain} disabled={busy !== null} onChange={(event) => { setDomain(event.target.value); setNotice(null); setError(null); }}
                placeholder="bots.yourcompany.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={SETTINGS_INPUT} />
            </SettingsField>
            <CustomDomainDnsRecord domain={domain} serverIpv4={status.serverIpv4} />
            <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.domain.httpsNeeded")}</p>
            {notice && <p role="status" className="text-[12px] leading-4 text-ink-secondary">{notice}</p>}
            {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              {status.customDomain && <button type="button" disabled={busy !== null} onClick={() => void save(true)} data-danger="" className="settings-quiet mr-auto cursor-pointer">{busy === "removing" ? t("settings.domain.removing") : t("settings.domain.remove")}</button>}
              <button type="submit" disabled={!domain.trim() || busy !== null} className="ui-button ui-button-md ui-button-primary rounded-full">
                {busy === "saving" ? t("settings.domain.verifying") : t("settings.domain.verify")}
              </button>
            </div>
          </form>
          {status.publicUrl && <SettingRow title={t("settings.domain.current")} subtitle={<span className="break-all">{status.publicUrl}</span>}>{null}</SettingRow>}
          {status.customDomain && <SettingsEmptyRow>{status.fallbackUrl ? t("settings.domain.fallback", { url: status.fallbackUrl }) : t("settings.domain.noFallback")}</SettingsEmptyRow>}
          <CustomDomainGuide status={status} open={guide} onToggle={() => setGuide((value) => !value)} />
        </>}
        {!status?.supported && error && <SettingsEmptyRow><span role="alert" className="text-danger">{error}</span></SettingsEmptyRow>}
      </SettingsRows>
    </SettingsGroup>
  );
}
