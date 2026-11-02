// The app store's dispatch and a reader of its newest state, under a context whose value never changes. A component
// that only uses the store from an event handler (react to a message, open a link or a page) reads it through here,
// so it does not render again on every state change as a useStore() reader does.
import { createContext, use, useContext, type Dispatch } from "react";
import { StoreContext, type Action, type AppState } from "./store";

export interface StoreRef {
  dispatch: Dispatch<Action>;
  /** The newest state, for an event handler; never read while rendering. */
  state(): AppState;
}

export const StoreRefContext = createContext<StoreRef | null>(null);

/** The store to act on, or null outside the app's store. Inside a scoped store (a bot editor's) it is that store's,
 * read like useStore() so it stays current. */
export function useStoreRef(): StoreRef | null {
  const ref = useContext(StoreRefContext);
  // use() may run conditionally: only a scoped store's readers subscribe to it.
  const scoped = ref ? null : use(StoreContext);
  return ref ?? (scoped ? { dispatch: scoped.dispatch, state: () => scoped.state } : null);
}

export function useStoreDispatch(): Dispatch<Action> {
  const ref = useStoreRef();
  if (!ref) throw new Error("useStoreDispatch outside provider");
  return ref.dispatch;
}
