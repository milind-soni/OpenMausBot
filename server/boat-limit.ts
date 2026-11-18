import { cloudLimitFromBody, cloudLimitSentence, type CloudLimit } from "../shared/place-view.ts";

type CloudFailure = { message: string; code?: string; status?: number; limit?: CloudLimit };

export function cloudFailureOf(error: unknown): CloudFailure {
  const failure = error instanceof Error ? error : new Error(String(error));
  const { boatCode, boatStatus, status } = failure as { boatCode?: unknown; boatStatus?: unknown; status?: unknown };
  const providerStatus = typeof boatStatus === "number" ? boatStatus : typeof status === "number" ? status : undefined;
  const limit = cloudLimitFields(failure).cloudLimit;
  return {
    message: failure.message,
    ...(typeof boatCode === "string" ? { code: boatCode } : {}),
    ...(providerStatus !== undefined ? { status: providerStatus } : {}),
    ...(limit ? { limit } : {}),
  };
}

/** What the bot is told when the Admin turned its cloud computer away by one of the Cloud's limits. */
export const cloudLimitText = (error: unknown): string | undefined => cloudLimitSentence(cloudFailureOf(error)) ?? undefined;

/** An HTTP error body's `cloudLimit`: the Admin's limit, beside the words, for the app to read. */
export function cloudLimitFields(error: unknown): { cloudLimit?: CloudLimit } {
  const limit = error && typeof error === "object" ? cloudLimitFromBody((error as { boatLimit?: unknown }).boatLimit) : undefined;
  return limit ? { cloudLimit: limit } : {};
}
