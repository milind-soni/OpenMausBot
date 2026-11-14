import type { Detector } from "../types.ts";
import { cost } from "./cost.ts";
import { queueWait } from "./queue-wait.ts";
import { retryLoop } from "./retry-loop.ts";
import { toolError } from "./tool-error.ts";
import { turnStop } from "./turn-stop.ts";

export const DETECTORS: readonly Detector[] = [toolError, turnStop, queueWait, cost, retryLoop];
