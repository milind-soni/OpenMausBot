// Write a command: a name, a one-line description, and the instructions the
// bot follows when someone types `/name` in a chat. Saved as an ordinary
// skill through the bot-creation template route, so it is listed, switched
// off, and removed with the bot's other skills above.
import { SquareSlash } from "lucide-react";
import { useState } from "react";

import type { Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import {
  WRITTEN_SKILL_SOURCE, writtenSkillMd, writtenSkillProblem, type WrittenSkillProblem,
} from "../../../shared/written-skill";
import { useBotEditor } from "./BotEditorContext";
import { inputCls } from "./field";

const PROBLEM_KEY = {
  name: "skills.write.problem.name",
  reserved: "skills.write.problem.reserved",
  taken: "skills.write.problem.taken",
  description: "skills.write.problem.description",
  instructions: "skills.write.problem.instructions",
} as const satisfies Record<WrittenSkillProblem, string>;

export function WriteCommandCard({ bot, taken, onSaved }: { bot: Bot; taken: readonly string[]; onSaved: () => void }) {
  const { request: api } = useBotEditor();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const draft = { name: name.trim(), description, instructions };
  const problem = writtenSkillProblem(draft, taken);
  const touched = Boolean(name.trim() || description.trim() || instructions.trim());

  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await api(`/api/bots/${bot.id}/skill-template`, {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          description: "",
          warnings: [],
          source: WRITTEN_SKILL_SOURCE,
          text: writtenSkillMd(draft),
          enabled: true,
        }),
      });
      setMessage(t("skills.write.saved", { name: draft.name }));
      setName("");
      setDescription("");
      setInstructions("");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("skills.write.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2">
        <SquareSlash size={16} className="text-ink-secondary" />
        <div className="text-[15px] font-medium text-ink">{t("skills.write.title")}</div>
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("skills.write.hint")}</div>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center gap-2">
          <div className="relative w-44 shrink-0">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[15px] text-ink-secondary">/</span>
            <input
              className={inputCls + " pl-6 font-mono"}
              placeholder={t("skills.write.namePlaceholder")}
              aria-label={t("skills.write.name")}
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            />
          </div>
          <input
            className={inputCls}
            placeholder={t("skills.write.descriptionPlaceholder")}
            aria-label={t("skills.write.description")}
            value={description}
            maxLength={1024}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <textarea
          className={inputCls + " min-h-24 resize-y leading-relaxed"}
          placeholder={t("skills.write.instructionsPlaceholder")}
          aria-label={t("skills.write.instructions")}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-[11.5px] text-ink-secondary">
            {touched && problem ? t(PROBLEM_KEY[problem]) : message}
          </div>
          <button
            type="submit"
            disabled={saving || Boolean(problem)}
            className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {saving ? t("skills.write.saving") : t("skills.write.save")}
          </button>
        </div>
        {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      </form>
    </div>
  );
}
