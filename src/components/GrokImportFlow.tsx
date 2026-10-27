// The one Grok Bot import, used by Templates → Import, Settings → Import and the welcome tour's import step:
// link → card → Sign in with Cursor or the export prompt → reply → preview → Add → the Chief of Staff finishes.
import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

import { t } from "@/lib/i18n";
import type { PendingTeamImport } from "@/lib/team-import";
import { addTemplate } from "@/lib/template-add";
import { useStore, type Bot } from "@/state/store";
import { takeImportName } from "../../shared/import-name";
import { GrokFinishSetup, grokSetupLeft } from "./GrokFinishSetup";
import { GrokImportBox } from "./GrokImportBox";
import { TeamImportDetails } from "./TeamImportDetails";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function GrokImportFlow({ link = null, onPreview, onAdded, bare }: {
  link?: string | null;
  /** Templates shows the preview, Add and the finishing step in its own frame; without this the flow does all three here. */
  onPreview?: (preview: PendingTeamImport) => void;
  /** After Add, once the person is done with the finishing step. */
  onAdded?: (bot: Bot) => void;
  bare?: boolean;
}) {
  const { state, dispatch } = useStore();
  const [pending, setPending] = useState<PendingTeamImport | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Bot | null>(null);
  const [error, setError] = useState("");

  if (onPreview) return <GrokImportBox link={link} onPreview={onPreview} bare={bare} />;

  const finish = (bot: Bot) => {
    setAdded(null);
    setPending(null);
    onAdded?.(bot);
  };

  if (added && pending) {
    return grokSetupLeft(pending.grokSetup)
      ? <GrokFinishSetup notes={pending.grokSetup} imported={added} onDone={() => finish(added)} className="mt-1" />
      : (
        <div role="status" className="flex items-center gap-2 text-[14px] text-ink">
          <Check size={15} className="text-success" />
          {t("grokFinish.added", { name: added.name })}
        </div>
      );
  }

  if (pending) {
    const taken = new Set(state.bots.map((bot) => bot.name.trim().toLowerCase()));
    const add = async () => {
      setAdding(true);
      setError("");
      try {
        const response = await addTemplate(pending.manifest, dispatch);
        if (!response.first) return setPending(null);
        setAdded(response.first);
        if (!grokSetupLeft(pending.grokSetup)) onAdded?.(response.first);
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setAdding(false);
      }
    };
    return (
      <div aria-label={pending.name}>
        <div className="text-[15px] font-medium text-ink">{pending.name}</div>
        <div className="mt-3">
          <TeamImportDetails pending={pending} importedNames={pending.members.map((member) => takeImportName(member.name, taken))} />
        </div>
        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={() => setPending(null)}
            disabled={adding}
            className="rounded-full bg-raised px-4 py-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {t("templates.back")}
          </button>
          <button
            onClick={() => void add()}
            disabled={adding}
            className="flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {adding && <Loader2 size={15} className="animate-spin" />}
            {adding ? t("templates.importing") : t("templates.addTeam")}
          </button>
        </div>
      </div>
    );
  }

  return <GrokImportBox link={link} onPreview={(preview) => { setPending(preview); setError(""); }} bare={bare} />;
}
