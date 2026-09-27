import { NationIntegrationAdmin } from "./NationIntegrationAdmin";
import { NationCreditAdmin } from "./NationCreditAdmin";
import { NationAgentControls } from "./NationAgentControls";
/**
 * Nation Admin Page — accessible only to the account owner (product admin).
 *
 * Dedicated /admin entry: provider status and billing, without the chat shell.
 * The server authorizes every admin endpoint; this component also waits for
 * its authoritative owner verdict before rendering controls.
 */
import { useState } from "react";
import { CheckCircle2, ChevronLeft, Loader2, Server, ShieldCheck, SlidersHorizontal, XCircle } from "lucide-react";
import { api } from "@/lib/api-client";
import { signInPath } from "@/lib/session";
import type { ConfigStatus } from "@/state/store";

export type NationAdminConfig = Pick<ConfigStatus, "isProductOwner" | "adminGate" | "nationOpenrouter"> & Partial<Pick<ConfigStatus, "composio" | "box" | "hostedComputers" | "vps" | "webTools">>;
import { isProductAdmin } from "@/lib/admin-gate";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

// ── OpenRouter section ───────────────────────────────────────────────────────

interface OpenRouterAdminStatus {
  configured: boolean;
  model: string;
  testResult?: { ok: boolean; message: string };
}

function OpenRouterSection({ config }: { config: NationAdminConfig }) {
  const status = config.nationOpenrouter;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result: OpenRouterAdminStatus = await api("/api/admin/openrouter/test", {
        method: "POST",
        body: "{}",
      });
      setTestResult(result.testResult ?? { ok: false, message: "No result returned" });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      title="NATION API"
      subtitle="Nation's upstream AI provider. The API key is server-only and never sent to clients."
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full",
              status?.configured
                ? "bg-success/15 text-success"
                : "bg-warning/15 text-warning",
            )}
          >
            {status?.configured ? (
              <CheckCircle2 size={18} aria-hidden="true" />
            ) : (
              <XCircle size={18} aria-hidden="true" />
            )}
          </span>
          <div>
            <div className="text-[14px] font-medium text-ink">
              {status?.configured
                ? "OPENROUTER_API_KEY is configured"
                : "OPENROUTER_API_KEY is not set"}
            </div>
            {status?.model && (
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                Active model: <code className="rounded bg-inset px-1 py-px text-[11px]">{status.model}</code>
              </div>
            )}
          </div>
        </div>

        {status?.configured && (
          <div>
            <button
              type="button"
              disabled={testing}
              onClick={() => void runTest()}
              className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-wait disabled:opacity-50"
            >
              {testing ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
              {testing ? "Testing…" : "Test connection"}
            </button>
            {testResult && (
              <p
                role="status"
                className={cn(
                  "mt-2 text-[12px]",
                  testResult.ok ? "text-success" : "text-danger",
                )}
              >
                {testResult.ok ? "✓ " : "✗ "}
                {testResult.message}
              </p>
            )}
          </div>
        )}

        <div className="border-t border-hairline/30 pt-3">
          <p className="text-[12px] leading-relaxed text-ink-secondary">
            Set <code className="rounded bg-inset px-1 py-px text-[11px]">OPENROUTER_API_KEY</code> and optionally{" "}
            <code className="rounded bg-inset px-1 py-px text-[11px]">NATION_OPENROUTER_MODEL</code> in your server environment.
            The key never leaves the server; clients see only a configured/not-configured boolean.
          </p>
        </div>
      </div>
    </Card>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

const TABS = [
  { id: "openrouter", label: "NATION API", icon: Server },
  { id: "controls", label: "Agent controls", icon: SlidersHorizontal },
  { id: "credits", label: "Credits", icon: ShieldCheck },
  { id: "integrations", label: "Apps & computers", icon: Server },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function NationAdminPage({ config }: { config: NationAdminConfig | null }) {
  const [tab, setTab] = useState<TabId>(() => window.location?.hash === "#integrations" ? "integrations" : window.location?.hash === "#controls" ? "controls" : "openrouter");

  const admin = isProductAdmin({
    remoteClient: Boolean(window.ogb?.remoteClient),
    pinRequired: config?.adminGate?.pinRequired,
    isProductOwner: config?.isProductOwner,
  });

  if (!admin) {
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app px-6 text-ink-secondary">
        <ShieldCheck size={32} className="text-ink-secondary/50" />
        <div className="text-center">
          <div className="text-[15px] font-semibold text-ink">Admin access required</div>
          <div className="mt-1 text-[13px]">This page is only available to the account owner.</div>
        </div>
        {config?.isProductOwner !== true ? (
          <a href={signInPath()} className="ui-button mt-2">Sign in as owner</a>
        ) : null}
        <a
          href="/swarm/"
          className="mt-2 flex items-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
        >
          <ChevronLeft size={14} />
          Back to Swarm
        </a>
      </main>
    );
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="flex items-center justify-between border-b border-hairline/30 px-6 py-3">
        <a href="/admin" className="text-sm font-semibold tracking-wide text-ink">NATION / ADMIN</a>
        <a href="/swarm/" className="text-sm text-ink-secondary hover:text-ink">Back to Swarm</a>
      </div>
      {/* Header */}
      <div className="shrink-0 border-b border-hairline/30 px-6 py-4">
        <div className="flex items-center gap-3">
          <ShieldCheck size={20} className="text-accent" />
          <div>
            <h1 className="text-[16px] font-semibold text-ink">Nation Admin</h1>
            <p className="text-[12px] text-ink-secondary">Owner controls for NATION API, apps, and computers</p>
          </div>
        </div>
        {/* Tab bar */}
        <div className="mt-4 flex flex-wrap gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] transition-colors",
                tab === id
                  ? "bg-control font-medium text-ink"
                  : "text-ink-secondary hover:bg-control/50 hover:text-ink",
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-[700px]">
          {tab === "openrouter" && <OpenRouterSection config={config!} />}
          {tab === "controls" && <NationAgentControls />}
          {tab === "credits" && <NationCreditAdmin />}
          {tab === "integrations" && <NationIntegrationAdmin config={config!} />}
        </div>
      </div>
    </main>
  );
}
