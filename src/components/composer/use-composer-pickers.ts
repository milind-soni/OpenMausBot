// Wave 20 split: the slash-command and @mention picker island moved
// verbatim out of Composer into this hook. Composer passes the draft,
// caret and picker state the island closes over in through deps; the
// hook call sits where the island used to, so hook order is unchanged.
import { useEffect, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { skillAuthoringEnabled } from "@/lib/feature-flags";
import { activeLocale, t } from "@/lib/i18n";
import { mentionChoicesForQuery } from "@/lib/mentions";
import {
  composerSlashTrigger,
  replaceComposerSlashTrigger,
  type ComposerSlashCommand,
} from "@/lib/composer-commands";
import type { Bot, Group } from "@/state/store";
import type { AppState } from "@/state/reducer";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

export type MentionChoice = { id: string; name: string; bot?: Bot };

/** The Composer bindings the picker island closes over. */
export interface ComposerPickerDeps {
  state: AppState;
  bot: Bot | undefined;
  group: Group | undefined;
  members: Bot[] | undefined;
  text: string;
  caret: number;
  highlight: number;
  setHighlight: Dispatch<SetStateAction<number>>;
  dismissedAt: number | null;
  setDismissedAt: Dispatch<SetStateAction<number | null>>;
  dismissedSlashAt: number | null;
  setDismissedSlashAt: Dispatch<SetStateAction<number | null>>;
  setCaret: Dispatch<SetStateAction<number>>;
  setChannelMode: (next: SetStateAction<"chat" | "goal">) => void;
  editText: (next: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  mentionListRef: RefObject<HTMLDivElement | null>;
}

export function useComposerPickers(deps: ComposerPickerDeps) {
  const {
    state,
    bot,
    group,
    members,
    text,
    caret,
    highlight,
    setHighlight,
    dismissedAt,
    setDismissedAt,
    dismissedSlashAt,
    setDismissedSlashAt,
    setCaret,
    setChannelMode,
    editText,
    inputRef,
    mentionListRef,
  } = deps;
  const slash = composerSlashTrigger(text, caret);
  const locale = activeLocale();
  const commandCandidates = useMemo(() => {
    if (!slash || slash.start === dismissedSlashAt) return [];
    const supportsAgents = (candidate?: Bot) =>
      Boolean(
        candidate &&
          state.instances.find(
            (instance) => instance.instanceId === candidate.modelSelection.instanceId,
          )?.capabilities?.agentsMcp,
      );
    const available: ComposerSlashCommand[] = [];
    if (group && !group.dm) available.push({
      id: "goal",
      label: "/goal",
      description: t("composer.command.goalDesc"),
    });
    if (
      skillAuthoringEnabled(state.config) &&
      (group ? (members ?? []).some(supportsAgents) : supportsAgents(bot))
    ) {
      available.push({
        id: "learn",
        label: "/learn",
        description: t("composer.command.learnDesc"),
      });
    }
    // Setup mode needs the agents tools (propose_profile and friends) and a
    // single bot: a room cannot set itself up.
    if (!group && supportsAgents(bot)) available.push({
      id: "setup",
      label: "/setup",
      description: t("composer.command.setupDesc"),
    });
    const query = slash.query.toLowerCase();
    return available.filter(
      (command) =>
        !query ||
        command.id.startsWith(query) ||
        command.description.toLowerCase().includes(query),
    );
  }, [slash, dismissedSlashAt, group, members, bot, state.config, state.instances, locale]);
  const commandPickerOpen = commandCandidates.length > 0;

  // Tag another bot; the agent reaches it via ask_bot.
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          ...(!group.dm ? [{ id: "__everyone__", name: "everyone" }] : []),
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    return mentionChoicesForQuery(pool, mention.query);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members]);
  const mentionPickerOpen = candidates.length > 0;

  useEffect(
    () => setHighlight(0),
    [mention?.start, mention?.query, slash?.start, slash?.query],
  );

  useEffect(() => {
    if (!mentionPickerOpen) return;
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, mentionPickerOpen]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  const pickCommand = (command: ComposerSlashCommand) => {
    if (!slash) return;
    const replacement = command.id === "learn" ? "/learn " : command.id === "setup" ? "/setup " : "";
    const next = replaceComposerSlashTrigger(text, slash, replacement);
    editText(next.text);
    setCaret(next.caret);
    setDismissedSlashAt(slash.start);
    setChannelMode(command.id === "goal" ? "goal" : "chat");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  return {
    slash,
    mention,
    commandCandidates,
    commandPickerOpen,
    candidates,
    mentionPickerOpen,
    pickMention,
    pickCommand,
  };
}
