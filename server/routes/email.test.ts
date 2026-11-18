import { describe, expect, it } from "vitest";
import type { EmailService } from "../email/service.ts";
import { createEmailRoutes } from "./email.ts";

describe("mailbox route refusals", () => {
  async function call(admin: boolean, input: unknown, path = "/api/email/accounts", service: Partial<EmailService> = {}, type = "application/json") {
    const answers: unknown[] = [];
    await createEmailRoutes({ service: service as EmailService })({
      req: { headers: { "content-type": type } }, res: { setHeader() {} },
      path, method: "POST", auth: { scopes: admin ? ["admin"] : [] },
      json: (_res: unknown, status: number, body: unknown) => answers.push([status, body]), readBody: async () => input,
    } as never);
    return answers;
  }
  it("keeps English and identifies the owner/admin refusal", async () => {
    expect(await call(false, {})).toEqual([[403, { error: "Only the owner or an admin can manage the mailboxes.", errorKey: "serverError.mailbox.adminOnly" }]]);
  });
  it("keeps English and identifies invalid connection fields", async () => {
    expect(await call(true, {})).toEqual([[400, { error: "Enter your email address and password.", errorKey: "serverError.mailbox.addressAndPassword" }]]);
  });
  it("checks sending again with only the outgoing fields, and a test send only as JSON", async () => {
    const checked: unknown[] = [];
    const service = { checkOutgoing: async (address: string, fields: unknown) => { checked.push([address, fields]); return { ok: true }; }, sendTest: async () => ({ ok: true }) } as unknown as Partial<EmailService>;
    const at = `/api/email/accounts/${encodeURIComponent("me@shop.example")}`;
    expect(await call(true, { smtpHost: "smtp.shop.example", smtpPort: 465, smtpSecurity: "tls" }, `${at}/outgoing`, service)).toEqual([[200, { ok: true }]]);
    expect(checked).toEqual([["me@shop.example", { smtpHost: "smtp.shop.example", smtpPort: 465, smtpSecurity: "tls" }]]);
    expect(await call(true, { smtpHost: "smtp.shop.example", password: "x" }, `${at}/outgoing`, service)).toEqual([[400, { error: expect.stringContaining("outgoing server"), errorKey: "serverError.mailbox.outgoingFields" }]]);
    expect(await call(true, {}, `${at}/test`, service, "text/plain")).toEqual([[415, { error: "content-type must be application/json" }]]);
    expect(await call(true, {}, `${at}/test`, service)).toEqual([[200, { ok: true }]]);
    expect(await call(false, {}, `${at}/test`, service)).toMatchObject([[403, {}]]);
  });
});
