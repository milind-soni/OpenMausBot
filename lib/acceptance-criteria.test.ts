import { describe, expect, test } from "vitest";
import { addCriteria, editCriteria, isSpecified, MAX_CRITERIA, needsSpecLabels, replaceCriteria } from "./acceptance-criteria";

const list = [{ text: "Imports a CSV", checked: false }, { text: "Shows errors per row", checked: true }, { text: "Undo", checked: false }];

describe("acceptance criteria edits", () => {
  test("adds trimmed, unchecked items and enforces the limits", () => {
    expect(addCriteria([], ["  Works\non  mobile "])).toEqual([{ text: "Works on mobile", checked: false }]);
    expect(() => addCriteria([], [])).toThrow("at least one");
    expect(() => addCriteria([], [" "])).toThrow("1 to 500");
    expect(() => addCriteria([], ["x".repeat(501)])).toThrow("1 to 500");
    expect(() => addCriteria(Array.from({ length: MAX_CRITERIA }, () => ({ text: "a", checked: false })), ["b"])).toThrow("up to 50");
  });

  test("checks, edits and removes by index or text, all against the current list", () => {
    expect(editCriteria(list, [{ index: 0, checked: true }, { match: "UNDO ", text: "Undo the import" }, { index: 1, remove: true }])).toEqual([
      { text: "Imports a CSV", checked: true }, { text: "Undo the import", checked: false },
    ]);
    expect(editCriteria(list, [{ index: 2, match: "undo", remove: true }])).toHaveLength(2);
  });

  test("refuses stale, ambiguous, duplicate or empty edits", () => {
    expect(() => editCriteria(list, [{ index: 0, match: "Undo", checked: true }])).toThrow("changed");
    expect(() => editCriteria(list, [{ index: 3, checked: true }])).toThrow("No acceptance criterion at index 3");
    expect(() => editCriteria(list, [{ match: "missing", checked: true }])).toThrow("No acceptance criterion reads");
    expect(() => editCriteria([...list, { text: "undo", checked: true }], [{ match: "Undo", checked: true }])).toThrow("more than one");
    expect(() => editCriteria(list, [{ index: 0, checked: true }, { match: "Imports a CSV", remove: true }])).toThrow("changed twice");
    expect(() => editCriteria(list, [{ index: 0 }])).toThrow("text, checked or remove");
    expect(() => editCriteria(list, [{ checked: true }])).toThrow("index or by its current text");
    expect(() => editCriteria(list, [])).toThrow("at least one");
  });

  test("replace sets the whole list; [] clears it", () => {
    expect(replaceCriteria([{ text: "One", checked: true }, { text: "Two" }])).toEqual([{ text: "One", checked: true }, { text: "Two", checked: false }]);
    expect(replaceCriteria([])).toEqual([]);
  });
});

describe("Needs spec rule", () => {
  test("a new bare note in Draft gets the label; anything else at creation does not", () => {
    expect(needsSpecLabels({ labels: ["Bug"] }, { inDraft: true })).toEqual(["Bug", "Needs spec"]);
    expect(needsSpecLabels({}, { inDraft: false })).toBeNull();
    expect(needsSpecLabels({ description: "Why" }, { inDraft: true })).toBeNull();
    expect(needsSpecLabels({ acceptanceCriteria: [{ text: "a", checked: false }] }, { inDraft: true })).toBeNull();
    expect(needsSpecLabels({ labels: ["needs SPEC"] }, { inDraft: true })).toBeNull();
    expect(needsSpecLabels({ labels: Array.from({ length: 20 }, (_, n) => `l${n}`) }, { inDraft: true })).toBeNull();
  });

  test("it comes off only once there is both a description and a criterion, keeping other labels", () => {
    const criteria = [{ text: "a", checked: false }];
    expect(isSpecified({ description: " ", acceptanceCriteria: criteria })).toBe(false);
    expect(needsSpecLabels({ description: "Why", labels: ["Needs spec", "Bug"] })).toBeNull();
    expect(needsSpecLabels({ acceptanceCriteria: criteria, labels: ["Needs spec", "Bug"] })).toBeNull();
    expect(needsSpecLabels({ description: "Why", acceptanceCriteria: criteria, labels: ["Bug", "needs spec", "UI"] })).toEqual(["Bug", "UI"]);
    expect(needsSpecLabels({ description: "Why", acceptanceCriteria: criteria, labels: ["Bug"] })).toBeNull();
    // Never added back later: only creation applies it.
    expect(needsSpecLabels({ labels: ["Bug"] })).toBeNull();
  });
});
