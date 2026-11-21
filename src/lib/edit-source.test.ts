import { describe, expect, it } from "vitest";

import { editStem, findEditSource } from "./edit-source";

const STORE = "/data/attachments";
const id = (n: number, ext = "md") => `${STORE}/${n}f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.${ext}`;
const attached = (path: string, name: string) => `<attached-file path="${path}" name="${name}" />`;
const file = (path: string, name: string) => ({ path, name, private: true });

const person = (text: string, parentId: string | null = null) => ({ id: "u1", role: "user", text, parentId });
const reply = (parentId = "u1") => ({ id: "b1", role: "bot", text: "", parentId });

describe("findEditSource: when What changed is offered", () => {
  it("pairs a returned file with the person's file of the same name, edit words set aside", () => {
    const messages = [person(`Improve the dialogue\n\n${attached(id(1), "Chapter 3.md")}\n${attached(id(2), "Notes.md")}`), reply()];
    for (const name of ["Chapter 3 (edited).md", "chapter_3_revised.md", "Chapter-3-v2.md", "Chapter 3.md"]) {
      expect(findEditSource(messages, "b1", [file(id(5), name)]).get(id(5))).toEqual({ messageId: "u1", path: id(1), name: "Chapter 3.md" });
    }
  });

  it("does not pair files of other names, which may be different documents", () => {
    const messages = [person(`Tighten this\n\n${attached(id(1), "draft.txt")}`), reply()];
    expect(findEditSource(messages, "b1", [file(id(5), "polished.md")]).size).toBe(0);
  });

  it("offers nothing when it is unsure: two candidates, two returned files with other names, other kinds of file", () => {
    const two = [person(`${attached(id(1), "a.md")}\n${attached(id(2), "b.md")}`), reply()];
    expect(findEditSource(two, "b1", [file(id(5), "c.md")]).size).toBe(0);
    const one = [person(attached(id(1), "draft.md")), reply()];
    expect(findEditSource(one, "b1", [file(id(5), "x.md"), file(id(6), "y.md")]).size).toBe(0);
    expect(findEditSource(one, "b1", [file(id(5, "docx"), "draft.docx")]).size).toBe(0);
    const word = [person(attached(id(1, "docx"), "draft.docx")), reply()];
    expect(findEditSource(word, "b1", [file(id(5), "draft.md")]).size).toBe(0);
    expect(findEditSource(one, "b1", [{ path: "/home/me/draft.md", name: "draft.md" }]).size).toBe(0);
  });

  it("never offers it on the person's own message, nor compares a file with itself", () => {
    const messages = [person(`${attached(id(1), "chapter.md")}\n${attached(id(2), "chapter-edited.md")}`)];
    expect(findEditSource(messages, "u1", [file(id(2), "chapter-edited.md")]).size).toBe(0);
    const echoed = [person(attached(id(1), "chapter.md")), reply()];
    expect(findEditSource(echoed, "b1", [file(id(1), "chapter.md")]).size).toBe(0);
  });

  it("goes back to the nearest message of the person's that attached text, and needs it loaded", () => {
    const messages = [
      { id: "u0", role: "user", text: attached(id(1), "chapter.md"), parentId: null },
      { id: "b0", role: "bot", text: "Read it.", parentId: "u0" },
      { id: "u1", role: "user", text: "Now improve the dialogue", parentId: "b0" },
      reply(),
    ];
    expect(findEditSource(messages, "b1", [file(id(5), "chapter-edited.md")]).get(id(5))?.messageId).toBe("u0");
    expect(findEditSource(messages.slice(2), "b1", [file(id(5), "chapter-edited.md")]).size).toBe(0);
  });

  it("follows the branch the reply is on, not messages on another branch", () => {
    const messages = [
      { id: "u0", role: "user", text: attached(id(1), "chapter.md"), parentId: null },
      { id: "u9", role: "user", text: attached(id(9), "chapter.md"), parentId: null },
      { id: "b1", role: "bot", text: "", parentId: "u0" },
    ];
    expect(findEditSource(messages, "b1", [file(id(5), "chapter-edited.md")]).get(id(5))?.path).toBe(id(1));
  });

  it("does not mistake another chapter for an edit", () => {
    expect(editStem("Chapter 3.md")).not.toBe(editStem("Chapter 4.md"));
    expect(editStem("credit.md")).toBe("credit");
    expect(editStem("Chapter 3 (1).md")).toBe("chapter 3");
  });
});
