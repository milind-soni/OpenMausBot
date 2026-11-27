// The error tags, their messages and the net-error table follow T3 Code's
// apps/server/src/preview/ServerBrowserPage.ts, Copyright 2026 T3 Tools Inc.,
// used under the MIT License (third_party/t3-code/LICENSE).

export type DriverErrorCode =
  | "timeout"
  | "stale-ref"
  | "invalid-selector"
  | "not-found"
  | "ambiguous"
  | "not-editable"
  | "covered"
  | "not-visible"
  | "execution"
  | "result-too-large"
  | "navigation"
  | "dialog-pending"
  | "secret-on-page"
  | "closed"
  | "forbidden-method"
  | "refused";

export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly detail: Readonly<Record<string, unknown>> | undefined;

  constructor(code: DriverErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "DriverError";
    this.code = code;
    this.detail = detail;
  }
}

/** An error the browser answered a command with. */
export class CdpProtocolError extends Error {
  readonly method: string;
  readonly protocolCode: number | undefined;

  constructor(method: string, message: string, protocolCode?: number) {
    super(`${method}: ${message}`);
    this.name = "CdpProtocolError";
    this.method = method;
    this.protocolCode = protocolCode;
  }
}

export const staleRefError = (ref: string) =>
  new DriverError(
    "stale-ref",
    `The element ref ${ref} is stale or belongs to another tab. Take a fresh snapshot and use its ref.`,
    { staleRef: true, ref },
  );

// Chrome's answers when the target, frame, node or world a command names no longer exists.
const GONE =
  /Target closed|Session closed|No session with given id|No target with given id|Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed|Could not find node with given id|No node with given id found|Node with given id does not belong to the document|Frame with the given id was not found|No frame for given id found|Cannot find default execution context|Node is detached from document/i;

export function isGone(error: unknown): boolean {
  if (error instanceof DriverError) return error.code === "closed";
  return error instanceof Error && GONE.test(error.message);
}

/** Chrome never answered a command: whatever it was doing may still be running. */
export function isUnanswered(error: unknown): boolean {
  return error instanceof DriverError && error.code === "timeout" && error.detail?.unanswered === true;
}

export function isMissingContext(error: unknown): boolean {
  return error instanceof Error && /Cannot find context with specified id|Execution context was destroyed|Cannot find default execution context/i.test(error.message);
}

export function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

const NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_ABORTED: -3,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_EMPTY_RESPONSE: -324,
};

export function parseNetError(errorText: string): { description: string; code: number } {
  const description = /ERR_[A-Z_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
}
