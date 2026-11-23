export function parseForkRequest(body: unknown): { messageId?: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) return null;
  if ("messageId" in body && typeof body.messageId === "string") return { messageId: body.messageId };
  return "latest" in body && body.latest === true ? {} : null;
}

export const FORK_BUSY = { error: "this conversation is running — wait for it to finish", errorKey: "serverError.forkBusy" };
export const FORK_NO_TEXT = { error: "This conversation has no text message to fork from yet.", errorKey: "serverError.forkNoText" };
