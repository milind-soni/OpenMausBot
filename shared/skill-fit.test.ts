import { describe, expect, it } from "vitest";

import { fitWords, rankSkills } from "./skill-fit.ts";

const skill = (name: string, description: string) => ({ name, description });

describe("skills that fit a bot or a task", () => {
  it("meets a word in its other forms and leaves out the commonest", () => {
    expect(fitWords("Invoices, invoicing and the invoice")).toEqual(["invoic", "invoic", "invoic"]);
    expect(fitWords("Sales leads for a class")).toEqual(["sale", "lead", "class"]);
    expect(fitWords("Use this skill when you are in a PR")).toEqual([]);
    expect(fitWords("Revisar as faturas")).toEqual(["revisa", "fatura"]);
  });

  it("puts a skill named for the task first, and a word every skill shares counts for little", () => {
    const skills = [
      skill("file-expense", "Files an expense report in the company portal."),
      skill("invoice-reminders", "Chases unpaid invoices by email."),
      skill("pdf", "Reads and fills PDF files."),
      skill("company-wiki", "Searches the company wiki."),
    ];
    expect(rankSkills(skills, "chase the unpaid invoicing").map((one) => one.name)).toEqual(["invoice-reminders"]);
    expect(rankSkills(skills, "file my expenses with the company").map((one) => one.name)[0]).toBe("file-expense");
    expect(rankSkills(skills, "deploy a preview")).toEqual([]);
    expect(rankSkills(skills, "")).toEqual([]);
  });

  it("does not let a long description outrank a short one that names the same thing", () => {
    const long = skill("notes", `Keeps meeting notes. ${Array.from({ length: 60 }, (_, i) => `topic${i}`).join(" ")} calendar.`);
    const short = skill("calendar", "Books calendar slots.");
    expect(rankSkills([long, short], "calendar meeting").map((one) => one.name)).toEqual(["calendar", "notes"]);
  });
});
