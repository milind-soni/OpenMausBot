import { useRef, useState, type ChangeEvent } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import {
  PROVIDER_ICON_LABELS,
  PROVIDER_ICON_MAX_DIMENSION,
  PROVIDER_ICON_MAX_BYTES,
  PROVIDER_ICON_MEDIA_TYPES,
  PROVIDER_ICON_PRESETS,
  providerIconError,
  type ProviderIcon,
} from "../../shared/provider-icon";
import { InstanceProviderMark } from "./ProviderIcons";

type ImageDimensions = { width: number; height: number };

function decodeBrowserImage(dataUrl: string): Promise<ImageDimensions> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error(t("engines.icon.decodeError")));
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = dataUrl;
  });
}

export async function providerIconFromFile(
  file: Pick<File, "type" | "size" | "arrayBuffer">,
  decodeImage: (dataUrl: string) => Promise<ImageDimensions> = decodeBrowserImage,
): Promise<ProviderIcon> {
  if (!(PROVIDER_ICON_MEDIA_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(t("engines.icon.formatError"));
  }
  if (file.size > PROVIDER_ICON_MAX_BYTES) throw new Error(t("engines.icon.sizeError"));
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const icon = { kind: "custom", dataUrl: `data:${file.type};base64,${btoa(binary)}` } as const;
  const invalid = providerIconError(icon);
  if (invalid) throw new Error(t("engines.icon.invalidError", { dimension: PROVIDER_ICON_MAX_DIMENSION }));
  const dimensions = await decodeImage(icon.dataUrl);
  if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > PROVIDER_ICON_MAX_DIMENSION || dimensions.height > PROVIDER_ICON_MAX_DIMENSION) {
    throw new Error(t("engines.icon.dimensionError", { dimension: PROVIDER_ICON_MAX_DIMENSION }));
  }
  return icon;
}

export function ProviderIconPicker({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  const save = async (choice: ProviderIcon | null | (() => Promise<ProviderIcon>)) => {
    // Lock synchronously, including file reading and decoding. React state alone
    // cannot guard callbacks captured before the next render.
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const icon = typeof choice === "function" ? await choice() : choice;
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/icon`, {
        method: "PATCH",
        body: JSON.stringify({ icon }),
      });
      await refreshInstances();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    void save(() => providerIconFromFile(file))
      .finally(() => { input.value = ""; });
  };

  const value = instance.icon?.kind === "preset" ? instance.icon.preset
    : instance.icon?.kind === "custom" ? "custom" : "default";
  return <section aria-label={t("engines.icon.label")} className="mb-3 rounded-xl border border-hairline/40 p-3">
    <div className="flex flex-wrap items-center gap-3">
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-hairline/30 bg-panel">
        <InstanceProviderMark instance={instance} size={24} />
      </span>
      <label className="min-w-40 flex-1 text-[12px] font-medium text-ink">
        {t("engines.icon.label")}
        <select aria-label={t("engines.icon.selectAria", { name: instance.displayName })} value={value} disabled={saving}
          onChange={(event) => {
            if (event.target.value === "default") void save(null);
            else if (event.target.value !== "custom") void save({ kind: "preset", preset: event.target.value as typeof PROVIDER_ICON_PRESETS[number] });
          }}
          className="mt-1 block w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[12px] text-ink focus:border-accent/60 focus:outline-none disabled:opacity-50">
          <option value="default">{t("engines.icon.default")}</option>
          {instance.icon?.kind === "custom" && <option value="custom">{t("engines.icon.custom")}</option>}
          {PROVIDER_ICON_PRESETS.map((preset) => <option key={preset} value={preset}>{PROVIDER_ICON_LABELS[preset]}</option>)}
        </select>
      </label>
      {saving && <Loader2 size={15} aria-label={t("engines.icon.saving")} className="animate-spin text-ink-secondary" />}
      {instance.icon && <button type="button" disabled={saving} onClick={() => void save(null)}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
        <RotateCcw size={13} aria-hidden="true" />{t("engines.icon.reset")}
      </button>}
    </div>
    <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">{t("engines.icon.help")}</p>
    <input type="file" accept={PROVIDER_ICON_MEDIA_TYPES.join(",")} disabled={saving} onChange={upload}
      aria-label={t("engines.icon.uploadAria", { name: instance.displayName })}
      className="mt-2 block w-full text-[11px] text-ink-secondary file:mr-2 file:rounded-lg file:border-0 file:bg-control file:px-2.5 file:py-1.5 file:text-[11px] file:font-medium file:text-ink hover:file:bg-raised-hover disabled:opacity-50" />
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </section>;
}
