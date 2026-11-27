import { describe, expect, it, vi } from "vitest";
import type { BotTask } from "../../shared/bot-tasks.ts";
import { createGithubClient, type GithubEvent, type GithubItem } from "./github.ts";
import { syncGithubTask } from "./sync.ts";

const since = Date.parse("2026-11-20T11:00:00Z");
const changeAt = Date.parse("2026-11-20T12:01:00Z");
const now = Date.parse("2026-11-20T12:05:00Z");
const url = "https://github.com/octo/example/pull/42";
const baseTask: BotTask = {
  id: "task-42", title: "Update", status: "review", ownerBotId: "bot", createdBy: { kind: "system" },
  createdAt: since, updatedAt: since, github: { repo: "octo/example", number: 42 }, activity: [],
};
const open: GithubItem = { kind: "pull", state: "open", htmlUrl: url, title: "Update", headSha: "abc", mergeable: true };
const comment: GithubEvent = { type: "comment", key: "comment:1", text: "Review ready", login: "dev", at: since, url };
const check: GithubEvent = {
  type: "check", key: "check:build:abc:success", name: "build", conclusion: "success", login: "ci", at: since - 1, url,
};

function fixture(item: GithubItem, events: GithubEvent[] = []) {
  return { pull: vi.fn(async () => item), events: vi.fn(async () => events) };
}

describe("syncGithubTask", () => {
  it("imports first-sync activity and historical states in chronological order, without own comments", async () => {
    const closed = { ...open, state: "closed" as const };
    const client = fixture(closed, [
      comment,
      { ...comment, key: "comment:2", ownMarker: true },
      { type: "state", state: "closed", key: "state:closed:old", at: changeAt, login: "dev", url },
      { type: "review", state: "APPROVED", key: "review:1", text: "Approved", at: changeAt, login: "dev", url },
      check,
    ]);
    const result = await syncGithubTask({ task: baseTask, client, now, since: 0 });
    expect(result.githubState).toEqual({ state: "closed", syncedAt: now });
    expect(result.ref).toEqual({ ...baseTask.github, kind: "pull" });
    expect(client.events).toHaveBeenCalledWith(result.ref, 0, closed);
    expect(result.activity).toEqual([
      { type: "github_check", key: check.key, at: check.at, by: { kind: "github", login: "ci" },
        name: "build", conclusion: "success", url },
      { type: "github_comment", key: comment.key, at: comment.at, by: { kind: "github", login: "dev" },
        text: "Review ready", url },
      { type: "github_state", key: "octo/example#42:state:closed:old", at: changeAt, by: { kind: "github", login: "dev" }, state: "closed", url },
      { type: "github_review", key: "review:1", at: changeAt, by: { kind: "github", login: "dev" },
        state: "APPROVED", text: "Approved", url },
    ]);
  });

  it("dedupes against both the saved log and the new batch", async () => {
    const first = await syncGithubTask({ task: baseTask, client: fixture(open, [comment, comment]), now, since });
    expect(first.activity).toHaveLength(1);
    const task = {
      ...baseTask, github: first.ref, githubState: first.githubState,
      activity: first.activity.map((entry) => ({ ...entry, id: entry.key })),
    };
    const second = await syncGithubTask({ task, client: fixture(open, [comment, check, check]), now: now + 1, since: 0 });
    expect(second.activity.map(({ key }) => key)).toEqual([check.key]);
  });

  it.each([
    { previous: "open", current: "closed", state: "closed", key: "state:closed:2026-11-20T12:01:00Z" },
    { previous: "closed", current: "open", state: "reopened", key: `state:reopened:${changeAt}` },
    { previous: "open", current: "merged", state: "merged", key: "state:merged" },
  ] as const)("records a later state transition from $previous to $current", async ({ previous, current, state, key }) => {
    const task: BotTask = { ...baseTask, githubState: { state: previous, syncedAt: since } };
    const item = { ...open, state: current };
    const client = fixture(item, [
      { type: "state", state, key: "old-event", at: since - 1, login: "old-user", url },
      { type: "state", state, key, at: changeAt, login: "maintainer", url },
    ]);
    const result = await syncGithubTask({ task, client, now, since });
    expect(result.githubState).toEqual({ state: current, syncedAt: now });
    expect(result.activity).toEqual([
      { type: "github_state", state, key: `octo/example#42:${key}`, at: changeAt, by: { kind: "github", login: "maintainer" }, url },
    ]);
    await expect(syncGithubTask({
      task: { ...task, githubState: result.githubState }, client, now: now + 1, since: now,
    })).resolves.toMatchObject({ activity: [] });
  });

  it("does not confuse state events from a former link with the current item", async () => {
    const task: BotTask = {
      ...baseTask,
      activity: [{
        id: "old", type: "github_state", state: "merged", key: "state:merged", at: since - 2,
        url: "https://github.com/octo/example/pull/41", by: { kind: "github", login: "dev" },
      }],
    };
    const state: GithubEvent = { type: "state", state: "merged", key: "state:merged", at: since - 1, login: "dev", url };
    const result = await syncGithubTask({ task, client: fixture({ ...open, state: "merged" }, [state]), now, since: 0 });
    expect(result.activity).toMatchObject([{ key: "octo/example#42:state:merged" }]);
  });

  it("records a changed snapshot even when the matching GitHub event is unavailable", async () => {
    const task: BotTask = { ...baseTask, githubState: { state: "closed", syncedAt: since } };
    const result = await syncGithubTask({ task, client: fixture(open), now, since });
    expect(result.activity).toEqual([
      { type: "github_state", state: "reopened", key: `octo/example#42:state:reopened:${now}`, at: now, by: { kind: "github", login: "github" }, url },
    ]);
  });

  it("passes a rate-limit error back to the caller", async () => {
    const client = createGithubClient({
      token: async () => "fixture-token", now: () => now,
      fetch: async () => new Response(null, { status: 429, headers: { "retry-after": "10" } }),
    });
    await expect(syncGithubTask({ task: baseTask, client, now, since })).rejects.toMatchObject({
      name: "GithubError", status: 429, resetAt: now + 10_000,
    });
  });
});
