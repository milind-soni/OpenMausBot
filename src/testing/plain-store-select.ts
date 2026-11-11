// For a test that calls a component as a plain function and mocks useStore(): the selector hooks read that mock.
import { useStore, type AppState } from "@/state/store";
import type * as StoreSelect from "@/state/store-select";

export function plainStoreSelect(original: typeof StoreSelect): typeof StoreSelect {
  return {
    ...original,
    useStoreSelector: <T,>(selector: (state: AppState) => T) => selector(useStore().state),
    useStoreDispatch: () => useStore().dispatch,
    useStoreActions: () => useStore(),
  };
}
