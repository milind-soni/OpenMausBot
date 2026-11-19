import { isDeepStrictEqual } from "node:util";

import type { InstanceConfigMap } from "./contracts.ts";

type Entry = InstanceConfigMap[string];

const withoutHidden = ({ hidden: _hidden, ...rest }: Entry) => rest;

export function sameEngineEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  return a !== undefined && b !== undefined && isDeepStrictEqual(withoutHidden(a), withoutHidden(b));
}

export function keepsLoadedEngine(instanceId: string, saved: InstanceConfigMap, before: Entry | undefined, after: Entry | undefined): boolean {
  return Object.hasOwn(saved, instanceId) && sameEngineEntry(before, after);
}
