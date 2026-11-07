// Settings → Daily: today's check-in for every hub platform and each worker's remaining allowance, on one page.
// Both read through server/hub-bridge.ts, so a phone needs neither the console's origin nor a second sign-in.
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

/** One platform's answer from /hub/checkin/status. Only the fields the console fills today are listed. */
type CheckinPlatform = {
  available?: boolean;
  source?: string;
  lastDate?: string;
  lastTime?: string;
  status?: string;
  message?: string;
  pendingReason?: string;
  credits?: number | string;
  consecutiveDays?: number;
  accountCount?: number;
  signedAccounts?: number;
};

type CheckinStatus = {
  ok?: boolean;
  today?: string;
  autoCheckin?: boolean;
  autoCheckinTime?: string;
  platforms?: Record<string, CheckinPlatform>;
};

/** One allowance row from /hub/quota. Workers fill different subsets: a credit balance has used/total only. */
type Quota = {
  name?: string;
  displayName?: string;
  used?: number;
  total?: number;
  remaining?: number;
  remainingPercentage?: number;
  resetAt?: string;
  unlimited?: boolean;
  recurring?: boolean;
  isCreditBalance?: boolean;
  unit?: string;
};

type QuotaWorker = {
  worker: string;
  fetchedAt?: string;
  account?: string;
  plan?: string;
  message?: string;
  quotas?: Quota[];
};

type QuotaReport = { updatedAt?: string; workers?: Record<string, QuotaWorker> };

/** Brand names the hub uses as keys; anything new still renders, with the key title-cased. */
const PLATFORM_NAMES: Record<string, string> = {
  workbuddy: "WorkBuddy",
  codebuddy: "CodeBuddy",
  "codebuddy-cn": "CodeBuddy CN",
  traecode: "TRAE",
  codearts: "CodeArts",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  minimaxcode: "MiniMax Code",
  mimocode: "MiMo Code",
  meoo: "Meoo",
  zcode: "ZCode",
  "github-copilot": "GitHub Copilot",
  antigravity: "Antigravity",
};

function platformName(key: string): string {
  const known = PLATFORM_NAMES[key];
  if (known) return known;
  return key.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function statusLabel(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "success":
    case "done":
    case "ok":
      return t("settings.daily.statusSuccess");
    case "pending":
    case "waiting":
      return t("settings.daily.statusPending");
    case "failure":
    case "failed":
    case "error":
      return t("settings.daily.statusFailed");
    default:
      return t("settings.daily.statusPending");
  }
}

function statusTone(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "success":
    case "done":
    case "ok":
      return "bg-success/12 text-success";
    case "failure":
    case "failed":
    case "error":
      return "bg-danger/12 text-danger";
    default:
      return "bg-ink/[0.07] text-ink-secondary";
  }
}

/** Credits arrive as a number or a preformatted string; empty is the same as none. */
function creditsText(credits: number | string | undefined): string {
  if (typeof credits === "number") return credits > 0 ? credits.toLocaleString(intlLocale()) : "";
  return typeof credits === "string" ? credits.trim() : "";
}

function lastCheckinText(platform: CheckinPlatform): string {
  if (!platform.lastDate) return t("settings.daily.lastCheckinNone");
  const time = platform.lastTime ? ` ${platform.lastTime}` : "";
  return t("settings.daily.lastCheckin", { when: `${platform.lastDate}${time}` });
}

function resetText(at: string | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return t("settings.daily.reset", {
    when: date.toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  });
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Remaining share of one allowance, or null when it is unlimited or has no total to divide by. */
function remainingShare(quota: Quota): number | null {
  if (quota.unlimited) return null;
  if (typeof quota.remainingPercentage === "number" && Number.isFinite(quota.remainingPercentage)) {
    return clampPercent(quota.remainingPercentage);
  }
  const total = typeof quota.total === "number" ? quota.total : 0;
  if (total <= 0) return null;
  const remaining = typeof quota.remaining === "number" ? quota.remaining : total - (quota.used ?? 0);
  return clampPercent((remaining / total) * 100);
}

function amount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  return value.toLocaleString(intlLocale(), { maximumFractionDigits: 1 });
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="mt-3 flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-12 animate-pulse rounded-lg bg-ink/[0.06] motion-reduce:animate-none" />
      ))}
    </div>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 p-3">
      <div className="text-[13px] font-medium text-ink">{t("settings.daily.unreachable")}</div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.daily.unreachableHelp")}</p>
      <button type="button" className="ui-button mt-2 flex items-center gap-1.5" onClick={onRetry}>
        <RefreshCw size={13} aria-hidden="true" />
        {t("settings.daily.retry")}
      </button>
    </div>
  );
}

