import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api } from "@/state/store";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { LearnMore, SETTINGS_INPUT, SettingRow, SettingsEmptyRow, SettingsField, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { SettingsSkeletonRows } from "./settings/SettingsStates";

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

/** The self-hosting guide's section on custom domains: the server steps (DNS, the HTTPS proxy, ports) live there, behind
 * the row's Learn more, never inline in Settings. */
export const CUSTOM_DOMAIN_GUIDE_URL = "https://github.com/milind-soni/OpenMausBot/blob/main/docs/self-hosting.md#connect-a-custom-domain-in-settings";

export function CustomDomainSettings() {
  const [status, setStatus] = useState<CustomDomainStatus | null>(null);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState<"loading" | "saving" | "removing" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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

  // Address (§2.2): one row, "Your domain", with Connect domain opening the form in a fold under a divider: the field,
  // the DNS record to copy, one helper line, and Save right-aligned 8 below. Only a self-hosted server shows it.
  const connected = Boolean(status?.customDomain);
  return (
    <SettingsGroup label={t("settings.domain.title")} block="address">
      <SettingsRows>
        {busy === "loading" && <SettingsSkeletonRows />}
        {status && !status.supported && <SettingsEmptyRow>{t("settings.domain.serverOnly")}</SettingsEmptyRow>}
        {status?.supported && <>
          <SettingRow title={t("settings.domain.label")}
            subtitle={connected && status.publicUrl ? <span className="break-all">{status.publicUrl}</span>
              : <>{t("settings.domain.rowLine")}{" "}<LearnMore href={CUSTOM_DOMAIN_GUIDE_URL} /></>}
            message={!open && notice ? <span role="status">{notice}</span> : undefined}>
            <button type="button" className="ui-button" aria-expanded={open} data-custom-domain-open="" onClick={() => setOpen(!open)}>
              {t(open ? "common.close" : connected ? "settings.domain.change" : "settings.domain.verify")}
            </button>
          </SettingRow>
          {open && (
            <form data-custom-domain-settings="" onSubmit={(event) => { event.preventDefault(); if (domain.trim() && !busy) void save(false); }} className="flex flex-col gap-2 px-4 pb-4 pt-3">
              <SettingsField label={t("settings.domain.label")} hint={error ? <span role="alert" className="text-danger">{error}</span> : notice ? <span role="status">{notice}</span> : t("settings.domain.httpsFirst")}>
                <input id="custom-domain" type="text" value={domain} disabled={busy !== null} onChange={(event) => { setDomain(event.target.value); setNotice(null); setError(null); }}
                  placeholder="bots.yourcompany.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={SETTINGS_INPUT} />
              </SettingsField>
              <CustomDomainDnsRecord domain={domain} serverIpv4={status.serverIpv4} />
              <div className="flex items-center justify-end gap-2" data-settings-form-foot="">
                {status.customDomain && <button type="button" disabled={busy !== null} onClick={() => void save(true)} data-danger="" className="settings-quiet mr-auto -ms-1.5 cursor-pointer">{busy === "removing" ? t("settings.domain.removing") : t("settings.domain.remove")}</button>}
                <button type="submit" disabled={!domain.trim() || busy !== null} className="ui-button ui-button-md ui-button-primary rounded-full">
                  {busy === "saving" ? t("settings.domain.verifying") : t("settings.domain.verify")}
                </button>
              </div>
            </form>
          )}
          {open && status.customDomain && <SettingsEmptyRow>{status.fallbackUrl ? t("settings.domain.fallback", { url: status.fallbackUrl }) : t("settings.domain.noFallback")}</SettingsEmptyRow>}
        </>}
        {!status?.supported && error && <SettingsEmptyRow><span role="alert" className="text-danger">{error}</span></SettingsEmptyRow>}
      </SettingsRows>
    </SettingsGroup>
  );
}
