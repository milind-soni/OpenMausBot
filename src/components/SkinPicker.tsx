// Works because styles.css keys skins on [data-skin], not :root[data-skin], so any element opens a skin context for its
// subtree.
import { Check } from "lucide-react";
import { SKINS, applySkin, resolveSkin, type SkinId } from "@/lib/skins";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { setDressUp, useDressUp } from "@/lib/halloween-dress";
import type { HalloweenBodyId } from "../../shared/halloween-bodies";
import { MausAvatar } from "./Avatar";
import { Switch } from "./SettingsPrimitives";
import { useSkinChoice } from "./ThemeRow";

function Miniature({ skin }: { skin: SkinId }) {
  return (
    <div
      data-skin={skin}
      data-skin-preview=""
      aria-hidden="true"
      className="flex h-[78px] w-full overflow-hidden rounded-lg bg-app ring-1 ring-hairline/60"
    >
      <div className="flex w-[11px] shrink-0 flex-col items-center gap-[3px] bg-panel pt-[5px]">
        <span className="size-[5px] rounded-full bg-accent" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
      </div>
      <div className="flex w-[30px] shrink-0 flex-col gap-[3px] border-r border-hairline bg-panel p-[4px]">
        <span className="flex h-[9px] w-full items-center gap-[2px] rounded-sm bg-raised px-[2px]">
          <span className="size-[4px] shrink-0 rounded-full bg-accent" />
          <span className="h-[2px] flex-1 rounded-full bg-ink/50" />
        </span>
        <span className="h-[3px] w-[80%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[62%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[74%] rounded-full bg-ink-secondary/30" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-[4px] p-[6px]">
        <span className="h-[13px] w-[62%] self-end rounded-md bg-bubble-user" />
        <div className="flex w-[88%] flex-col gap-[3px] rounded-md bg-card p-[4px]">
          <span className="h-[2px] w-full rounded-full bg-ink/45" />
          <span className="h-[2px] w-[85%] rounded-full bg-ink/45" />
          <span className="h-[2px] w-[60%] rounded-full bg-ink-secondary/40" />
        </div>
        <div className="mt-auto flex items-center gap-[4px]">
          <span className="h-[11px] flex-1 rounded-full bg-inset ring-1 ring-hairline" />
          <span className="flex size-[11px] items-center justify-center rounded-full bg-accent">
            <span
              className="h-[1.5px] w-[5px] rounded-full"
              style={{ background: "var(--color-accent-ink)" }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

const DRESS_UP_PREVIEW: ReadonlyArray<[HalloweenBodyId, "orange" | "purple" | "teal" | "red"]> = [
  ["pumpkin", "orange"],
  ["ghost", "purple"],
  ["witch", "teal"],
  ["bat", "red"],
];

export function DressUpRow() {
  const dressed = useDressUp();
  const title = t("settings.skin.dressUp.title");
  return (
    <div data-dress-up className="mt-4 flex items-center gap-4 rounded-xl border border-accent-border/40 bg-accent/[0.06] p-3">
      <div className="flex shrink-0 -space-x-1.5" aria-hidden="true">
        {DRESS_UP_PREVIEW.map(([body, color]) => (
          <MausAvatar key={body} color={color} bodyId={body} size={30} animated={false} trackPointer={false} />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">{title}</div>
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("settings.skin.dressUp.subtitle")}</div>
      </div>
      <Switch checked={dressed} aria-label={title} onClick={() => setDressUp(!dressed)} />
    </div>
  );
}

export function SkinPicker() {
  const active = resolveSkin(useSkinChoice());

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SKINS.map((skin) => {
          const selected = skin.id === active;
          return (
            <button
              key={skin.id}
              type="button"
              onClick={() => {
                applySkin(skin.id);
              }}
              aria-pressed={selected}
              className={cn(
                "cursor-pointer flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
                selected
                  ? "border-accent-border bg-control"
                  : "border-hairline/60 hover:border-hairline hover:bg-control/50",
              )}
            >
              <Miniature skin={skin.id} />
              <div className="flex items-start gap-1.5 px-0.5 pb-0.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink">{skin.name}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                    {skin.tagline}
                  </div>
                </div>
                {selected && <Check size={13} className="mt-0.5 shrink-0 text-accent-text" />}
              </div>
            </button>
          );
        })}
      </div>
      {active === "halloween" && <DressUpRow />}
    </>
  );
}
