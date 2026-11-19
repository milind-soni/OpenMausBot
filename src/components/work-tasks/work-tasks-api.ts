import { api } from "@/state/api";
import type {
  AgentTask,
  AgentTaskEvidenceType,
  AgentTaskPriority,
  AgentTaskStatus,
  AgentTaskType,
  RoomJiraPublicConfig,
  RoomWorkTaskOverview,
  TaskActivity,
} from "../../../shared/work-tasks";

export interface WorkTaskListResponse {
  tasks: AgentTask[];
  overview?: RoomWorkTaskOverview;
}

export interface WorkTaskDetailResponse {
  task: AgentTask;
  subtasks: AgentTask[];
  activities: TaskActivity[];
}

export async function fetchRoomWorkTasks(roomId: string): Promise<WorkTaskListResponse> {
  return api<WorkTaskListResponse>(`/api/work-tasks?roomId=${encodeURIComponent(roomId)}`);
}

export async function fetchWorkTaskDetail(idOrKey: string): Promise<WorkTaskDetailResponse> {
  return api<WorkTaskDetailResponse>(`/api/work-tasks/${encodeURIComponent(idOrKey)}`);
}

export async function createWorkTask(input: {
  roomId: string;
  title: string;
  description?: string;
  type?: AgentTaskType;
  priority?: AgentTaskPriority;
  status?: AgentTaskStatus;
  parentTaskId?: string;
  assigneeBotId?: string;
  qaBotId?: string;
  acceptanceCriteria?: string[];
  labels?: string[];
  dueAt?: number;
  dependencies?: string[];
}): Promise<{ task: AgentTask; activities: TaskActivity[] }> {
  return api(`/api/work-tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateWorkTask(
  idOrKey: string,
  patch: {
    title?: string;
    description?: string;
    type?: AgentTaskType;
    priority?: AgentTaskPriority;
    status?: AgentTaskStatus;
    statusNote?: string;
    parentTaskId?: string | null;
    assigneeBotId?: string | null;
    qaBotId?: string | null;
    acceptanceCriteria?: string[];
    labels?: string[];
    dueAt?: number | null;
    dependencies?: string[];
    blockedBy?: string[];
    needsUserAction?: boolean;
    needsUserReason?: string | null;
  },
): Promise<{ task: AgentTask }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function addWorkTaskComment(
  idOrKey: string,
  message: string,
): Promise<{ task: AgentTask; activities: TaskActivity[] }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/comments`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function addWorkTaskEvidence(
  idOrKey: string,
  input: { type: AgentTaskEvidenceType; label: string; value: string },
): Promise<{ task: AgentTask; activities: TaskActivity[] }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/evidence`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteWorkTask(idOrKey: string): Promise<{ ok: boolean }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}`, {
    method: "DELETE",
  });
}

export async function fetchRoomJiraConfig(roomId: string): Promise<{ config: RoomJiraPublicConfig }> {
  return api(`/api/work-tasks/rooms/${encodeURIComponent(roomId)}/jira`);
}

export async function saveRoomJiraConfig(
  roomId: string,
  input: Partial<RoomJiraPublicConfig> & { apiToken?: string | null },
): Promise<{ config: RoomJiraPublicConfig }> {
  return api(`/api/work-tasks/rooms/${encodeURIComponent(roomId)}/jira`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function createJiraForTask(idOrKey: string): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/jira/create`, { method: "POST", body: "{}" });
}

export async function linkJiraToTask(
  idOrKey: string,
  issueKey: string,
): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/jira/link`, {
    method: "POST",
    body: JSON.stringify({ issueKey }),
  });
}

export async function syncJiraForTask(idOrKey: string): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/jira/sync`, { method: "POST", body: "{}" });
}

