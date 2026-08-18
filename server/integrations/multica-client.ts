// Multica REST client — the one place that speaks to a Multica server.
// Every response shape is parsed here, so an API change is one file to fix,
// tested against recorded responses rather than a live workspace.
//
// Credentials are never stored by OpenMausBot. They are read from the config
// the `multica` CLI already wrote, following its own layout (see the CLI's
// ConfigPath): no profile → ~/.multica/config.json, a named profile →
// ~/.multica/profiles/<name>/config.json. That file also carries the
// workspace id, so a signed-in CLI is the entire setup. MULTICA_SERVER_URL +
// MULTICA_TOKEN override it, for a server the CLI has never seen.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MulticaSettings {
  /** Profile under ~/.multica/profiles/. Empty means the default config. */
  profile?: string;
  /** Workspace UUID. Falls back to the one in the CLI config. */
  workspaceId?: string;
  enabled?: boolean;
}

export interface MulticaProfile {
  baseUrl: string;
  token: string;
  /** From the CLI config, so a bot needs no second place to state it. */
  workspaceId?: string;
}

/** Where the multica CLI keeps the config for a profile. */
export function multicaConfigPath(profile?: string, home = homedir()): string {
  return profile
    ? join(home, ".multica", "profiles", profile, "config.json")
    : join(home, ".multica", "config.json");
}

export function resolveMulticaProfile(profile?: string, home = homedir()): MulticaProfile | null {
  const envUrl = process.env.MULTICA_SERVER_URL;
  const envToken = process.env.MULTICA_TOKEN;
  if (envUrl && envToken) {
    return {
      baseUrl: envUrl.replace(/\/$/, ""),
      token: envToken,
      workspaceId: process.env.MULTICA_WORKSPACE_ID || undefined,
    };
  }
  try {
    const raw = readFileSync(multicaConfigPath(profile, home), "utf8");
    const cfg = JSON.parse(raw) as { server_url?: string; token?: string; workspace_id?: string };
    if (!cfg.server_url || !cfg.token) return null;
    return {
      baseUrl: cfg.server_url.replace(/\/$/, ""),
      token: cfg.token,
      workspaceId: cfg.workspace_id || undefined,
    };
  } catch {
    return null;
  }
}

// ── wire shapes (subset of the API, verified live 15.08.2026) ────────────
export interface MulticaAgent {
  id: string;
  name: string;
  status?: string;
}

export interface MulticaIssue {
  id: string;
  identifier?: string;
  title: string;
  description?: string | null;
  status?: string;
  assignee_type?: string | null;
  assignee_id?: string | null;
  parent_issue_id?: string | null;
  stage?: number | null;
  priority?: string;
}

export interface MulticaTaskRun {
  id: string;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  result?: unknown;
  error?: string | null;
  attempt?: number;
  max_attempts?: number;
}

export interface MulticaComment {
  id: string;
  content: string;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeType?: "member" | "agent" | "squad";
  assigneeId?: string;
  parentIssueId?: string;
  stage?: number;
}

// Request bodies, in the API's own snake_case. Named rather than assembled
// as open dictionaries so a typo is a compile error instead of a field the
// server quietly ignores.
interface CreateIssueBody {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee_type?: "member" | "agent" | "squad";
  assignee_id?: string;
  parent_issue_id?: string;
  stage?: number;
}

interface UpdateIssueBody {
  status?: string;
  assignee_type?: "member" | "agent" | "squad";
  assignee_id?: string;
}

interface CommentBody {
  content: string;
}

type RequestBody = CreateIssueBody | UpdateIssueBody | CommentBody;

export class MulticaError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "MulticaError";
    this.status = status;
    this.body = body;
  }
}

export class MulticaClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly workspaceId: string;

  constructor(baseUrl: string, token: string, workspaceId: string) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.workspaceId = workspaceId;
  }

  private async request<T>(method: string, path: string, body?: RequestBody): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "x-workspace-id": this.workspaceId,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      // Never a naked "fetch failed": node hides the reason in `cause`, and
      // an unnamed target is unreadable in a log a day later.
      throw new Error(
        `multica ${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (res.status >= 400) {
      const text = (await res.text().catch(() => "")).slice(0, 512);
      throw new MulticaError(`multica ${method} ${path} returned ${res.status}`, res.status, text);
    }
    // SAFETY: 204 carries no body by definition, and every caller that can
    // receive one types T as void.
    if (res.status === 204) return undefined as T;
    // SAFETY: the response is the API's documented shape for this route; T is
    // chosen at each call site below and the fields are read defensively
    // (optional, with fallbacks) rather than trusted wholesale.
    return (await res.json()) as T;
  }

  listAgents(): Promise<MulticaAgent[]> {
    return this.request<MulticaAgent[]>("GET", `/api/agents?workspace_id=${encodeURIComponent(this.workspaceId)}`);
  }

  listIssues(limit = 20): Promise<MulticaIssue[]> {
    return this.request<{ issues?: MulticaIssue[] }>(
      "GET",
      `/api/issues?workspace_id=${encodeURIComponent(this.workspaceId)}&limit=${limit}`,
    ).then((r) => r.issues ?? []);
  }

  getIssue(id: string): Promise<MulticaIssue> {
    return this.request<MulticaIssue>("GET", `/api/issues/${encodeURIComponent(id)}`);
  }

  createIssue(input: CreateIssueInput): Promise<MulticaIssue> {
    const body: CreateIssueBody = { title: input.title };
    if (input.description) body.description = input.description;
    if (input.status) body.status = input.status;
    if (input.priority) body.priority = input.priority;
    // Both halves or neither: an assignee type without an id is rejected by
    // the API, and sending one alone turns a typo into a 400 at runtime.
    if (input.assigneeType && input.assigneeId) {
      body.assignee_type = input.assigneeType;
      body.assignee_id = input.assigneeId;
    }
    if (input.parentIssueId) body.parent_issue_id = input.parentIssueId;
    if (input.stage !== undefined) body.stage = input.stage;
    return this.request<MulticaIssue>("POST", `/api/issues?workspace_id=${encodeURIComponent(this.workspaceId)}`, body);
  }

  assignIssue(id: string, assigneeType: "member" | "agent" | "squad", assigneeId: string): Promise<MulticaIssue> {
    return this.request<MulticaIssue>("PUT", `/api/issues/${encodeURIComponent(id)}`, {
      assignee_type: assigneeType,
      assignee_id: assigneeId,
    });
  }

  setStatus(id: string, status: string): Promise<MulticaIssue> {
    return this.request<MulticaIssue>("PUT", `/api/issues/${encodeURIComponent(id)}`, { status });
  }

  comment(id: string, content: string): Promise<MulticaComment> {
    return this.request<MulticaComment>("POST", `/api/issues/${encodeURIComponent(id)}/comments`, { content });
  }

  taskRuns(id: string): Promise<MulticaTaskRun[]> {
    return this.request<MulticaTaskRun[]>("GET", `/api/issues/${encodeURIComponent(id)}/task-runs`);
  }

  taskMessages(runId: string): Promise<unknown[]> {
    return this.request<unknown[]>("GET", `/api/tasks/${encodeURIComponent(runId)}/messages`);
  }

  cancelTask(runId: string): Promise<void> {
    return this.request<void>("POST", `/api/tasks/${encodeURIComponent(runId)}/cancel`);
  }
}
