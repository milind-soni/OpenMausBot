// For a component that only uses the store from an event handler (react to a message, open a link or a page): it does
// not render again on every state change as a useStore() reader does.
import { use, useContext } from "react";
import { StoreContext, useStore as readStore } from "./store";
import { StoreRefContext, type StoreRef } from "./store-ref-context";

const scopedRef = ({ dispatch, state }: Pick<ReturnType<typeof readStore>, "dispatch" | "state">): StoreRef => ({ dispatch, state: () => state });

/** Inside a scoped store (a bot editor's) this is that store's, followed like useStore(). Throws outside any store.
 * readStore only reads a context, and a component stays on one side of this branch, so calling it here is safe. */
export function useStoreRef(): StoreRef {
  return useContext(StoreRefContext) ?? scopedRef(readStore());
}

/** The same for what may be drawn outside any store: null there. */
export function useOptionalStoreRef(): StoreRef | null {
  const ref = useContext(StoreRefContext);
  if (ref) return ref;
  const scoped = use(StoreContext);
  return scoped && scopedRef(scoped);
}
