import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, FileText, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { skillImportLines } from "@/lib/skill-import";
import { addSkill, FLAG_KEY, fromLabel, readSkill, skillTitle, WRITE_PROBLEM_KEY, type SkillWire } from "@/lib/skills";
import { useStore } from "@/state/store";
import type { SkillDetailWire } from "../../../shared/skill-catalog";
import { writtenSkillProblem } from "../../../shared/written-skill";
import { BotAvatar } from "../Avatar";
import { Segmented } from "../bot-panel/rows";
import { useDialog } from "./use-dialog";

function Dialog({ label, onClose, width = 480, children }: { label: string; onClose: () => void; width?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialog(ref, onClose);
  return createPortal(
    <div className="ui-scrim-light fixed inset-0 z-[90] flex items-center justify-center p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={{ width }} onKeyDown={onKeyDown}
        className="ui-modal animate-pop-in flex max-h-[min(720px,calc(100dvh-32px))] max-w-full flex-col overflow-hidden text-ink shadow-2xl outline-none">
        {children}
      </div>
    </div>,
    document.body,
  );
}

function DialogHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header className="flex items-start justify-between gap-3 px-5 pb-1 pt-4">
      <h2 className="min-w-0 text-[17px] font-semibold leading-6">{title}</h2>
      <button type="button" onClick={onClose} aria-label={t("common.close")} className="-me-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
        <X size={16} />
      </button>
    </header>
  );
}

