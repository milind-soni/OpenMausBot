import { expect, it } from "vitest";
import { bindWorkflow, assertWorkflowBinding, workflowAccountIds, workflowSchemaDigest } from "./binding.ts";

it("binds a workflow to its owner, bot and instructions while allowing schedule changes", () => {
  const binding = bindWorkflow({ owner: "owner", botId: "bot", prompt: "Check my inbox", connectionIds: ["mail-account"] });
  expect(() => assertWorkflowBinding(binding, { owner: "owner", botId: "bot", prompt: "Check my inbox", connectionIds: ["mail-account"] })).not.toThrow();
  for (const changed of [
    { owner: "other", botId: "bot", prompt: "Check my inbox", connectionIds: ["mail-account"] },
    { owner: "owner", botId: "other", prompt: "Check my inbox", connectionIds: ["mail-account"] },
    { owner: "owner", botId: "bot", prompt: "Delete my inbox", connectionIds: ["mail-account"] },
    { owner: "owner", botId: "bot", prompt: "Check my inbox", connectionIds: ["other-account"] },
  ]) expect(() => assertWorkflowBinding(binding, changed)).toThrow(/changed/i);
});

it("detects changes to a connected tool schema without depending on object key order", () => {
  const first = workflowSchemaDigest([{ name: "MAIL_LIST", inputSchema: { type: "object", properties: { folder: { type: "string" } } } }]);
  const reordered = workflowSchemaDigest([{ name: "MAIL_LIST", inputSchema: { properties: { folder: { type: "string" } }, type: "object" } }]);
  const changed = workflowSchemaDigest([{ name: "MAIL_LIST", inputSchema: { type: "object", properties: { folder: { type: "number" } } } }]);
  expect(first).toBe(reordered);
  expect(first).not.toBe(changed);
  const responseString = workflowSchemaDigest([{ name: "MAIL_LIST", inputSchema: {}, outputSchema: { properties: { id: { type: "string" } } } }]);
  const responseNumber = workflowSchemaDigest([{ name: "MAIL_LIST", inputSchema: {}, outputSchema: { properties: { id: { type: "number" } } } }]);
  expect(responseString).not.toBe(responseNumber);
});

it("requires a single identifiable connected account for each service", () => {
  const account = { id: "account-1", status: "ACTIVE" };
  const mail = { connected: true, pending: false, status: "ACTIVE", accounts: [account] };
  expect(workflowAccountIds({ mail }, ["mail"])).toEqual(["mail:account-1"]);
  expect(() => workflowAccountIds({ mail: { ...mail, accounts: [] } }, ["mail"])).toThrow(/identifiable/i);
  expect(() => workflowAccountIds({ mail: { ...mail, accounts: [account, { ...account, id: "account-2" }] } }, ["mail"])).toThrow(/exactly one/i);
  expect(() => workflowAccountIds({}, ["mail"])).toThrow(/identifiable/i);
});
