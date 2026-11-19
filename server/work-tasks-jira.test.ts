import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkTaskStore } from "./work-tasks.ts";
import { JiraSyncService } from "./work-tasks-jira.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "looma-jira-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("JiraSyncService bidirectional sync, logical assignee & resilience", () => {
  it("pushes issue with logical agent custom field, labels, attributed comments, and prevents echo/stale loops", async () => {
    const dir = tempDir();
    let clock = 1_700_000_000_000;
    const store = new WorkTaskStore({ file: join(dir, "work-tasks.json"), now: () => (clock += 1000) });

    store.saveRoomJiraConfig("room-1", {
      enabled: true,
      baseUrl: "https://acme.atlassian.net",
      email: "bot@acme.com",
      apiToken: "secret-jira-token",
      projectKey: "PROJ",
      issueType: "Task",
      assigneeCustomFieldId: "customfield_10042",
      autoSync: true,
    });

    const { task } = store.create(
      {
        roomId: "room-1",
        title: "Build Auth Service",
        assigneeBotId: "backend",
        assigneeName: "Backend-Agent",
        assigneeRole: "Backend Engineer",
        coordinatorBotId: "coord",
      },
      { actorType: "agent", actorId: "coord", actorName: "Coordinator", isCoordinator: true },
    );

    const calls: Array<{ url: string; method: string; body: any }> = [];
    let failMode = false;
    const mockFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });

      if (failMode) {
        return new Response(JSON.stringify({ errorMessages: ["Jira temporary 503"] }), { status: 503 });
      }
      if (url.endsWith("/rest/api/3/issue") && method === "POST") {
        return new Response(JSON.stringify({ id: "10001", key: "PROJ-42" }), { status: 201 });
      }
      if (url.includes("/transitions") && method === "GET") {
        return new Response(
          JSON.stringify({ transitions: [{ id: "31", name: "In Progress", to: { name: "In Progress" } }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const jira = new JiraSyncService({ store, fetchImpl: mockFetch, now: () => (clock += 1000) });

    const created = await jira.createIssueForTask(task.id);
    expect(created.ok).toBe(true);
    expect(created.task?.jiraSync?.issueKey).toBe("PROJ-42");

    // Verify logical agent custom field and labels were sent (never Jira Assignee)
    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/rest/api/3/issue"));
    expect(createCall?.body.fields.customfield_10042).toBe("Backend-Agent (Backend Engineer)");
    expect(createCall?.body.fields.labels).toContain("looma-agent:Backend-Agent");
    expect(createCall?.body.fields.assignee).toBeUndefined();

    // Sync a comment with attributed logical agent
    store.transition(task.id, "in-progress", {
      actorType: "agent",
      actorId: "backend",
      actorName: "Backend-Agent",
      actorRole: "Backend Engineer",
    });
    const synced = await jira.syncTaskToJira(task.id, "Auth tests passed", {
      name: "Backend-Agent",
      role: "Backend Engineer",
      type: "agent",
    });
    expect(synced.ok).toBe(true);
    const commentCall = calls.find((c) => c.url.includes("/comment"));
    expect(JSON.stringify(commentCall?.body)).toContain("[Backend-Agent (Backend Engineer) via LOOMA]: Auth tests passed");

    // Jira echo webhook with LOOMA-authored comment must be ignored
    const echo = jira.handleWebhook({
      issue: {
        key: "PROJ-42",
        fields: {
          updated: new Date(clock + 1000).toISOString(),
          status: { name: "In Progress" },
        },
      },
      comment: {
        body: "[Backend-Agent (Backend Engineer) via LOOMA]: Auth tests passed",
      },
    });
    expect(echo.handled).toBe(false);

    // Stale Jira webhook older than local LOOMA task update must NOT overwrite local state
    const stale = jira.handleWebhook({
      issue: {
        key: "PROJ-42",
        fields: {
          updated: new Date(clock - 500_000).toISOString(),
          status: { name: "Backlog" },
        },
      },
    });
    expect(stale.handled).toBe(false);
    expect(store.get(task.id)?.status).toBe("in-progress");

    // Fault tolerance: if Jira goes down, LOOMA local mutation persists & retry succeeds later
    failMode = true;
    store.transition(task.id, "in-review", {
      actorType: "agent",
      actorId: "backend",
      actorName: "Backend-Agent",
    });
    const failedSync = await jira.syncTaskToJira(task.id);
    expect(failedSync.ok).toBe(false);
    expect(store.get(task.id)?.status).toBe("in-review"); // local status preserved!
    expect(store.get(task.id)?.jiraSync?.lastError).toContain("503");

    failMode = false;
    const retried = await jira.syncTaskToJira(task.id);
    expect(retried.ok).toBe(true);
    expect(store.get(task.id)?.jiraSync?.lastError).toBeUndefined();
  });
});
