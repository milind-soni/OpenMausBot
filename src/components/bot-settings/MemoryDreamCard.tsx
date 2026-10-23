import { useState, type ReactNode } from "react";

import { dreamNow, localizedRelativeTime, setNightlyDreams, type DreamReport, type UpkeepStatus } from "@/lib/memory";
import { activeLocale, t } from "@/lib/i18n";
import { Switch } from "../SettingsPrimitives";

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";

export function MemoryDreamCard({ botId, botName, status, onStatus, onDreamt }: {
  botId: string;
  botName: string;
  status: UpkeepStatus | null;
  onStatus: (status: UpkeepStatus) => void;
  /** The notes and their history changed: the section reloads them. */
  onDreamt: () => void;
}) {
  const [dreaming, setDreaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nightly = status?.dreams === true;

  const toggle = async () => {
    setSaving(true);
    setError("");
    try {
      onStatus(await setNightlyDreams(botId, !nightly));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const dream = async () => {
    setDreaming(true);
    setError("");
    try {
      const { report } = await dreamNow(botId);
      if (status) onStatus({ ...status, lastDream: report });
      onDreamt();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDreaming(false);
    }
  };

  return (
    <div className="rounded-xl bg-card p-4" data-memory-dream>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-ink">{t("memory.dream.title")}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("memory.dream.help", { name: botName })}</p>
        </div>
        <Switch checked={nightly} aria-label={t("memory.dream.nightly")} disabled={saving || !status} onClick={() => void toggle()}
          className="disabled:cursor-wait disabled:opacity-50" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={buttonCls} disabled={dreaming} onClick={() => void dream()}>
          {dreaming ? t("memory.dream.dreaming") : t("memory.dream.now")}
        </button>
        <span className="text-[12.5px] text-ink-secondary">
          {status?.lastDream
            ? t(status.lastDream.conversations === 1 ? "memory.dream.last.one" : "memory.dream.last.many", { time: localizedRelativeTime(status.lastDream.at, activeLocale()), count: status.lastDream.conversations })
            : t("memory.dream.never")}
        </span>
      </div>
      {error && <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p>}
      {status?.lastDream && <DreamResult report={status.lastDream} />}
    </div>
  );
}

function DreamResult({ report }: { report: DreamReport }) {
  const found = report.learned.length + report.outdated.length + report.ideas.length + report.aboutMe > 0;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-hairline/40 pt-3 text-[12.5px] leading-relaxed">
      {report.note && <p className="text-ink-secondary">{report.note}</p>}
      {!found && !report.note && <p className="text-ink-secondary">{t("memory.dream.nothing")}</p>}
      {report.learned.length > 0 && <DreamList title={t("memory.dream.learned")} items={report.learned.map((item) => (
        <>{item.text} <span className="text-ink-tertiary">{t("memory.dream.where", { file: item.where })}</span></>
      ))} />}
      {report.outdated.length > 0 && <DreamList title={t("memory.dream.updated")} items={report.outdated.map((item) => (
        <><s className="text-ink-tertiary">{item.was}</s> → {item.now}</>
      ))} />}
      {report.ideas.length > 0 && <DreamList title={t("memory.dream.ideas")} items={report.ideas} />}
      {report.aboutMe > 0 && <p className="text-ink-secondary">{t(report.aboutMe === 1 ? "memory.dream.aboutMe.one" : "memory.dream.aboutMe.many", { count: report.aboutMe })}</p>}
    </div>
  );
}

function DreamList({ title, items }: { title: string; items: ReactNode[] }) {
  return (
    <div>
      <div className="text-[12px] font-medium text-ink-secondary">{title}</div>
      <ul className="mt-1 list-disc pl-5 text-ink">
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  );
}
