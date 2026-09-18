// The readout under Settings → Wake word → Handy executable: which model Handy
// would transcribe with, what is on this computer, and which model this machine
// can carry.
//
// It is a pure function of props on purpose. Every component test in this repo
// renders static markup, where effects never run, so a panel that fetched its
// own status could not be tested at all — and the status itself is the part
// worth pinning.
//
// The pin is offered from Handy's *catalog* ids, not from the folders in its
// models directory: `--model parakeet-tdt-0.6b-v2-int8` is refused with "Model
// not found" while `--model parakeet-tdt-0.6b-v2` runs, so a folder name would
// produce a pin that breaks dictation. Entries Handy has not downloaded are
// refused the same way, which is why they are shown but not offered.
import { handyAdviceInstalled, recommendHandyModel } from "@/lib/handy";
import { t } from "@/lib/i18n";

/** The subset of the shell's HandyEngineStatus this panel reads. */
export interface HandyReadoutStatus {
  found: boolean;
  selected: string | null;
  installed: string[];
  /** Handy's catalog. Empty means "could not read", not "no models". */
  catalog: HandyReadoutCatalogEntry[];
  device: { cores: number; ramGB: number };
}

export interface HandyReadoutCatalogEntry {
  id: string;
  name: string;
  sizeMB: number;
  downloaded: boolean;
}

export interface HandyEngineReadoutProps {
  status: HandyReadoutStatus;
  /** The model id Astra pins for its own calls; "" follows Handy. */
  pinned: string;
  onPin: (model: string) => void;
}

export function HandyEngineReadout({ status, pinned, onPin }: HandyEngineReadoutProps) {
  const { catalog } = status;
  const advice = recommendHandyModel(status.device);
  const nameOf = (id: string) => catalog.find((model) => model.id === id)?.name ?? id;
  const downloaded = catalog.filter((model) => model.downloaded);
  // Without a catalog the folder names on disk are still true, just less
  // precise; with one, the catalog names are what Handy calls those models.
  const onDisk = catalog.length ? downloaded.map((model) => model.name) : status.installed;
  // "Installed" has to mean "runnable": a catalog entry Handy has not
  // downloaded, or one merely selected, cannot transcribe anything yet.
  const adviceInstalled = handyAdviceInstalled(advice, [
    ...downloaded.flatMap((model) => [model.id, model.name]),
    ...status.installed,
  ]);
  // Both of these are only judgeable with a catalog: a custom model is absent
  // from it and is not therefore missing.
  const pinnedMissing = Boolean(pinned) && catalog.length > 0 && !downloaded.some((model) => model.id === pinned);
  // A pin whose model was since removed from Handy stays visible and selected,
  // rather than silently snapping back to Handy's own choice.
  const choices = [
    ...downloaded.map((model) => ({ id: model.id, label: `${model.name} (${model.sizeMB} MB)` })),
    ...(pinned && !downloaded.some((model) => model.id === pinned)
      ? [
          {
            id: pinned,
            label: pinnedMissing
              ? `${nameOf(pinned)} — ${t("settings.wakeWord.engine.notDownloaded")}`
              : nameOf(pinned),
          },
        ]
      : []),
  ];

  return (
    <div className="rounded-lg border border-hairline/30 bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
      <div className="mb-1 text-[13px] font-medium text-ink">{t("settings.wakeWord.engine.title")}</div>
      {status.found ? (
        <div>
          {t("settings.wakeWord.engine.selected")}:{" "}
          <span className="text-ink">
            {status.selected ? nameOf(status.selected) : t("settings.wakeWord.engine.selectedUnknown")}
          </span>
        </div>
      ) : (
        <div role="status" className="text-danger">
          {t("settings.wakeWord.engine.missing")}
        </div>
      )}
      <div>
        {t("settings.wakeWord.engine.installed")}:{" "}
        {onDisk.length ? onDisk.join(", ") : t("settings.wakeWord.engine.installedNone")}
      </div>
      <div className="mt-1">
        {t("settings.wakeWord.engine.advice", {
          model: advice.label,
          cores: status.device.cores,
          ram: status.device.ramGB,
        })}{" "}
        {adviceInstalled
          ? t("settings.wakeWord.engine.adviceInstalled")
          : t("settings.wakeWord.engine.adviceMissing")}
        <div className="mt-0.5">
          {t(advice.reasonKey, { cores: status.device.cores, ram: status.device.ramGB })}
        </div>
      </div>
      {pinnedMissing ? (
        <div role="status" className="mt-1 text-danger">
          {t("settings.wakeWord.engine.pinMissing", { model: nameOf(pinned) })}
        </div>
      ) : null}
      <label className="mt-2 block">
        <span className="mb-1 block">{t("settings.wakeWord.engine.pin")}</span>
        <select
          aria-label={t("settings.wakeWord.engine.pin")}
          value={pinned}
          onChange={(event) => onPin(event.target.value)}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
        >
          <option value="">{t("settings.wakeWord.engine.pinFollow")}</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block">{t("settings.wakeWord.engine.pinHint")}</span>
      </label>
    </div>
  );
}
