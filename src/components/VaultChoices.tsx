import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";

import type { VaultChoice } from "../../shared/vault";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { savedChoices, useSaved, type ChoiceKind } from "@/lib/vault";
import { ASK_CHIP, ASK_CHIP_IDLE, returnFocusToComposer } from "./AskCard";

// Security: names only. Picking one never brings its value here: the server hands it to the bot and answers the card.

/** "Use a saved one" on a secure card: shown only when the Vault holds something that could fit and this person may
 * change the Vault. */
export function VaultChoices({ kind, botId, botName, threadId, messageId }: {
  kind: ChoiceKind;
  botId: string;
  botName?: string;
  threadId: string;
  messageId: string;
}) {
  const [choices, setChoices] = useState<VaultChoice[]>([]);
  const [using, setUsing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    savedChoices(kind, { botId, threadId, messageId }).then((found) => { if (live) setChoices(found); }, () => { if (live) setChoices([]); });
    return () => { live = false; };
  }, [kind, botId, threadId, messageId]);

  if (!choices.length) return null;
  const use = async (choice: VaultChoice) => {
    if (using) return;
    setUsing(choice.id);
    setError(null);
    try {
      await useSaved(kind, { botId, threadId, messageId }, choice.id);
      returnFocusToComposer();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("vault.choices.error"));
    } finally {
      setUsing(null);
    }
  };
  return (
    <div className="mb-2.5 flex flex-col gap-1.5" data-vault-choices={kind}>
      <div className="text-[12px] font-medium text-ink-secondary">{t(kind === "login" ? "vault.choices.login" : "vault.choices.secret")}</div>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((choice) => (
          <button key={choice.id} type="button" disabled={using !== null} onClick={() => void use(choice)} data-vault-choice={choice.id}
            className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
            {using === choice.id ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} aria-hidden="true" />}
            <bdi dir="auto" className="truncate">{choice.name}</bdi>
            {choice.provider === "1password" && <span className="text-ink-tertiary">· 1Password</span>}
          </button>
        ))}
      </div>
      {botName && <p className="text-[12px] leading-snug text-ink-tertiary">{t("vault.choices.note", { bot: botName })}</p>}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
