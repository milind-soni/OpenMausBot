import { z } from "zod";
import { EFFORT_LEVELS } from "../shared/wire.ts";

export const autoEffortSchema = z.object({
  min: z.enum(EFFORT_LEVELS).optional(),
  max: z.enum(EFFORT_LEVELS).optional(),
  automated: z.boolean().optional(),
}).strict().refine((value) => !value.min || !value.max || EFFORT_LEVELS.indexOf(value.min) <= EFFORT_LEVELS.indexOf(value.max)).nullable();
