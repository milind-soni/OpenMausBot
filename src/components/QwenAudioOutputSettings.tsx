import { useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";
import { qwenAudioOutput, type OutputError } from "@/lib/qwen-audio-output";
import { Select } from "./Select";

const ERRORS = {
  unsupported: "call.live.output.unsupported",
  permission: "call.live.output.permission",
  missing: "call.live.output.missing",
  unavailable: "call.live.output.unavailable",
  restore: "call.live.output.restore",
  playback: "call.live.output.playback",
} as const satisfies Record<OutputError, string>;

export function QwenPlaybackRecovery({ controller = qwenAudioOutput }: { controller?: typeof qwenAudioOutput }) {
  const output = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!output.active || !output.playbackPaused) return null;
  return <div className="flex flex-wrap items-center gap-2">
    <span role="status" className="text-[12px] text-warning">{t("call.live.output.playback")}</span>
    <button data-qwen-audio-resume type="button" className="ui-button" onClick={() => void controller.resumePlayback()}>{t("call.live.output.resume")}</button>
  </div>;
}

export function QwenAudioOutputSettings({ controller = qwenAudioOutput }: { controller?: typeof qwenAudioOutput }) {
  const output = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const devices = output.supported ? output.devices : [];
  const selectedId = output.supported ? output.selectedId : "";
  const missing = selectedId && !devices.some((device) => device.deviceId === selectedId);
  return <div data-qwen-output className="flex flex-col gap-2 border-t border-hairline/60 pt-2">
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-secondary">{t("call.live.output.label")}</span>
      <Select size="sm" value={selectedId} disabled={!output.supported || output.busy} aria-label={t("call.live.output.label")}
        onChange={(event) => void controller.select(event.target.value)}>
        <option value="">{t("call.live.output.default")}</option>
        {missing && <option value={selectedId}>{t("call.live.output.current")}</option>}
        {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>
          {device.label || t("call.live.output.device", { number: index + 1 })}
        </option>)}
      </Select>
    </label>
    {output.supported ? <>
      <button type="button" disabled={output.busy} className="ui-button self-start" onClick={() => void controller.choose()}>{t("call.live.output.choose")}</button>
      <div className="text-[12px] text-ink-tertiary">{t(output.active ? "call.live.output.active" : "call.live.output.next")}</div>
      {!output.pickerAvailable && <div className="text-[12px] text-ink-tertiary">{t("call.live.output.permissionHint")}</div>}
      {output.error && output.error !== "playback" && <div role="status" className="text-[12px] text-warning">{t(ERRORS[output.error])}</div>}
    </> : <div className="text-[12px] text-ink-secondary">{t("call.live.output.unsupported")}</div>}
    <QwenPlaybackRecovery controller={controller} />
    <div className="text-[12px] text-ink-tertiary">{t("call.live.output.localHint")}</div>
  </div>;
}
