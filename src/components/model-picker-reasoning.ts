import { useEffect, useRef, type RefObject } from "react";
import type { AppState, InstanceInfo, ModelSelection } from "@/state/store";

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
    (menu.querySelector<HTMLElement>('[data-simple-effort] [tabindex="0"]') ?? menu).focus({ preventScroll: true });
  }, [selection, query, open, menuRef]);
  return () => { pending.current = true; };
}
