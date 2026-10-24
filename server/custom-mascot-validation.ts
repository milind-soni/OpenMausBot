import { createHash } from "node:crypto";

import { createCustomMascotFitContext, measureCustomMascotFit } from "../shared/custom-mascot-fitting.ts";
import {
  customMascotDefinitionOf,
  mascotProfileSchema,
  normalizeCustomMascotDefinition,
  type CustomMascotDefinition,
  type CustomMascotShape,
  type MascotProfile,
} from "../shared/mascot-profile.ts";

export function validateCustomMascotDefinition(input: unknown): CustomMascotShape {
  const definition: CustomMascotDefinition = normalizeCustomMascotDefinition(input);
  const fit = measureCustomMascotFit(createCustomMascotFitContext(definition.outline), definition.anchor);
  if (!fit.fits) throw new Error("The face clips outside this outline. Adjust its position or size before saving.");
  const id = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
  return { ...definition, id };
}

export function validateMascotProfile(input: unknown): MascotProfile {
  const profile = mascotProfileSchema.parse(input);
  const shapes = profile.shapes.map((shape) => {
    const validated = validateCustomMascotDefinition(customMascotDefinitionOf(shape));
    if (validated.id !== shape.id) throw new Error("custom mascot fingerprint does not match its contents");
    return validated;
  });
  return mascotProfileSchema.parse({ ...profile, shapes });
}
