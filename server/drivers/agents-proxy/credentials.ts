// The secure credential flow: ask the user for a supported API key through
// OpenMausBot's key card instead of chat.
import { CREDENTIAL_TARGETS, isCredentialTargetId } from "../../../shared/credential-request.ts";
import type { Json, ToolContext, ToolHandler, ToolOutcome } from "./context.ts";

export const handlers = {
  async request_credential(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const credentialId = args.credential_id;
    if (!isCredentialTargetId(credentialId)) {
      return { text: "request_credential needs a supported credential_id.", isError: true };
    }
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 240) : "";
    const r = await ctx.api("/api/internal/request-credential", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        credentialId,
        ...(reason ? { reason } : {}),
      }),
    });
    if (r.alreadyConfigured) {
      return { text: `${r.label ?? CREDENTIAL_TARGETS[credentialId].label} is already configured. Continue the task.` };
    }
    return {
      text: `A secure ${r.label ?? CREDENTIAL_TARGETS[credentialId].label} request is ready. The desktop app and a freshly QR-paired mobile app show its secure entry card; older mobile pairings explain how to pair again or finish on the computer. End this turn; OpenMausBot will resume the task after the user saves or declines. Never ask them to paste the key into chat.`,
    };
  },
} satisfies Record<string, ToolHandler>;
