import { createHash } from "node:crypto";

import type { AgentTask, AgentTaskStatus } from "../shared/work-tasks.ts";
import type { RoomJiraStoredConfig, WorkTaskActor, WorkTaskStore } from "./work-tasks.ts";

export interface JiraSyncServiceOptions {
  store: WorkTaskStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_STATUS_TO_JIRA: Record<AgentTaskStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  "in-progress": "In Progress",
  blocked: "Blocked",
  "in-review": "In Review",
  rework: "Rework",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const JIRA_TO_LOOMA_PRIORITY: Record<string, AgentTask["priority"]> = {
  lowest: "lowest",
  low: "low",
  medium: "medium",
  high: "high",
  highest: "highest",
};

const PRIORITY_TO_JIRA: Record<AgentTask["priority"], string> = {
  lowest: "Lowest",
  low: "Low",
  medium: "Medium",
  high: "High",
  highest: "Highest",
};

const sanitizeLabel = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._:-]/g, "")
    .slice(0, 60);

function adfDocument(text: string): unknown {
  const lines = text.split(/\r?\n/).filter((l, i, arr) => l.length > 0 || (arr.length === 1 && i === 0));
  return {
    type: "doc",
    version: 1,
    content: (lines.length ? lines : [""]).map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

function adfToPlainText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const rec = node as { text?: unknown; content?: unknown };
  if (typeof rec.text === "string") return rec.text;
  if (Array.isArray(rec.content)) {
    return rec.content.map(adfToPlainText).filter(Boolean).join("\n");
  }
  return "";
}

export function taskSyncFingerprint(task: Pick<AgentTask, "title" | "status" | "priority" | "assigneeName" | "assigneeRole">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: task.title,
        status: task.status,
        priority: task.priority,
        assigneeName: task.assigneeName ?? "",
        assigneeRole: task.assigneeRole ?? "",
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function logicalAgentLabels(task: Pick<AgentTask, "key" | "assigneeName" | "assigneeRole" | "labels">): string[] {
  const base = (task.labels ?? []).map(sanitizeLabel).filter(Boolean);
  const out = new Set<string>(base);
  out.add(`looma-key:${sanitizeLabel(task.key)}`);
  if (task.assigneeName) out.add(`looma-agent:${sanitizeLabel(task.assigneeName)}`);
  if (task.assigneeRole) out.add(`looma-role:${sanitizeLabel(task.assigneeRole)}`);
  return [...out];
}

export function formatJiraAttributedComment(
  message: string,
  actor: { name?: string; role?: string; type?: string },
): string {
  const who = actor.name?.trim() || (actor.type === "user" ? "User" : "LOOMA");
  const roleTag = actor.role?.trim() ? ` (${actor.role.trim()})` : "";
  return `[${who}${roleTag} via LOOMA]: ${message}`;
}

export class JiraSyncService {
  private readonly store: WorkTaskStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly inflight = new Set<string>();

  constructor(options: JiraSyncServiceOptions) {
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private authHeaders(email: string, apiToken: string): Record<string, string> {
    const basic = Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private requireCreds(roomId: string): { config: RoomJiraStoredConfig; apiToken: string } | { error: string } {
    const { config, apiToken } = this.store.getRoomJiraSecrets(roomId);
    if (!config || !config.enabled) return { error: "Jira integration is disabled for this room." };
    if (!config.baseUrl || !config.email || !apiToken || !config.projectKey) {
      return { error: "Jira configuration is incomplete (baseUrl, email, apiToken, and projectKey are required)." };
    }
    return { config, apiToken };
  }

  private targetJiraStatusName(config: RoomJiraStoredConfig, status: AgentTaskStatus): string {
    return config.statusMap[status]?.trim() || DEFAULT_STATUS_TO_JIRA[status];
  }

  private mapJiraStatusToLooma(config: RoomJiraStoredConfig, jiraStatusName: string): AgentTaskStatus | undefined {
    const target = jiraStatusName.trim().toLowerCase();
    for (const [loomaStatus, mappedName] of Object.entries(config.statusMap)) {
      if (mappedName && mappedName.trim().toLowerCase() === target) {
        return loomaStatus as AgentTaskStatus;
      }
    }
    for (const [loomaStatus, defaultName] of Object.entries(DEFAULT_STATUS_TO_JIRA)) {
      if (defaultName.toLowerCase() === target) {
        return loomaStatus as AgentTaskStatus;
      }
    }
    if (target.includes("progress")) return "in-progress";
    if (target.includes("review") || target.includes("qa")) return "in-review";
    if (target.includes("block")) return "blocked";
    if (target.includes("rework")) return "rework";
    if (target.includes("done") || target.includes("closed") || target.includes("resolved")) return "done";
    if (target.includes("todo") || target === "open") return "todo";
    if (target.includes("backlog")) return "backlog";
    return undefined;
  }

  private async requestJson(
    config: RoomJiraStoredConfig,
    apiToken: string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ ok: boolean; status: number; body: any; errorText?: string }> {
    const url = `${config.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...this.authHeaders(config.email, apiToken),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => "");
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail =
        (body && Array.isArray(body.errorMessages) && body.errorMessages.join("; ")) ||
        (body && body.errors && JSON.stringify(body.errors)) ||
        text ||
        `HTTP ${res.status}`;
      return { ok: false, status: res.status, body, errorText: `Jira HTTP ${res.status}: ${detail}` };
    }
    return { ok: true, status: res.status, body };
  }

  private recordFailure(task: AgentTask, message: string): AgentTask {
    const updated = this.store.setJiraSyncState(
      task.id,
      {
        lastError: message,
      },
      undefined,
      `Jira sync error: ${message}`,
    );
    this.store.saveRoomJiraConfig(task.roomId, { lastError: message });
    return updated ?? task;
  }

  async createIssueForTask(taskIdOrKey: string): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
    const task = this.store.get(taskIdOrKey);
    if (!task) return { ok: false, error: `Task "${taskIdOrKey}" not found.` };
    const creds = this.requireCreds(task.roomId);
    if ("error" in creds) {
      this.recordFailure(task, creds.error);
      return { ok: false, task: this.store.get(task.id), error: creds.error };
    }
    const { config, apiToken } = creds;
    try {
      const fields: Record<string, unknown> = {
        project: { key: config.projectKey },
        summary: `[${task.key}] ${task.title}`,
        description: adfDocument(
          [
            task.description || task.title,
            "",
            `LOOMA Key: ${task.key}`,
            `Logical Assignee: ${task.assigneeName ?? "Unassigned"}${task.assigneeRole ? ` (${task.assigneeRole})` : ""}`,
          ].join("\n"),
        ),
        issuetype: { name: task.type === "bug" ? "Bug" : task.type === "epic" ? "Epic" : config.issueType || "Task" },
        labels: logicalAgentLabels(task),
        priority: { name: PRIORITY_TO_JIRA[task.priority] },
      };
      if (config.assigneeCustomFieldId && (task.assigneeName || task.assigneeBotId)) {
        fields[config.assigneeCustomFieldId] = `${task.assigneeName ?? task.assigneeBotId}${task.assigneeRole ? ` (${task.assigneeRole})` : ""}`;
      }
      const created = await this.requestJson(config, apiToken, "/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({ fields }),
      });
      if (!created.ok) {
        const updated = this.recordFailure(task, created.errorText!);
        return { ok: false, task: updated, error: created.errorText };
      }
      const issueKey = String(created.body?.key ?? "");
      const issueId = String(created.body?.id ?? "");
      if (!issueKey) {
        const msg = "Jira did not return an issue key.";
        return { ok: false, task: this.recordFailure(task, msg), error: msg };
      }
      const now = this.now();
      const url = `${config.baseUrl}/browse/${issueKey}`;
      const linked = this.store.setJiraSyncState(
        task.id,
        {
          issueKey,
          issueId,
          projectKey: config.projectKey,
          lastSyncedAt: now,
          lastError: undefined,
          lastSyncedFingerprint: taskSyncFingerprint(task),
          lastSyncDirection: "push",
        },
        { provider: "jira", key: issueKey, url },
        `Created Jira issue ${issueKey} for ${task.key}`,
      );
      this.store.saveRoomJiraConfig(task.roomId, { lastSyncedAt: now, lastError: "" });
      // Transition Jira issue if LOOMA task is already past default initial status
      if (linked && linked.status !== "backlog" && linked.status !== "todo") {
        await this.syncTaskToJira(linked.id);
      }
      return { ok: true, task: this.store.get(task.id) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, task: this.recordFailure(task, msg), error: msg };
    }
  }

  async linkIssue(taskIdOrKey: string, issueKey: string): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
    const task = this.store.get(taskIdOrKey);
    if (!task) return { ok: false, error: `Task "${taskIdOrKey}" not found.` };
    const normalizedKey = issueKey.trim().toUpperCase();
    if (!/^[A-Z0-9_]+-\d+$/.test(normalizedKey)) {
      return { ok: false, error: "Invalid Jira issue key format (expected e.g. PROJ-123)." };
    }
    const { config } = this.store.getRoomJiraSecrets(task.roomId);
    const baseUrl = config?.baseUrl || "https://jira.atlassian.net";
    const url = `${baseUrl}/browse/${normalizedKey}`;
    const now = this.now();
    const updated = this.store.setJiraSyncState(
      task.id,
      {
        issueKey: normalizedKey,
        projectKey: normalizedKey.split("-")[0],
        lastSyncedAt: now,
        lastError: undefined,
      },
      { provider: "jira", key: normalizedKey, url },
      `Linked Jira issue ${normalizedKey} to ${task.key}`,
    );
    return { ok: true, task: updated };
  }

  async syncTaskToJira(taskIdOrKey: string, commentMessage?: string, actor?: { name?: string; role?: string; type?: string }): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
    const task = this.store.get(taskIdOrKey);
    if (!task) return { ok: false, error: `Task "${taskIdOrKey}" not found.` };
    const issueKey = task.jiraSync?.issueKey || task.externalLinks?.find((l) => l.provider === "jira")?.key;
    if (!issueKey) return { ok: false, error: "Task is not linked to a Jira issue." };
    const creds = this.requireCreds(task.roomId);
    if ("error" in creds) {
      this.recordFailure(task, creds.error);
      return { ok: false, task: this.store.get(task.id), error: creds.error };
    }
    if (this.inflight.has(task.id)) return { ok: true, task };
    this.inflight.add(task.id);
    const { config, apiToken } = creds;
    try {
      const fingerprint = taskSyncFingerprint(task);
      const shouldPushFields = task.jiraSync?.lastSyncedFingerprint !== fingerprint;
      if (shouldPushFields) {
        const fields: Record<string, unknown> = {
          summary: `[${task.key}] ${task.title}`,
          labels: logicalAgentLabels(task),
          priority: { name: PRIORITY_TO_JIRA[task.priority] },
        };
        if (config.assigneeCustomFieldId && (task.assigneeName || task.assigneeBotId)) {
          fields[config.assigneeCustomFieldId] = `${task.assigneeName ?? task.assigneeBotId}${task.assigneeRole ? ` (${task.assigneeRole})` : ""}`;
        }
        const putRes = await this.requestJson(config, apiToken, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
          method: "PUT",
          body: JSON.stringify({ fields }),
        });
        if (!putRes.ok) {
          const updated = this.recordFailure(task, putRes.errorText!);
          return { ok: false, task: updated, error: putRes.errorText };
        }

        // Transition status on Jira if matching transition exists
        const trList = await this.requestJson(
          config,
          apiToken,
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
        );
        if (trList.ok && Array.isArray(trList.body?.transitions)) {
          const wanted = this.targetJiraStatusName(config, task.status).toLowerCase();
          const match = trList.body.transitions.find(
            (t: { id?: string; name?: string; to?: { name?: string } }) =>
              t.name?.toLowerCase() === wanted || t.to?.name?.toLowerCase() === wanted,
          );
          if (match?.id) {
            await this.requestJson(
              config,
              apiToken,
              `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
              { method: "POST", body: JSON.stringify({ transition: { id: match.id } }) },
            );
          }
        }
      }

      if (commentMessage?.trim()) {
        const attributed = formatJiraAttributedComment(commentMessage.trim(), actor ?? { name: task.assigneeName, role: task.assigneeRole, type: "agent" });
        const commentRes = await this.requestJson(
          config,
          apiToken,
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
          { method: "POST", body: JSON.stringify({ body: adfDocument(attributed) }) },
        );
        if (!commentRes.ok) {
          const updated = this.recordFailure(task, commentRes.errorText!);
          return { ok: false, task: updated, error: commentRes.errorText };
        }
      }

      const now = this.now();
      const updated = this.store.setJiraSyncState(
        task.id,
        {
          issueKey,
          lastSyncedAt: now,
          lastError: undefined,
          lastSyncedFingerprint: fingerprint,
          lastSyncDirection: "push",
        },
        undefined,
        commentMessage?.trim() ? `Synced comment and status to ${issueKey}` : `Synced status (${task.status}) to ${issueKey}`,
      );
      this.store.saveRoomJiraConfig(task.roomId, { lastSyncedAt: now, lastError: "" });
      return { ok: true, task: updated };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, task: this.recordFailure(task, msg), error: msg };
    } finally {
      this.inflight.delete(task.id);
    }
  }

  /** Handles incoming Jira webhook events with loop detection & stale-timestamp protection. */
  handleWebhook(payload: unknown): { handled: boolean; ignoredReason?: string; task?: AgentTask } {
    if (!payload || typeof payload !== "object") {
      return { handled: false, ignoredReason: "Invalid webhook payload" };
    }
    const body = payload as {
      issue?: {
        key?: string;
        fields?: {
          summary?: string;
          updated?: string;
          status?: { name?: string };
          priority?: { name?: string };
        };
      };
      comment?: {
        body?: unknown;
        author?: { displayName?: string };
        updated?: string;
      };
      timestamp?: number;
    };
    const issueKey = body.issue?.key;
    if (!issueKey) return { handled: false, ignoredReason: "Missing issue.key" };

    const task = this.store.findByJiraKey(issueKey);
    if (!task) return { handled: false, ignoredReason: `No LOOMA task linked to ${issueKey}` };

    const { config } = this.store.getRoomJiraSecrets(task.roomId);
    const remoteUpdatedMs = body.issue?.fields?.updated ? Date.parse(body.issue.fields.updated) : body.timestamp ?? 0;

    // Stale data guard: never let an older Jira timestamp overwrite newer LOOMA work.
    if (remoteUpdatedMs > 0 && remoteUpdatedMs <= Math.max(task.updatedAt, task.jiraSync?.lastRemoteUpdatedAt ?? 0)) {
      return { handled: false, ignoredReason: "Stale Jira update older than current LOOMA state" };
    }

    const jiraActor: WorkTaskActor = {
      actorType: "system",
      actorName: body.comment?.author?.displayName ? `${body.comment.author.displayName} (Jira)` : "Jira",
    };

    // Echo loop guard on comments authored by LOOMA itself
    if (body.comment) {
      const text = adfToPlainText(body.comment.body).trim();
      if (text && /via LOOMA\]:/.test(text)) {
        return { handled: false, ignoredReason: "Ignored LOOMA-originated comment echo" };
      }
      if (text) {
        this.store.addActivity(task.id, { type: "comment", message: text }, jiraActor);
      }
    }

    const jiraStatus = body.issue?.fields?.status?.name;
    const mappedStatus = jiraStatus && config ? this.mapJiraStatusToLooma(config, jiraStatus) : undefined;
    const nextPriority = body.issue?.fields?.priority?.name
      ? JIRA_TO_LOOMA_PRIORITY[body.issue.fields.priority.name.toLowerCase()]
      : undefined;

    const candidateFingerprint = taskSyncFingerprint({
      title: task.title,
      status: mappedStatus ?? task.status,
      priority: nextPriority ?? task.priority,
      assigneeName: task.assigneeName,
      assigneeRole: task.assigneeRole,
    });

    // Loop prevention: if resulting state equals the state LOOMA just pushed, skip re-applying status.
    if (
      task.jiraSync?.lastSyncedFingerprint === candidateFingerprint &&
      mappedStatus === task.status &&
      (!nextPriority || nextPriority === task.priority)
    ) {
      if (remoteUpdatedMs > 0) {
        this.store.setJiraSyncState(task.id, { lastRemoteUpdatedAt: remoteUpdatedMs, lastSyncDirection: "pull" });
      }
      return { handled: Boolean(body.comment), ignoredReason: body.comment ? undefined : "No state delta (echo prevented)", task: this.store.get(task.id) };
    }

    if (nextPriority && nextPriority !== task.priority) {
      this.store.update(task.id, { priority: nextPriority }, jiraActor);
    }

    if (mappedStatus && mappedStatus !== task.status) {
      try {
        this.store.transition(task.id, mappedStatus, jiraActor, {
          message: `Synced from Jira (${issueKey}: ${jiraStatus})`,
          activityType: "jira-synced",
        });
      } catch {
        // Record error without throwing or corrupting task if Jira sent an invalid workflow jump
        this.store.addActivity(
          task.id,
          { type: "jira-synced", message: `Ignored invalid Jira transition "${task.status}" -> "${mappedStatus}" from ${issueKey}` },
          jiraActor,
        );
      }
    }

    const refreshed = this.store.get(task.id)!;
    this.store.setJiraSyncState(refreshed.id, {
      lastSyncedAt: this.now(),
      lastRemoteUpdatedAt: remoteUpdatedMs || this.now(),
      lastSyncedFingerprint: taskSyncFingerprint(refreshed),
      lastSyncDirection: "pull",
      lastError: undefined,
    });
    return { handled: true, task: this.store.get(task.id) };
  }
}

