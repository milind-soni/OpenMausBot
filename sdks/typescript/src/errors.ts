export class MausBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class APIStatusError extends MausBotError {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}
export class BadRequestError extends APIStatusError {}
export class AuthenticationError extends APIStatusError {}
export class PermissionDeniedError extends APIStatusError {}
export class NotFoundError extends APIStatusError {}
export class ConflictError extends APIStatusError {}
export class ServerError extends APIStatusError {}

export class RateLimitError extends APIStatusError {
  constructor(message: string, status: number, body: unknown, readonly retryAfter?: number) {
    super(message, status, body);
  }
}

export class ServerTooOldError extends NotFoundError {
  constructor(status: number, body: unknown) {
    super(
      "This MausBot server is too old for this SDK: it has no /v1 Bot API address. Update MausBot on the computer that runs this bot.",
      status,
      body,
    );
  }
}

export class APIConnectionError extends MausBotError {}

export class WaitTimeoutError extends MausBotError {
  constructor(message: string, readonly thread: string) {
    super(message);
  }
}
export class JobFailedError extends MausBotError {
  constructor(message: string, readonly thread: string) {
    super(message);
  }
}
export class NotSentError extends MausBotError {
  constructor(message: string, readonly thread: string) {
    super(message);
  }
}

export function errorFor(status: number, body: unknown, headers: Headers): APIStatusError {
  const text = (body as { error?: unknown } | undefined)?.error;
  const message = typeof text === "string" ? text : `HTTP ${status}`;
  if (status === 404 && text === "Unknown webhook endpoint") return new ServerTooOldError(status, body);
  if (status === 429) {
    const after = headers.get("retry-after");
    return new RateLimitError(message, status, body, after !== null && /^\d+$/.test(after.trim()) ? Number(after) : undefined);
  }
  if (status >= 500) return new ServerError(message, status, body);
  const Class = { 400: BadRequestError, 413: BadRequestError, 415: BadRequestError, 401: AuthenticationError, 403: PermissionDeniedError, 404: NotFoundError, 409: ConflictError }[status] ?? APIStatusError;
  return new Class(message, status, body);
}
