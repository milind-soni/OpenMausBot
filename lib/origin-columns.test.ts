import { describe, expect, test } from "vitest";
import { DEFAULT_WORKFLOW_COLUMNS, columnLabel, isDraftColumn, presentColumns } from "./origin-columns";

describe("Backlog presentation of the draft column", () => {
  test("new boards start with Backlog", () => {
    expect(DEFAULT_WORKFLOW_COLUMNS[0]).toBe("Backlog");
  });
  test("a draft column still called Draft shows as Backlog; renamed drafts and other columns keep their names", () => {
    expect(columnLabel({ title: "Draft", isDraft: true })).toBe("Backlog");
    expect(columnLabel({ title: " draft ", isDraft: undefined })).toBe("Backlog");
    expect(columnLabel({ title: "Ideas", isDraft: true })).toBe("Ideas");
    expect(columnLabel({ title: "Draft", isDraft: false })).toBe("Draft");
    expect(columnLabel({ title: "Todo" })).toBe("Todo");
  });
  test("the isDraft flag is the source of truth; an unflagged Backlog someone made is an ordinary column", () => {
    expect(isDraftColumn({ title: "Backlog", isDraft: true })).toBe(true);
    expect(isDraftColumn({ title: "Backlog", isDraft: false })).toBe(false);
    expect(isDraftColumn({ title: "Backlog" })).toBe(false);
    expect(isDraftColumn({ title: "Draft" })).toBe(true);
  });
  test("presented columns keep their draft flag after the rename and keep identity when unchanged", () => {
    const legacy = { _id: "a", title: "Draft" }, todo = { _id: "b", title: "Todo", isDraft: false };
    const [draft, same] = presentColumns([legacy, todo]);
    expect(draft).toMatchObject({ _id: "a", title: "Backlog", isDraft: true });
    expect(isDraftColumn(draft!)).toBe(true);
    expect(same).toBe(todo);
  });
});
