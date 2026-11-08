import { useEffect, useRef, type RefObject } from "react";
import type { AppState, Bot, InstanceInfo, ModelSelection } from "@/state/store";
import type { ModelVariantOption } from "../../shared/runtime-events";
import { t } from "@/lib/i18n";

export const variantLabel = (option: ModelVariantOption, driverKind?: string): string =>
  option.id === "default" && driverKind === "opencodeGo" ? t("model.variant.openCodeDefault") : option.label;

/** ACP variant ids are opaque; their model/session declares the available choices. */
export function variantChoices(state: Pick<AppState, "instances" | "modelVariantSessions">, selection: ModelSelection, threadId: string | undefined) {
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!instance?.capabilities?.modelVariants) return null;
  const session = threadId === undefined ? undefined : state.modelVariantSessions[threadId];
  const reported = session?.instanceId === selection.instanceId && session.model === selection.model ? session.variants : undefined;
  const options = reported?.options ?? instance.models.options.find((option) => option.id === selection.model)?.variants ?? [];
  if (!options.length && selection.variant === undefined) return null;
  return { instance, reported, options };
}

/** Whether the full menu shows a reasoning row (effort levels or model variants) for `next` on `instance`. */
export function offersReasoning(state: Pick<AppState, "instances" | "modelVariantSessions">, instance: InstanceInfo, next: ModelSelection, threadId: string | undefined): boolean {
  return instance.capabilities?.modelVariants
    ? Boolean(variantChoices(state, next, threadId))
    : Boolean(instance.capabilities?.effortLevels?.length);
}

/**
 * While a bot works its menu stays locked, unless it offers a reasoning row: the reasoning level is the one change
 * allowed mid-turn, and it applies from the next turn.
 */
export function lockedWhileBusy(state: Pick<AppState, "instances" | "modelVariantSessions">, bot: Pick<Bot, "busy" | "modelSelection" | "threadId">, contained: boolean | undefined, threadId: string | undefined): boolean {
  if (!bot.busy) return false;
  const instance = contained ? undefined : state.instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  return !(instance && offersReasoning(state, instance, bot.modelSelection, threadId ?? bot.threadId));
}

/**
 * Applying a pick, or clearing the search after one, can redraw or remove the focused row and drop focus out of
 * the open menu. Call the returned function after either: focus comes back (to the thinking level when there is
 * one) so Escape and the arrow keys keep working.
 */
export function useRefocusAfterPick(menuRef: RefObject<HTMLElement | null>, open: boolean, selection: ModelSelection, query: string): () => void {
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    const menu = menuRef.current;
    if (!open || !menu || menu.contains(document.activeElement)) return;
    (menu.querySelector<HTMLElement>(':not([hidden]) > [data-simple-effort] [tabindex="0"]') ?? menu).focus({ preventScroll: true });
  }, [selection, query, open, menuRef]);
  return () => { pending.current = true; };
}
