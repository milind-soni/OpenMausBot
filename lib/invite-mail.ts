import nodemailer from "nodemailer";
import { createHash } from "node:crypto";
import { originUrl } from "./integration-bridge";
import { store } from "./server-store";

export async function sendInviteMail(invite: { token: string; teamName: string }, email: string, actorName: string, requestId?: string) {
  const inviteLink = `${originUrl()}/join/${invite.token}`;
  if (!process.env.ORIGIN_SMTP_HOST) return { inviteLink, sent: false };
  const deliveryId = requestId ? createHash("sha256").update(`${requestId}:${email}:${invite.token}`).digest("hex") : null;
  if (deliveryId) {
    // Claim before SMTP (in Convex, so every instance agrees): an ambiguous network failure must not send a duplicate invite.
    const claim = await store<{ claimed: boolean; sent: boolean }>("store.inviteClaim", { deliveryId });
    if (!claim.claimed) return { inviteLink, sent: claim.sent };
  }
  try {
    const transport = nodemailer.createTransport({ host: process.env.ORIGIN_SMTP_HOST, port: Number(process.env.ORIGIN_SMTP_PORT || "465"), secure: process.env.ORIGIN_SMTP_SECURE !== "false", auth: { user: process.env.ORIGIN_SMTP_USER, pass: process.env.ORIGIN_SMTP_PASSWORD }, connectionTimeout: 10000, socketTimeout: 15000 });
    await transport.sendMail({ from: process.env.ORIGIN_SMTP_FROM || process.env.ORIGIN_SMTP_USER, to: email, subject: `Join ${invite.teamName} on Origin`, text: `${actorName} invited you to ${invite.teamName}.\n\nJoin the workspace: ${inviteLink}\n\nThis invitation expires in 7 days.`, ...(requestId ? { messageId: `<${createHash("sha256").update(requestId).digest("hex")}@${new URL(originUrl()).hostname}>` } : {}) });
    if (deliveryId) await store("store.inviteSent", { deliveryId }).catch(() => {});
    return { inviteLink, sent: true };
  } catch { return { inviteLink, sent: false }; }
}
