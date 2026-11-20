import { useCallback } from "react";

import { useStore, type InstanceInfo } from "./store";

export function useShowInstances() {
  const { dispatch, refreshInstances } = useStore();
  return useCallback(async (answer: unknown) => {
    const instances = (answer as { instances?: unknown } | undefined)?.instances;
    if (Array.isArray(instances)) dispatch({ type: "instances", instances: instances as InstanceInfo[] });
    else await refreshInstances();
  }, [dispatch, refreshInstances]);
}
