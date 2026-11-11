import { describe, expect, test } from "vitest";
import {
  issueWebhookChanges, issueWebhookPayload, issueWebhookRequest, issueWebhookUrlError, repositorySlug, sampleIssueWebhookPayload, signIssueWebhook,
} from "./issue-webhook";

const input = {
  id: "evt_1",
  type: "issue.created" as const,
  occurredAt: Date.UTC(2026, 10, 11, 9),
  workspace: { id: "team1", name: "Acme", slug: "acme" },
  project: { id: "project1", name: "Web", repoUrl: "https://github.com/acme/web.git" },
  issue: { id: "task1", key: "ORI-AB12", title: "Import CSV", status: "Draft", completed: false },
};

describe("issue webhook payload", () => {
  test("has the documented shape, key order and defaults", () => {
    const payload = issueWebhookPayload(input);
    expect(JSON.stringify(payload)).toBe(JSON.stringify({
      id: "evt_1", type: "issue.created", occurredAt: "2026-11-11T09:00:00.000Z",
      workspace: { id: "team1", name: "Acme", slug: "acme" },
      project: { id: "project1", name: "Web", repo: "acme/web" },
      issue: { id: "task1", key: "ORI-AB12", title: "Import CSV", description: "", labels: [], url: "/acme/issue/ORI-AB12", status: "Draft", completed: false, assignee: null, acceptanceCriteria: [] },
      changes: null,
    }));
  });

  test("absolutizes the issue url with the public origin and fills assignee, labels and criteria", () => {
    const payload = issueWebhookPayload({
      ...input, origin: "https://origin.example/", project: { id: "p", name: "No repo" },
      issue: { ...input.issue, description: "Body", labels: ["Needs spec"], assignee: { email: "a@b.c", name: "A" }, acceptanceCriteria: [{ text: "Works", checked: true }] },
    });
    expect(payload.issue).toMatchObject({ url: "https://origin.example/acme/issue/ORI-AB12", description: "Body", labels: ["Needs spec"], assignee: { email: "a@b.c", name: "A" }, acceptanceCriteria: [{ text: "Works", checked: true }] });
    expect(payload.project.repo).toBeNull();
    expect(issueWebhookPayload({ ...input, issue: { ...input.issue, assignee: { email: "x@y.z" } } }).issue.assignee).toEqual({ email: "x@y.z", name: "x@y.z" });
  });

  test("issue.created never carries changes; issue.updated carries only what changed", () => {
    expect(issueWebhookPayload({ ...input, changes: { completed: { from: false, to: true } } }).changes).toBeNull();
    expect(issueWebhookChanges({ status: "Draft", completed: false }, { status: "Todo", completed: false })).toEqual({ status: { from: "Draft", to: "Todo" } });
    expect(issueWebhookChanges({ status: "In review", completed: false }, { status: "Done", completed: true })).toEqual({ status: { from: "In review", to: "Done" }, completed: { from: false, to: true } });
    expect(issueWebhookChanges({ status: "Done", completed: true }, { status: "Done", completed: false })).toEqual({ completed: { from: true, to: false } });
    expect(issueWebhookChanges({ status: "Todo", completed: false }, { status: "Todo", completed: false })).toBeNull();
    const updated = issueWebhookPayload({ ...input, type: "issue.updated", changes: { status: { from: "Draft", to: "Todo" } } });
    expect(updated.changes).toEqual({ status: { from: "Draft", to: "Todo" } });
  });

  test("event ids are evt_ followed by random hex", () => {
    const { id } = issueWebhookPayload({ ...input, id: undefined });
    expect(id).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(issueWebhookPayload({ ...input, id: undefined }).id).not.toBe(id);
  });

  test("reads owner/repo from GitHub URLs and shorthands only", () => {
    expect(repositorySlug("https://github.com/z4mbo/Origin")).toBe("z4mbo/Origin");
    expect(repositorySlug("github.com/z4mbo/Origin.git/")).toBe("z4mbo/Origin");
    expect(repositorySlug("z4mbo/Origin")).toBe("z4mbo/Origin");
    expect(repositorySlug("https://gitlab.com/a/b")).toBeNull();
    expect(repositorySlug(undefined)).toBeNull();
  });
});

describe("issue webhook signature", () => {
  test("is sha256= and the HMAC-SHA256 hex of the raw body", async () => {
    // RFC 4231-style known answer: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog").
    expect(await signIssueWebhook("The quick brown fox jumps over the lazy dog", "key")).toBe("sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  test("a request signs exactly the body it sends, with the event and delivery headers", async () => {
    const payload = issueWebhookPayload(input);
    const secret = "s".repeat(32);
    const request = await issueWebhookRequest(payload, secret);
    expect(request.body).toBe(JSON.stringify(payload));
    expect(request.headers).toEqual({ "Content-Type": "application/json", "X-Origin-Event": "issue.created", "X-Origin-Delivery": "evt_1", "X-Origin-Signature": await signIssueWebhook(request.body, secret) });
    expect(request.headers["X-Origin-Signature"]).not.toBe(await signIssueWebhook(`${request.body} `, secret));
  });

  test("the test script's sample matches the payload shape", () => {
    const created = sampleIssueWebhookPayload("issue.created", "http://localhost:3000");
    expect(Object.keys(created)).toEqual(["id", "type", "occurredAt", "workspace", "project", "issue", "changes"]);
    expect(Object.keys(created.issue)).toEqual(["id", "key", "title", "description", "labels", "url", "status", "completed", "assignee", "acceptanceCriteria"]);
    expect(created).toMatchObject({ type: "issue.created", changes: null, issue: { url: "http://localhost:3000/sample/issue/ORI-AB12", labels: ["Needs spec"] } });
    expect(sampleIssueWebhookPayload("issue.updated").changes).toEqual({ status: { from: "Draft", to: "Todo" } });
  });

  test("webhook URLs are http(s) without credentials", () => {
    expect(issueWebhookUrlError("https://hooks.example/origin")).toBeNull();
    expect(issueWebhookUrlError("ftp://hooks.example")).toContain("http");
    expect(issueWebhookUrlError("https://user:pw@hooks.example")).toContain("credentials");
    expect(issueWebhookUrlError("nope")).toContain("URL");
  });
});
