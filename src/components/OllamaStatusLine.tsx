import { Check } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { localModelDetail } from "@/lib/local-model";
import type { InstanceInfo } from "@/state/store";
import type { OllamaProblem, OllamaStatus } from "../../shared/local-model";

export const OLLAMA_PULL = "ollama pull llama3.2";
const OLLAMA_SERVE = "ollama serve";

type Found = OllamaProblem & { models?: OllamaStatus["models"] };

/** What one look found, in a line, and the command that fixes it. */
export function ollamaStatusText(status: Found): { text: string; command?: string; ok: boolean } {
  switch (status.state) {
    case "ready": return { ok: true, text: t("ollama.ready", { url: status.url, count: status.models?.length ?? 0 }) };
    case "no-models": return { ok: false, text: t("ollama.noModels", { url: status.url }), command: OLLAMA_PULL };
    case "not-running": return { ok: false, text: t("ollama.notRunning", { url: status.url }), command: OLLAMA_SERVE };
    case "unreachable": return {
      ok: false,
      text: t(status.problem === "not-ollama" ? "ollama.notOllama" : status.problem === "timeout" ? "ollama.timeout" : "ollama.unreachable", { url: status.url }),
    };
  }
}

/** The engine list's few words for what stops an Ollama. */
export function ollamaShortStatus(problem: OllamaProblem): string {
  return t(problem.state === "not-running" ? "ollama.short.notRunning" : problem.state === "no-models" ? "ollama.short.noModels" : "ollama.short.unreachable");
}

/** The pulled models of a recognised Ollama, for its row in the engine list. */
export function OllamaModels({ instance, className }: { instance: Pick<InstanceInfo, "models">; className?: string }) {
  const models = instance.models.options.filter((option) => option.local);
  if (models.length === 0) return null;
  return (
    <ul data-ollama-models className={cn("flex flex-col gap-0.5", className)}>
      {models.map((model) => (
        <li key={model.id} className="flex items-baseline justify-between gap-3 text-[12px] leading-4">
          <span className="min-w-0 truncate font-mono text-ink">{model.label}</span>
          <span className="shrink-0 text-ink-secondary">{localModelDetail(model.local)}</span>
        </li>
      ))}
    </ul>
  );
}

export function OllamaStatusLine({ status }: { status: Found }) {
  const { text, command, ok } = ollamaStatusText(status);
  return (
    <div data-ollama-state={status.state} className="flex flex-col gap-1">
      <p className={cn("flex items-start gap-1.5 text-[12px] leading-4", ok ? "text-success" : "text-ink-secondary")}>
        {ok && <Check size={13} className="mt-px shrink-0" aria-hidden="true" />}
        <span>{text}</span>
      </p>
      {command && <code className="self-start rounded-md bg-inset px-2 py-1 font-mono text-[12px] leading-4 text-ink select-all">{command}</code>}
    </div>
  );
}
