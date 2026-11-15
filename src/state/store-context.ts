import { createContext, type Dispatch } from "react";
import type { Action, AppState, BotAnnouncement } from "./store";

export interface StoreActions {
  dispatch: Dispatch<Action>;
  flushBotPatches: (botId: string) => Promise<BotAnnouncement | null>;
  refreshInstances: (options?: { reportErrors?: boolean; cached?: boolean }) => Promise<void>;
  refreshModels: (instanceId: string) => Promise<void>;
}

export interface StoreValue extends StoreActions {
  state: AppState;
}

/** The app store for useSyncExternalStore: the value never changes, `getState` is the newest state. */
export interface StoreSource extends StoreActions {
  getState(): AppState;
  subscribe(listener: () => void): () => void;
}

export const StoreContext = createContext<StoreValue | null>(null);

export const StoreSourceContext = createContext<StoreSource | null>(null);
