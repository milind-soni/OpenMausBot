// Choosing a skin is a visual decision, so the options are shown visually: each
// card carries a working miniature of the app rendered in that skin, not a row
// of paint chips. That works because the skin blocks in styles.css are keyed on
// `[data-skin]` rather than `:root[data-skin]` — any element can open a skin
// context for its own subtree, so the miniature styles itself and can never
// drift from what picking it actually does.
import { useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { COLOR_ROLES, SKINS, applySkin, colorsFromSkin, readCustomTheme, readSkin, saveCustomTheme, type CustomTheme, type SkinId } from "@/lib/skins";
import { cn } from "@/lib/cn";

/**
 * The app's own layout at roughly 1/14 scale: rail, sidebar with a selected
 * row, thread, composer. The selected row and the send button are drawn in the
 * accent on purpose — a skin is mostly judged by where its colour lands, and a
 * single dot was too small to judge.
 */
function Miniature({ skin, custom }: { skin: SkinId; custom?: CustomTheme }) {
  return (
    <div
      data-skin={skin}
      style={skin === "custom" && custom ? {
        ...Object.fromEntries(COLOR_ROLES.map((role) => [`--color-${role}`, custom[role]])),
        "--font-sans": custom.fontSans,
        "--radius-lg": custom.radiusLg,
        "--radius-xl": custom.radiusXl,
      } as CSSProperties : undefined}
      aria-hidden="true"
      className="flex h-[78px] w-full overflow-hidden rounded-lg bg-app ring-1 ring-hairline/60"
    >
      {/* rail */}
      <div className="flex w-[11px] shrink-0 flex-col items-center gap-[3px] bg-panel pt-[5px]">
        <span className="size-[5px] rounded-full bg-accent" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
      </div>
      {/* sidebar — the top row is the selected conversation */}
      <div className="flex w-[30px] shrink-0 flex-col gap-[3px] border-r border-hairline bg-panel p-[4px]">
        <span className="flex h-[9px] w-full items-center gap-[2px] rounded-sm bg-raised px-[2px]">
          <span className="size-[4px] shrink-0 rounded-full bg-accent" />
          <span className="h-[2px] flex-1 rounded-full bg-ink/50" />
        </span>
        <span className="h-[3px] w-[80%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[62%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[74%] rounded-full bg-ink-secondary/30" />
      </div>
      {/* thread */}
      <div className="flex min-w-0 flex-1 flex-col gap-[4px] p-[6px]">
        <span className="h-[13px] w-[62%] self-end rounded-md bg-bubble-user" />
        <div className="flex w-[88%] flex-col gap-[3px] rounded-md bg-card p-[4px]">
          <span className="h-[2px] w-full rounded-full bg-ink/45" />
          <span className="h-[2px] w-[85%] rounded-full bg-ink/45" />
          <span className="h-[2px] w-[60%] rounded-full bg-ink-secondary/40" />
        </div>
        <div className="mt-auto flex items-center gap-[4px]">
          <span className="h-[11px] flex-1 rounded-full bg-inset ring-1 ring-hairline" />
          {/* filled accent with its own ink — Foundry's inversion reads right
              here: bright brass carrying a dark mark, where the others carry
              a light one */}
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

export function SkinPicker() {
  // The document is the source of truth, not storage: main.tsx has already
  // stamped it, and reading it back keeps the checkmark honest even if the
  // skin was set some other way.
  // SAFETY: main.tsx writes this attribute from applySkin() before the first
  // paint, and readSkin() covers the case where it is absent or unreadable.
  const [active, setActive] = useState<SkinId>(
    () => (document.documentElement.dataset.skin as SkinId) || readSkin(),
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CustomTheme>(() => readCustomTheme() ?? colorsFromSkin("chatgpt"));
  const [base, setBase] = useState<Exclude<SkinId, "custom">>("chatgpt");

  function chooseSkin(id: SkinId) {
    if (id === "custom" && !readCustomTheme()) saveCustomTheme(draft);
    else applySkin(id);
    setActive(id);
  }

  return (
    // Four columns keep each miniature useful while allowing the collection
    // to grow into a second row; Settings already scrolls on short windows.
    <div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {SKINS.map((skin) => {
        const selected = skin.id === active;
        return (
          <button
            key={skin.id}
            type="button"
            onClick={() => {
              chooseSkin(skin.id);
            }}
            aria-pressed={selected}
            className={cn(
              "flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
              selected
                ? "border-accent-border bg-control"
                : "border-hairline/60 hover:border-hairline hover:bg-control/50",
            )}
          >
            <Miniature skin={skin.id} custom={draft} />
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
    <button type="button" className="mt-4 rounded-lg border border-hairline px-3 py-2 text-sm text-ink hover:bg-raised" onClick={() => setEditing(!editing)}>
      {editing ? "Close custom theme editor" : "Edit custom theme"}
    </button>
    {editing && <div className="mt-3 rounded-xl border border-hairline bg-card p-4 text-ink">
      <p className="mb-3 text-sm text-ink-secondary">Choose every color. Start from any preset, then save your own version.</p>
      <label className="mb-3 block text-sm">Start from{" "}
        <select className="rounded-md border border-hairline bg-inset px-2 py-1 text-ink" value={base}
          onChange={(event) => {
            const id = event.target.value as Exclude<SkinId, "custom">;
            setBase(id);
            setDraft(colorsFromSkin(id));
          }}>
          {SKINS.filter((skin) => skin.id !== "custom").map((skin) => <option key={skin.id} value={skin.id}>{skin.name}</option>)}
        </select>
      </label>
      <label className="mb-3 block text-sm">Chat layout{" "}
        <select className="rounded-md border border-hairline bg-inset px-2 py-1 text-ink"
          value={draft.layout ?? "standard"}
          onChange={(event) => setDraft({ ...draft, layout: event.target.value as "standard" | "chatgpt" })}>
          <option value="standard">Standard bubbles</option>
          <option value="chatgpt">ChatGPT-style assistant text</option>
        </select>
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {COLOR_ROLES.map((role) => <label key={role} className="flex items-center gap-2 text-xs">
          <input type="color" aria-label={`${role} color`} value={draft[role].startsWith("#") ? draft[role].slice(0, 7) : "#000000"}
            onChange={(event) => setDraft({ ...draft, [role]: event.target.value })} />
          <span className="min-w-0 flex-1">{role.replaceAll("-", " ")}</span>
          <input className="w-[88px] rounded border border-hairline bg-inset px-1.5 py-1 font-mono text-xs text-ink"
            aria-label={`${role} hex`} value={draft[role]}
            onChange={(event) => setDraft({ ...draft, [role]: event.target.value })} />
        </label>)}
      </div>
      <button type="button" className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-50"
        disabled={!COLOR_ROLES.every((role) => draft[role] === "transparent" || /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(draft[role]))}
        onClick={() => { saveCustomTheme(draft); setActive("custom"); }}>
        Save and use custom theme
      </button>
    </div>}
    </div>
  );
}
