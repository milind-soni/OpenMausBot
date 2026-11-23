import { Check, ChevronDown, ChevronUp, FileText, Globe, Monitor, Plus, Sparkles, Terminal, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";

import { appMeta, BARE_READ } from "../../../shared/skill-burger/apps";
import type { BurgerLayer } from "../../../shared/skill-burger/layers";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { burgerStartsFolded, rememberSavedRun, removeBurger, saveBurger, savedRun, type SavedWorkflow } from "@/lib/skill-burger";
import { ServiceIcon } from "../ServiceIcon";
import { EveryChatToggle } from "./EveryChatToggle";

/** One layer's icon: the app's own mark, or a plain icon for a command, a file, a page or the AI. */
export function LayerIcon({ kind, app }: { kind: BurgerLayer["kind"]; app?: string }) {
  if (kind === "app" && app) {
    const meta = appMeta(app);
    return <ServiceIcon card={{ logo: meta.logo, domain: meta.domain, label: meta.label }} className="size-4 shrink-0 rounded-[4px] text-[10px]" />;
  }
  const Icon = kind === "shell" ? Terminal : kind === "file" ? FileText : kind === "browser" ? Globe : kind === "computer" ? Monitor : Sparkles;
  return <Icon size={16} aria-hidden="true" className={cn("shrink-0", kind === "ai" ? "text-accent-text" : "text-ink-secondary")} />;
}

const capital = (words: string) => (words ? words[0]!.toUpperCase() + words.slice(1) : words);

/** The line a layer reads as, in the person's language where the words are ours. */
export function layerLine(layer: Pick<BurgerLayer, "kind" | "words" | "app"> & { where?: BurgerLayer["where"] }): string {
  const line = layer.kind === "shell" ? t("skillBurger.layer.run", { what: layer.words })
    : layer.kind === "file" ? t("skillBurger.layer.write", { name: layer.words })
    : layer.kind === "browser" ? t("skillBurger.layer.open", { site: layer.words })
    : layer.kind === "app" && layer.app && BARE_READ.test(layer.words) ? t("skillBurger.layer.readFrom", { app: appMeta(layer.app).label })
    : capital(layer.words);
  // Where it ran, when that isn't the bot's own computer or the app itself.
  return layer.where === "vm" ? t("skillBurger.layer.onVm", { step: line }) : layer.where === "yourComputer" ? t("skillBurger.layer.onYourComputer", { step: line }) : line;
}

const SHEEN_PERIOD_MS = 2000;

/** The running layer cooks: the same slow sheen as a bot's working phrase, and none with reduced motion. */
function Cooking({ text }: { text: string }) {
  const [delay] = useState(() => `-${Date.now() % SHEEN_PERIOD_MS}ms`);
  return (
    <span className="thinking-shimmer min-w-0 truncate" style={{ "--sheen-period": `${SHEEN_PERIOD_MS}ms`, "--sheen-delay": delay } as CSSProperties}>
      {text}
      <span aria-hidden="true" className="thinking-sheen"><span data-text={text} /></span>
    </span>
  );
}

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none";
const FIELD = "w-full min-w-0 rounded-md border border-hairline/60 bg-card px-1.5 py-0.5 text-ink outline-none focus:border-accent";

type Saving = { state: "idle" } | { state: "saving" } | { state: "saved"; skill: SavedWorkflow } | { state: "undone" } | { state: "error"; message: string };

export function SkillBurger({ run, layers, summary: initialSummary, canSave, botId, threadId, onDismiss }: {
  /** The run this card is for, so a save is remembered when the card comes back. */
  run: string;
  layers: BurgerLayer[];
  summary: string;
  /** False while the bot still works, or for someone who can't write in this chat. */
  canSave: boolean;
  botId: string;
  threadId: string;
  onDismiss: () => void;
}) {
  const [folded, setFolded] = useState(burgerStartsFolded);
  /** The person's own words, once they changed them; until then the summary follows the ask. */
  const [own, setOwn] = useState<{ summary: string | null; name: string }>({ summary: null, name: "" });
  const [field, setField] = useState<{ summary: string; name: string } | null>(null);
  const advanced = useAdvancedMode();
  const [saving, setSaving] = useState<Saving>(() => { const skill = savedRun(run); return skill ? { state: "saved", skill } : { state: "idle" }; });
  useEffect(() => { rememberSavedRun(run, saving.state === "saved" ? saving.skill : null); }, [run, saving]);
  const summaryField = useRef<HTMLInputElement>(null);
  const summary = own.summary ?? initialSummary;
  const name = own.name;
  const editing = field !== null;
  const live = layers.some((layer) => layer.status === "running");
  const saved = saving.state === "saved" ? saving.skill : null;

  useEffect(() => {
    if (editing) summaryField.current?.select();
  }, [editing]);

  const startEdit = () => {
    if (!saved) setField({ summary, name });
  };
  const endEdit = (keep: boolean) => {
    if (keep && field) setOwn({ summary: !field.summary.trim() ? own.summary : field.summary.trim() === initialSummary ? null : field.summary.trim(), name: field.name.replace(/^-+|-+$/g, "") });
    setField(null);
  };
  const setSummary = (value: string) => setField((current) => current && { ...current, summary: value });
  const setName = (value: string) => setField((current) => current && { ...current, name: value });
  const leaveEdit = (event: FocusEvent<HTMLInputElement>) => {
    if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) endEdit(true);
  };
  const editKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); endEdit(true); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); endEdit(false); }
  };
  const save = async () => {
    if (saving.state === "saving") return;
    const words = field ? { summary: field.summary.trim() || summary, name: field.name.replace(/^-+|-+$/g, "") } : { summary, name };
    setField(null);
    setSaving({ state: "saving" });
    try {
      const skill = await saveBurger({ botId, threadId, summary: words.summary.trim() || undefined, name: words.name || undefined });
      setSaving({ state: "saved", skill });
    } catch (cause) {
      setSaving({ state: "error", message: cause instanceof Error && cause.message ? cause.message : t("skillBurger.saveFailed") });
    }
  };
  const undo = async () => {
    if (!saved) return;
    try {
      await removeBurger(saved);
      setSaving({ state: "undone" });
    } catch (cause) {
      setSaving({ state: "error", message: cause instanceof Error && cause.message ? cause.message : t("skillBurger.undoFailed") });
    }
  };

  const toggleLabel = folded ? t("skillBurger.expand") : t("skillBurger.collapse");
  const count = layers.length === 1 ? t("skillBurger.layersOne") : t("skillBurger.layersMany", { count: layers.length });
  return (
    <section
      aria-label={t("skillBurger.aria")}
      data-skill-burger={saved ? "saved" : live ? "live" : "done"}
      className={cn("skill-burger pointer-events-auto flex w-[21rem] max-w-full flex-col gap-[3px] text-ink", saved && "burger-stacked")}
    >
      <div className="burger-bun burger-bun-top relative flex items-start gap-1.5 rounded-t-[18px] rounded-b-[8px] bg-raised px-3 pb-2 pt-3.5 shadow-sm">
        <span aria-hidden="true" className="burger-sesame" />
        <div className="flex min-w-0 flex-1 flex-col">
          {field ? (
            <>
              <input
                ref={summaryField}
                dir="auto"
                value={field.summary}
                maxLength={160}
                aria-label={t("skillBurger.editSummary")}
                onChange={(event) => setSummary(event.target.value)}
                onKeyDown={editKeys}
                onBlur={leaveEdit}
                className={cn(FIELD, "text-[13px] font-medium")}
              />
              {advanced && <input
                dir="ltr"
                value={field.name}
                maxLength={64}
                placeholder={t("skillBurger.namePlaceholder")}
                aria-label={t("skillBurger.editName")}
                onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                onKeyDown={editKeys}
                onBlur={leaveEdit}
                className={cn(FIELD, "mt-1 font-mono text-[11px] text-ink-secondary")}
              />}
            </>
          ) : (
            <button
              type="button"
              dir="auto"
              onClick={startEdit}
              disabled={Boolean(saved)}
              title={saved ? undefined : t("skillBurger.editSummary")}
              className="min-w-0 truncate rounded-md text-start text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent/60 enabled:hover:text-ink-secondary"
            >
              {summary}
            </button>
          )}
          <span role="status" aria-live="polite" aria-atomic="true" className="truncate text-[12px] text-ink-secondary">{count}</span>
          {saved && <EveryChatToggle compact skill={saved} onMoved={(skill) => setSaving({ state: "saved", skill })} className="mt-1" />}
        </div>
        <button type="button" onClick={() => setFolded((value) => !value)} aria-expanded={!folded} aria-label={toggleLabel} title={toggleLabel} className={ICON_BUTTON}>
          {folded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
        </button>
        <button type="button" onClick={onDismiss} aria-label={t("skillBurger.dismiss")} title={t("skillBurger.dismiss")} className={ICON_BUTTON}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="burger-fold" data-folded={folded ? "true" : "false"} inert={folded} aria-hidden={folded || undefined}>
      <ol aria-label={t("skillBurger.layers")} className="burger-layers flex max-h-60 min-h-0 flex-col gap-[3px] overflow-y-auto">
        {layers.map((layer) => {
          const line = layerLine(layer);
          return (
            <li
              key={layer.id}
              data-burger-layer={layer.kind}
              data-status={layer.status}
              className={cn(
                "burger-layer flex min-h-9 min-w-0 items-center gap-2.5 rounded-[8px] bg-card px-3 text-[13px] shadow-sm",
                layer.status === "failed" && "text-danger",
              )}
            >
              <LayerIcon kind={layer.kind} app={layer.app} />
              {layer.status === "running" ? <Cooking text={line} /> : (
                <span className={cn("min-w-0 flex-1 truncate", layer.kind === "ai" && "text-ink-secondary")} title={line}>{line}</span>
              )}
              {layer.kind === "ai" && <span className="ms-auto shrink-0 text-[11px] text-ink-tertiary">{t("skillBurger.aiTag")}</span>}
              {layer.status === "failed" && <XCircle size={14} aria-label={t("skillBurger.failed")} className="ms-auto shrink-0" />}
            </li>
          );
        })}
      </ol>
      </div>

      <div className="burger-bun burger-bun-bottom flex min-h-10 items-center rounded-b-[18px] rounded-t-[8px] bg-raised shadow-sm">
        {saved ? (
          <div className="flex w-full items-center gap-2 px-3 text-[13px]">
            <Check size={14} aria-hidden="true" className="shrink-0 text-success" />
            <span className="min-w-0 flex-1 truncate">{t("skillBurger.saved")}</span>
            <button type="button" onClick={() => void undo()} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-text outline-none hover:bg-ink/[0.06] focus-visible:ring-2 focus-visible:ring-accent/60">
              {t("common.undo")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave || live || saving.state === "saving"}
            title={live ? t("skillBurger.waitForRun") : undefined}
            className="flex h-10 w-full items-center justify-center gap-1.5 rounded-b-[18px] rounded-t-[8px] text-[13px] font-medium text-accent-text outline-none transition-colors hover:bg-ink/[0.05] focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:text-ink-tertiary disabled:hover:bg-transparent motion-reduce:transition-none"
          >
            {saving.state === "saving" ? t("skillBurger.saving") : <><Plus size={14} aria-hidden="true" />{t("skillBurger.add")}</>}
          </button>
        )}
      </div>
      {(saving.state === "error" || saving.state === "undone") && (
        <p role={saving.state === "error" ? "alert" : "status"} className={cn("px-3 text-[12px]", saving.state === "error" ? "text-danger" : "text-ink-secondary")}>
          {saving.state === "error" ? saving.message : t("skillBurger.undone")}
        </p>
      )}
    </section>
  );
}
