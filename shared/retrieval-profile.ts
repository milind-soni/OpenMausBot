import { z } from "zod";

export const retrievalProfileSchema = z.enum(["off", "task-scoped"]);

export type RetrievalProfile = z.output<typeof retrievalProfileSchema>;
