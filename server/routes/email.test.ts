import { describe, expect, it } from "vitest";
import type { EmailService } from "../email/service.ts";
import { createEmailRoutes } from "./email.ts";

describe("mailbox route refusals", () => {
  async function call(admin: boolean, input: unknown) {
    const answers: unknown[] = [];
    await createEmailRoutes({ service: {} as EmailService })({
      req: { headers: { "content-type": "application/json" } }, res: { setHeader() {} },
      path: "/api/email/accounts", method: "POST", auth: { scopes: admin ? ["admin"] : [] },
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
});
