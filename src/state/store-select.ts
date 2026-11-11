import { use, useContext, useRef, useSyncExternalStore } from "react";
import type { AppState } from "./store";
import { StoreContext, StoreSourceContext, type StoreActions, type StoreSource, type StoreValue } from "./store-context";

const scopedSources = new WeakMap<StoreValue, StoreSource>();
const noSubscription = () => () => {};

/** A store given as a plain value (a bot editor's, a preview's) changes by being given again, so it needs no
 * subscription: its reader is already a context reader of that value. */
function scopedSource(value: StoreValue): StoreSource {
  let source = scopedSources.get(value);
  if (!source) {
    source = { ...value, getState: () => value.state, subscribe: noSubscription };
    scopedSources.set(value, source);
  }
  return source;
}

function useStoreSource(): StoreSource {
  const source = useContext(StoreSourceContext);
  if (source) return source;
  const scoped = use(StoreContext);
  if (!scoped) throw new Error("useStoreSelector outside provider");
  return scopedSource(scoped);
}

interface Selection<T> {
  state: AppState;
  selector: (state: AppState) => T;
  value: T;
}

/** Renders again only when the selected value changes under `equal`. A selector may be a new closure each render. */
export function useStoreSelector<T>(selector: (state: AppState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const source = useStoreSource();
  const last = useRef<Selection<T> | null>(null);
  const read = () => {
    const state = source.getState();
    const previous = last.current;
    if (previous && previous.state === state && previous.selector === selector) return previous.value;
    const value = selector(state);
    const kept = previous && equal(previous.value, value) ? previous.value : value;
    last.current = { state, selector, value: kept };
    return kept;
  };
  return useSyncExternalStore(source.subscribe, read, read);
}

/** The store's actions without its state: never renders again on a state change. */
export function useStoreActions(): StoreActions {
  return useStoreSource();
}

export function useStoreDispatch(): StoreActions["dispatch"] {
  return useStoreSource().dispatch;
}

/** For a selector that builds an array: equal when every item is the same object. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}

/** For a selector that builds a record of slices: equal when every field is the same value. */
export function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}
