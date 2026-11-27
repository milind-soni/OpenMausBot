import type { BotTask, BotTaskActivity, BotTaskGithubRef } from "../../shared/bot-tasks.ts";
import { GithubError, type GithubClient, type GithubEvent } from "./github.ts";

type ActivityOf<T> = T extends { type: `github_${string}` }
  ? Omit<T, "id" | "key" | "by"> & { key: string; by: { kind: "github"; login: string } }
  : never;

export type GithubTaskActivity = ActivityOf<BotTaskActivity>;

export interface GithubTaskSync {
  ref: BotTaskGithubRef & { kind: "pull" | "issue" };
  githubState: NonNullable<BotTask["githubState"]>;
  activity: GithubTaskActivity[];
}

function toActivity(event: GithubEvent): GithubTaskActivity {
  const base = { key: event.key, at: event.at, by: { kind: "github" as const, login: event.login }, url: event.url };
  switch (event.type) {
    case "comment":
      return { ...base, type: "github_comment", text: event.text };
    case "review":
      return { ...base, type: "github_review", state: event.state, text: event.text };
    case "check":
      return { ...base, type: "github_check", name: event.name, conclusion: event.conclusion };
    case "state":
      return { ...base, type: "github_state", state: event.state };
  }
}

export async function syncGithubTask({
  task, client, now, since,
}: {
  task: BotTask;
  client: Pick<GithubClient, "pull" | "events">;
  now: number;
  since: number;
}): Promise<GithubTaskSync> {
  if (!task.github) throw new GithubError("Bot task has no GitHub reference");
  const item = await client.pull(task.github.repo, task.github.number);
  const ref = { ...task.github, kind: item.kind };
  const events = await client.events(ref, since, item);
  const githubState = { state: item.state, syncedAt: now };
  const seen = new Set(task.activity.map(({ key }) => key));
  const legacyKeys = new Set(task.activity.map(({ key, at }) => `${key}:${at}`));
  const legacyStates = new Set(task.activity.flatMap((entry) =>
    entry.type === "github_state" && entry.url?.toLowerCase() === item.htmlUrl.toLowerCase() ? [entry.key] : []));
  const activity: GithubTaskActivity[] = [];
  function add(event: GithubEvent) {
    const key = event.type === "state" ? `${ref.repo.toLowerCase()}#${ref.number}:${event.key}` : event.key;
    if (seen.has(key) || (event.legacyKey && legacyKeys.has(`${event.legacyKey}:${event.at}`)) ||
      (event.type === "state" && legacyStates.has(event.key))) return;
    seen.add(key);
    activity.push(toActivity({ ...event, key }));
  }

  for (const event of events) {
    if (event.at < since || (event.type === "comment" && event.ownMarker)) continue;
    add(event);
  }
  const previous = task.githubState;
  if (previous && previous.state !== item.state) {
    const state = item.state === "open" ? "reopened" : item.state;
    const matching = events.some((event) => event.type === "state" && event.state === state && event.at >= previous.syncedAt);
    const closedAt = item.closedAt && Number.isFinite(Date.parse(item.closedAt)) ? item.closedAt : undefined;
    const key = state === "merged" ? "state:merged"
      : `state:${state}:${state === "closed" ? closedAt ?? new Date(now).toISOString() : now}`;
    if (!matching) add({
      type: "state", state, key, at: state === "closed" && closedAt ? Date.parse(closedAt) : now,
      login: "github", url: item.htmlUrl,
    });
  }
  return { ref, githubState, activity: activity.sort((a, b) => a.at - b.at) };
}