export function DailySection() {
  const [checkin, setCheckin] = useState<CheckinStatus | null>(null);
  const [checkinDown, setCheckinDown] = useState(false);
  const [loadingCheckin, setLoadingCheckin] = useState(true);
  const [running, setRunning] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const [quota, setQuota] = useState<QuotaReport | null>(null);
  const [quotaDown, setQuotaDown] = useState(false);
  const [loadingQuota, setLoadingQuota] = useState(true);

  const loadCheckin = useCallback(async () => {
    try {
      const next = await api<CheckinStatus>("/hub/checkin/status");
      setCheckin(next);
      setCheckinDown(false);
    } catch {
      setCheckinDown(true);
    } finally {
      setLoadingCheckin(false);
    }
  }, []);

  const loadQuota = useCallback(async () => {
    try {
      const next = await api<QuotaReport>("/hub/quota");
      setQuota(next);
      setQuotaDown(false);
    } catch {
      setQuotaDown(true);
    } finally {
      setLoadingQuota(false);
    }
  }, []);

  useEffect(() => {
    void loadCheckin();
    void loadQuota();
  }, [loadCheckin, loadQuota]);

  // A run really checks in everywhere and the console gives it up to two minutes, so the button stays shut until the
  // fresh status is back rather than reporting a success nobody read.
  const runNow = async () => {
    if (running) return;
    setRunning(true);
    setRunFailed(false);
    try {
      await api("/hub/checkin/run", { method: "POST", body: JSON.stringify({ platform: "all" }), timeoutMs: 180_000 });
    } catch {
      setRunFailed(true);
    }
    await loadCheckin();
    setRunning(false);
  };

  const platforms = Object.entries(checkin?.platforms ?? {});
  const workers = Object.entries(quota?.workers ?? {});
  const todayLabel = checkin?.today
    ? t("settings.daily.today", { date: checkin.today })
    : t("settings.daily.todayUnknown");
  const autoLabel = checkin?.autoCheckin && checkin.autoCheckinTime
    ? t("settings.daily.autoAt", { time: checkin.autoCheckinTime })
    : "";

  return (
    <div className="flex flex-col gap-4" data-daily>
      <Card title={t("settings.daily.checkin")} subtitle={t("settings.daily.checkinHelp")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[12px] text-ink-secondary">{todayLabel}</p>
            {autoLabel && <p className="mt-0.5 text-[12px] text-ink-tertiary">{autoLabel}</p>}
          </div>
          <button
            type="button"
            className="ui-button ui-button-primary flex shrink-0 items-center gap-1.5"
            disabled={running || loadingCheckin}
            onClick={() => void runNow()}
          >
            {running && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {running ? t("settings.daily.running") : t("settings.daily.run")}
          </button>
        </div>
        {runFailed && (
          <p className="mt-2 text-[12px] leading-relaxed text-warning" role="status">{t("settings.daily.runFailed")}</p>
        )}
        {loadingCheckin ? (
          <Skeleton rows={3} />
        ) : checkinDown ? (
          <Unreachable onRetry={() => { setLoadingCheckin(true); void loadCheckin(); }} />
        ) : platforms.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink-secondary">{t("settings.daily.emptyPlatforms")}</p>
        ) : (
          // A rail, not a column: the platforms are peers, and on a phone a swipe reads faster than a scroll
          // through eight rows. Cards stretch to the tallest one so the count and the time line up across swipes.
          <div
            className="mt-3 flex snap-x snap-mandatory items-stretch gap-2 overflow-x-auto overscroll-x-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-daily-platforms
          >
            {platforms.map(([key, platform]) => {
              const credits = creditsText(platform.credits);
              const accounts = typeof platform.accountCount === "number" && platform.accountCount > 1
                ? t("settings.daily.accounts", { count: platform.accountCount })
                : "";
              return (
                <div
                  key={key}
                  className="flex w-[248px] shrink-0 snap-start flex-col rounded-lg border border-hairline/40 p-3 sm:w-[268px]"
                  data-daily-platform
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium text-ink">{platformName(key)}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", statusTone(platform.status))}>
                          {statusLabel(platform.status)}
                        </span>
                        {accounts && <span className="text-[11px] text-ink-tertiary">{accounts}</span>}
                      </div>
                      <p className="mt-0.5 text-[12px] text-ink-secondary">{lastCheckinText(platform)}</p>
                    </div>
                    {credits && (
                      <div className="shrink-0 text-right">
                        <div className="text-[11px] text-ink-tertiary">{t("settings.daily.credits")}</div>
                        <div className="text-[13px] font-medium text-ink">+{credits}</div>
                      </div>
                    )}
                  </div>
                  {platform.message && (
                    <p className="mt-1.5 line-clamp-2 flex-1 break-words text-[11px] leading-relaxed text-ink-tertiary" title={platform.message}>
                      {platform.message}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title={t("settings.daily.quota")} subtitle={t("settings.daily.quotaHelp")}>
        {loadingQuota ? (
          <Skeleton rows={2} />
        ) : quotaDown ? (
          <Unreachable onRetry={() => { setLoadingQuota(true); void loadQuota(); }} />
        ) : workers.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink-secondary">{t("settings.daily.emptyQuota")}</p>
        ) : (
          // Same rail treatment as the check-in row: ten providers in a two-column grid meant the last
          // few were pushed below the fold, and their cards had wildly different heights.
          <div
            className="mt-3 flex snap-x snap-mandatory items-stretch gap-2 overflow-x-auto overscroll-x-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-daily-workers
          >
            {workers.map(([key, worker]) => (
              // Fixed height, not min-height: every card matches the tallest, and a provider with six
              // allowance buckets scrolls inside instead of stretching the row.
              <div
                key={key}
                className="flex h-[17rem] w-[300px] shrink-0 snap-start flex-col rounded-lg border border-hairline/40 p-3 sm:w-[320px]"
                data-daily-worker
              >
                <div className="min-w-0 shrink-0">
                  <div className="truncate text-[13px] font-medium text-ink">{platformName(worker.worker || key)}</div>
                  {(worker.account || worker.plan) && (
                    <p className="mt-0.5 truncate text-[12px] text-ink-secondary">
                      {/* The plan usually repeats the account; one line is enough. */}
                      {worker.account && worker.plan?.includes(worker.account)
                        ? worker.plan
                        : [worker.account, worker.plan].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
                {(worker.quotas ?? []).length > 0 ? (
                  // min-h-0 is what lets this flex child actually scroll instead of growing the card.
                  <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
                    {(worker.quotas ?? []).map((entry, index) => {
                      const share = remainingShare(entry);
                      const used = share === null ? 0 : 100 - share;
                      const low = share !== null && share < 20;
                      return (
                        <div key={`${entry.name ?? entry.displayName ?? index}`} className="min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 truncate text-[12px] text-ink">{entry.displayName || entry.name || "–"}</span>
                            <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">
                              {share === null ? t("settings.daily.unlimited") : `${Math.round(share)}%`}
                            </span>
                          </div>
                          <div
                            className="mt-1 h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-ink/[0.08]"
                            data-daily-quota-track
                            role="img"
                            aria-label={`${entry.displayName || entry.name || ""} · ${t("settings.daily.used")} ${amount(entry.used)} / ${entry.unlimited ? t("settings.daily.unlimited") : amount(entry.total)}`}
                          >
                            <div
                              className={cn("h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none", low ? "bg-warning" : "bg-accent")}
                              style={{ width: share === null ? "100%" : `${used}%` }}
                            />
                          </div>
                          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] text-ink-tertiary">
                            <span className="min-w-0 truncate">
                              {t("settings.daily.used")} {amount(entry.used)}
                              {entry.unlimited ? "" : ` / ${amount(entry.total)}`}
                            </span>
                            {resetText(entry.resetAt) && <span className="shrink-0">{resetText(entry.resetAt)}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-2 min-h-0 flex-1 overflow-y-auto break-words pr-1 text-[11px] leading-relaxed text-ink-tertiary [scrollbar-width:thin]">
                    {worker.message || t("settings.daily.noQuota")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        {quota?.updatedAt && !loadingQuota && !quotaDown && (
          <p className="mt-3 text-[11px] text-ink-tertiary">
            {t("settings.daily.updatedAt", {
              when: new Date(quota.updatedAt).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
            })}
          </p>
        )}
      </Card>
    </div>
  );
}
