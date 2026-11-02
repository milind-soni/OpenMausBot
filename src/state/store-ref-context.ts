import { createContext, type Dispatch } from "react";
import type { Action, AppState } from "./store";

/** The app store's dispatch and a reader of its newest state: this value never changes. Read it with useStoreRef. */
export interface StoreRef {
  dispatch: Dispatch<Action>;
  /** The newest state, for an event handler; never read while rendering. */
  state(): AppState;
}

export const StoreRefContext = createContext<StoreRef | null>(null);
