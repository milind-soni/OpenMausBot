import { useCallback, useInsertionEffect, useRef } from "react";

/** One function for the component's whole life that calls the newest `callback`: a handler handed to a memoised child
 * that does not draw it again each time this component draws. Call it from events, never while rendering. */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback);
  useInsertionEffect(() => { latest.current = callback; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
