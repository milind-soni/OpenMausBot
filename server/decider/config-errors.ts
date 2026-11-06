import { parseConfigPatch } from "../config.ts";
import { USER_ERROR, userError, userErrorFields } from "../user-errors.ts";

export function parseConfigPatchForPerson(value: Parameters<typeof parseConfigPatch>[0]): ReturnType<typeof parseConfigPatch> {
  try {
    return parseConfigPatch(value);
  } catch (error) {
    if (error instanceof Error && error.message === USER_ERROR["serverError.decider.accountFormat"]) {
      Object.assign(error, userErrorFields(userError("serverError.decider.accountFormat")));
    }
    throw error;
  }
}
