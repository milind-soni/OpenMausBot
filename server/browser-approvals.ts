import { z } from "zod";
import type { RequestAuth } from "./request-auth.ts";

/** An explicit standalone-host policy, never a setting writable by bots. */
export function browserFullAccessEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OMB_ALLOW_BROWSER_FULL_ACCESS === "1";
}

export function browserApprovalAccess(auth: RequestAuth, enabled: boolean): boolean {
  return enabled && auth.kind === "session" && auth.via === "cookie" && auth.scopes.includes("admin");
}

export const browserApprovalSchema = z.object({
  mode: z.enum(["ask", "edits", "auto", "full"]),
  threadId: z.string().regex(/^[\w-]{1,128}$/).optional(),
  threadOnly: z.boolean().optional(),
  confirmFullAccess: z.boolean().optional(),
  acknowledgeLocalAuto: z.boolean().optional(),
}).strict().refine(value => value.threadOnly === true ? value.threadId !== undefined : value.threadId === undefined, {
  message: "Select either a single thread or the bot default",
});
