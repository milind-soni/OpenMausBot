import type { ServerResponse } from "node:http";

import type { InternalCapability } from "../internal.ts";
import type { RoutineManager } from "../../routines.ts";
import type { BotRecord } from "../../store.ts";

// Per-request values every /api/internal family handler reads. The dispatch
// closure in ./internal.ts builds exactly one ctx object per request, after
// the bearer capability and its sender are resolved; each family module
// narrows it to the members its handlers use, so moved bodies keep the bare
// closure names they were written with.

/** json(...) replies and reports ownership, so family bodies keep their
 * original `return json(...)` shape (see ./internal.ts). */
export type InternalJson = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => boolean;

export type ReadInternalBody = () => Promise<any>;
export type RequireActiveInternalCapability = () => void;
export type MemorySource = () => string;

export type InternalRequestCtx = {
  internalCapability: InternalCapability;
  internalSender: BotRecord;
  routines: RoutineManager | null;
  json: InternalJson;
  readInternalBody: ReadInternalBody;
  requireActiveInternalCapability: RequireActiveInternalCapability;
  memorySource: MemorySource;
};
