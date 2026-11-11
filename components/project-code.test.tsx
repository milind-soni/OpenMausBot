import { expect, test } from "vitest";
import { mergePullRequests } from "./project-code";

test("Code lists each pull request once: the repository's rows, enriched by the links to issues", () => {
  const issue = { taskId: "t1" as never, key: "ORI-AB12", title: "Fix login", done: false, completesOnMerge: true };
  const rows = mergePullRequests(
    [{ url: "https://github.com/acme/app/pull/7", number: 7, title: null, state: "open", updatedAt: 50, repository: "acme/app", checks: "success", review: "approved", mergeable: true, issues: [issue] }],
    [
      { url: "https://github.com/acme/app/pull/7/", number: 7, title: "Fix login", state: "open", branch: "ori-ab12-fix-login", author: "sam", updatedAt: 40 },
      { url: "https://github.com/acme/app/pull/8", number: 8, title: "Unlinked", state: "merged", updatedAt: 90 },
    ],
  );
  expect(rows.map(row => row.number)).toEqual([8, 7]);
  expect(rows[1]).toMatchObject({ title: "Fix login", branch: "ori-ab12-fix-login", checks: "success", issues: [issue], updatedAt: 50 });
  expect(rows[0]!.issues).toEqual([]);
});
