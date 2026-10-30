import type { JobError, JobErrorCode } from "./protocol.ts";
import { redact } from "./log.ts";

/** A job that could not do what it was asked, with what to tell the Admin. */
export class JobFailure extends Error {
  readonly code: JobErrorCode;
  readonly image: string | undefined;

  constructor(code: JobErrorCode, message: string, image?: string) {
    super(message);
    this.name = "JobFailure";
    this.code = code;
    this.image = image;
  }

  toJobError(): JobError {
    return { code: this.code, message: redact(this.message), ...(this.image ? { image: this.image } : {}) };
  }
}

export function asJobError(error: unknown, fallback: JobErrorCode = "docker"): JobError {
  if (error instanceof JobFailure) return error.toJobError();
  return { code: fallback, message: redact(error instanceof Error ? error.message : String(error)) };
}