/** Opening a skill: what it does, where it came from, who may use it, its files, and Remove. */
export function SkillDetailDialog({ skill, who, busy, onRemove, onClose }: {
  skill: SkillWire;
  who: ReactNode;
  busy: boolean;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { state } = useStore();
  const [detail, setDetail] = useState<SkillDetailWire | null>(null);
  const [showing, setShowing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const botName = (id: string) => state.bots.find((bot) => bot.id === id)?.name;
  useEffect(() => {
    let live = true;
    readSkill(skill.id).then((read) => { if (live) setDetail(read); }, () => {});
    return () => { live = false; };
  }, [skill.id]);
  const where = skill.from.kind === "github" || skill.from.kind === "link" ? skill.from.where : null;

  return (
    <Dialog label={skillTitle(skill)} onClose={onClose} width={520}>
      <DialogHeader title={skillTitle(skill)} onClose={onClose} />
      <div data-skill-detail={skill.id} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <p className="text-[14px] leading-5 text-ink-secondary">{skill.description}</p>
        <p className="mt-1 truncate text-[12px] leading-4 text-ink-tertiary" title={where ?? undefined}>
          {fromLabel(skill.from, botName)}{where && skill.from.kind === "github" ? ` · ${where}` : ""}
        </p>
        {skill.flag && <p className="mt-3 rounded-[10px] bg-warning/10 px-3 py-2 text-[13px] leading-[18px] text-warning">{t(FLAG_KEY[skill.flag])}</p>}
        {skill.from.kind !== "project" && (
          <div className="mt-4 flex items-center justify-between gap-3 border-y border-ink/[0.06] py-2.5">
            <span className="text-[14px] font-medium">{t("skills.who.label")}</span>
            {who}
          </div>
        )}
        <p className="mt-3 text-[13px] leading-[18px] text-ink-secondary">{t("skills.runIt", { name: skill.name })}</p>
        {detail && detail.instructions && (
          <div className="mt-4">
            <button type="button" aria-expanded={showing} onClick={() => setShowing((value) => !value)}
              className="flex items-center gap-1 text-[13px] font-medium text-ink-secondary hover:text-ink">
              {t("skills.instructions")}<ChevronDown size={14} aria-hidden="true" className={cn("transition-transform", showing && "rotate-180")} />
            </button>
            {showing && (
              <pre tabIndex={0} className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-ink/[0.04] p-3 font-sans text-[13px] leading-5 text-ink">
                {detail.instructions}
              </pre>
            )}
          </div>
        )}
        {detail && detail.files.length > 0 && (
          <div className="mt-4">
            <h3 className="text-[13px] font-medium text-ink-secondary">{t("skills.files")}</h3>
            <ul className="mt-1.5 flex flex-col gap-1">
              {detail.files.map((file) => (
                <li key={file} className="flex min-w-0 items-center gap-2 text-[13px] text-ink">
                  <FileText size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" /><span className="truncate">{file}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {skill.removable && (
        <footer className="flex items-center justify-end gap-2 border-t border-ink/[0.06] px-5 py-3">
          {confirming ? <>
            <span className="me-auto text-[13px] text-ink-secondary">{t("skills.removeConfirm")}</span>
            <button type="button" onClick={() => setConfirming(false)} className="ui-button ui-button-md rounded-full">{t("common.cancel")}</button>
            <button type="button" disabled={busy} onClick={onRemove} className="ui-button ui-button-md rounded-full border-transparent bg-danger text-white disabled:opacity-50">{t("skills.remove")}</button>
          </> : (
            <button type="button" data-skill-remove onClick={() => setConfirming(true)} className="rounded-md px-2 py-1 text-[13px] font-medium text-danger hover:bg-danger/10">{t("skills.remove")}</button>
          )}
        </footer>
      )}
    </Dialog>
  );
}

/** Choose bots…: a tick for each bot. */
export function ChooseBotsDialog({ skill, busy, onDone, onClose }: {
  skill: SkillWire;
  busy: boolean;
  onDone: (bots: string[]) => void;
  onClose: () => void;
}) {
  const { state } = useStore();
  const bots = state.bots.filter((bot) => !bot.hidden && (!skill.only || skill.only.includes(bot.id)));
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(skill.who === "all" ? bots.map((bot) => bot.id) : skill.bots));
  const flip = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const title = t("skills.choose.title", { name: skillTitle(skill) });
  return (
    <Dialog label={title} onClose={onClose} width={400}>
      <DialogHeader title={title} onClose={onClose} />
      <ul data-skill-choose className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {bots.map((bot) => {
          const on = chosen.has(bot.id);
          return (
            <li key={bot.id}>
              <button type="button" role="checkbox" aria-checked={on} onClick={() => flip(bot.id)}
                className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-start hover:bg-ink/[0.04]">
                <BotAvatar bot={bot} size={24} animated={false} />
                <span className="min-w-0 flex-1 truncate text-[14px]">{bot.name}</span>
                <span aria-hidden="true" className={cn("flex size-5 items-center justify-center rounded-md border", on ? "border-transparent bg-ink text-app" : "border-ink/20")}>
                  {on && <Check size={13} strokeWidth={2.5} />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <footer className="flex justify-end gap-2 px-5 pb-4 pt-2">
        <button type="button" onClick={onClose} className="ui-button rounded-full px-4">{t("common.cancel")}</button>
        <button type="button" disabled={busy} onClick={() => onDone([...chosen])} className="ui-button ui-button-primary rounded-full px-4">{t("common.done")}</button>
      </footer>
    </Dialog>
  );
}

const inputCls = "w-full rounded-[10px] border border-ink/[0.1] bg-transparent px-3 py-2 text-[14px] text-ink placeholder:text-ink-tertiary focus:border-focus focus:outline-none";

/** Add skill: a link to one on GitHub, or one written here. Either goes to every bot. One from GitHub then says what
 * came in with it and what was left out. */
export function AddSkillDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [way, setWay] = useState<"link" | "write">("link");
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [arrived, setArrived] = useState<string[]>([]);
  const written = { name: name.trim(), description, instructions };
  const problem = writtenSkillProblem(written);
  const touched = Boolean(name.trim() || description.trim() || instructions.trim());
  const ready = way === "link" ? Boolean(link.trim()) : !problem;

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError("");
    try {
      const added = await addSkill(way === "link" ? { link: link.trim() } : written);
      onAdded();
      const lines = skillImportLines(added.imported ?? []);
      if (lines.length) setArrived(lines);
      else onClose();
    } catch (cause) {
      const code = (cause as { body?: { code?: string } })?.body?.code;
      setError(code && code in WRITE_PROBLEM_KEY ? t(WRITE_PROBLEM_KEY[code as keyof typeof WRITE_PROBLEM_KEY]) : t(way === "link" ? "skills.linkFailed" : "skills.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog label={t("skills.addTitle")} onClose={onClose}>
      <DialogHeader title={t("skills.addTitle")} onClose={onClose} />
      {arrived.length > 0 ? (
        <div data-skill-arrived className="flex flex-col gap-2 px-5 pb-5 pt-2">
          {arrived.map((line) => <p key={line} className="text-[14px] leading-5 text-ink">{line}</p>)}
          <button type="button" onClick={onClose} className="ui-button ui-button-primary mt-2 self-end rounded-full px-4">{t("common.done")}</button>
        </div>
      ) : <form data-skill-add-form className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5 pt-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Segmented attr="data-skill-add-way" label={t("skills.addTitle")} value={way} onChange={(next) => { setWay(next); setError(""); }}
          options={[{ value: "link", label: t("skills.fromLink") }, { value: "write", label: t("skills.writeOne") }]} />
        {way === "link" ? (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-secondary">
            {t("skills.linkLabel")}
            <input data-skill-link value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://github.com/…" className={inputCls} />
            <span className="text-[12px] leading-4 text-ink-tertiary">{t("skills.linkHint")}</span>
          </label>
        ) : <>
          <div className="flex gap-2">
            <div className="relative w-40 shrink-0">
              <span aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-[14px] text-ink-tertiary">/</span>
              <input data-skill-name value={name} maxLength={64} aria-label={t("skills.write.name")} placeholder={t("skills.write.namePlaceholder")}
                onChange={(event) => setName(event.target.value.toLowerCase().replace(/\s+/g, "-"))} className={cn(inputCls, "ps-6")} />
            </div>
            <input data-skill-description value={description} maxLength={1024} aria-label={t("skills.write.description")} placeholder={t("skills.write.descriptionPlaceholder")}
              onChange={(event) => setDescription(event.target.value)} className={inputCls} />
          </div>
          <textarea data-skill-instructions value={instructions} aria-label={t("skills.write.instructions")} placeholder={t("skills.write.instructionsPlaceholder")}
            onChange={(event) => setInstructions(event.target.value)} className={cn(inputCls, "min-h-32 resize-y leading-5")} />
          {touched && problem && <p className="text-[12px] text-ink-secondary">{t(WRITE_PROBLEM_KEY[problem])}</p>}
        </>}
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        <div className="mt-1 flex items-center justify-between gap-3">
          <p className="min-w-0 text-[12px] leading-4 text-ink-tertiary">{t("skills.askBot")}</p>
          <button type="submit" disabled={!ready || saving} className="ui-button ui-button-primary shrink-0 rounded-full px-4">
            {saving ? t("skills.adding") : t("skills.add")}
          </button>
        </div>
      </form>}
    </Dialog>
  );
}
