import { z } from "zod";
import { MAX_APPROVAL_REVIEW_INSTRUCTIONS_LENGTH } from "../shared/approval-review.ts";

export function createApprovalReviewSchemas<S extends z.ZodType>(selectedModel: S) {
  const approvalReviewSchema = z.object({
    model: selectedModel.optional(),
    instructions: z.string().max(MAX_APPROVAL_REVIEW_INSTRUCTIONS_LENGTH).optional(),
  }).strict();
  const approvalReviewPatchSchema = approvalReviewSchema.extend({
    model: approvalReviewSchema.shape.model.nullable(),
  });
  return { approvalReviewSchema, approvalReviewPatchSchema };
}
