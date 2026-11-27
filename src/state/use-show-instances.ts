import { useCallback } from "react";

import type { InstanceInfo } from "./store";
import { useStoreActions, useStoreDispatch } from "./store-select";

export function useShowInstances() {
  const dispatch = useStoreDispatch(), { refreshInstances } = useStoreActions();
  return useCallback(async (answer: unknown) => {
    const instances = (answer as { instances?: unknown } | undefined)?.instances;
    if (Array.isArray(instances)) dispatch({ type: "instances", instances: instances as InstanceInfo[] });
    else await refreshInstances();
  }, [dispatch, refreshInstances]);
}
