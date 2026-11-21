import { describe, expect, it } from "vitest";
import { inboxAssignmentPart, inboxDisplayPath, inboxFileName, inboxFileNames, inboxSenderPart, samePath, withinPath } from "./handoff-inbox.ts";

describe("comparing inbox paths", () => {
  it("is exact where file names are, and ignores case and slash direction on Windows", () => {
    expect(samePath("/data/task-workspaces/b/t/inbox/a.pdf", "/data/task-workspaces/b/t/inbox/a.pdf", "linux")).toBe(true);
    expect(samePath("/data/Inbox/a.pdf", "/data/inbox/a.pdf", "linux")).toBe(false);
    expect(samePath("/data/Inbox/a.pdf", "/data/inbox/a.pdf", "darwin")).toBe(false);
    expect(samePath("C:\\Users\\runneradmin\\data\\inbox\\a.pdf", "c:\\users\\RunnerAdmin\\data\\inbox\\A.PDF", "win32")).toBe(true);
    expect(samePath("C:\\data\\inbox\\a.pdf", "C:/data/inbox/a.pdf", "win32")).toBe(true);
    // A short name, a junction's target or another folder is another path: only the operating system's own answer is compared.
    expect(samePath("C:\\Users\\RUNNER~1\\data\\inbox\\a.pdf", "C:\\Users\\runneradmin\\data\\inbox\\a.pdf", "win32")).toBe(false);
    expect(samePath("C:\\data\\inbox\\a.pdf", "C:\\data\\config.json", "win32")).toBe(false);
    expect(samePath("C:\\data\\inbox\\a.pdf", "D:\\data\\inbox\\a.pdf", "win32")).toBe(false);
  });

  it("tells what is below the inbox from what only starts with its name", () => {
    expect(withinPath("/d/t/inbox/ana/a.pdf", "/d/t/inbox", "linux")).toBe(true);
    expect(withinPath("/d/t/inbox", "/d/t/inbox", "linux")).toBe(false);
    expect(withinPath("/d/t/inbox2/a.pdf", "/d/t/inbox", "linux")).toBe(false);
    expect(withinPath("/d/t/INBOX/a.pdf", "/d/t/inbox", "linux")).toBe(false);
    expect(withinPath("c:\\d\\t\\INBOX\\ana\\a.pdf", "C:\\d\\t\\inbox", "win32")).toBe(true);
    expect(withinPath("C:\\d\\t\\inbox2\\a.pdf", "C:\\d\\t\\inbox", "win32")).toBe(false);
    expect(withinPath("C:\\d\\t\\inbox", "C:\\d\\t\\inbox", "win32")).toBe(false);
    expect(withinPath("C:\\d\\t\\inbox\\..\\..\\config.json", "C:\\d\\t\\inbox", "win32")).toBe(false);
    expect(withinPath("D:\\d\\t\\inbox\\a.pdf", "C:\\d\\t\\inbox", "win32")).toBe(false);
  });

  it("names a copy for the receiver with the platform's own separators", () => {
    expect(inboxDisplayPath("ana", "a1", "report.pdf", "linux")).toBe("inbox/ana/a1/report.pdf");
    expect(inboxDisplayPath("ana", "a1-returned", "report.pdf", "darwin")).toBe("inbox/ana/a1-returned/report.pdf");
    expect(inboxDisplayPath("ana", "a1", "report.pdf", "win32")).toBe("inbox\\ana\\a1\\report.pdf");
  });
});

describe("inbox names", () => {
  it("never yields a name Windows keeps for a device, with or without an extension", () => {
    for (const name of ["CON", "con.txt", "NUL.pdf", "Aux.tar.gz", "COM1.csv", "lpt9", "PRN.md"]) {
      expect(inboxFileName(name), name).toBe(`_${name}`);
    }
    expect(inboxFileName("console.txt")).toBe("console.txt");
    expect(inboxFileName("COM10.csv")).toBe("COM10.csv");
    expect(inboxSenderPart("CON", "bot-1")).toBe("bot-con");
    expect(inboxSenderPart("Nul", "bot-1")).toBe("bot-nul");
    expect(inboxSenderPart("Ana Lima", "bot-1")).toBe("ana-lima");
    expect(inboxSenderPart("…", "Bot_1")).toBe("bot-1");
  });

  it("drops what Windows forbids in a name and what would end it in a dot or a space", () => {
    expect(inboxFileName('a<b>c:d"e|f?g*h.pdf')).toBe("a_b_c_d_e_f_g_h.pdf");
    expect(inboxFileName("report . .pdf")).toBe("report.pdf");
    expect(inboxFileName("trailing. ")).toBe("trailing");
    expect(inboxFileName("..\\..\\windows\\system32\\x.pdf")).toBe("_.._windows_system32_x.pdf");
    expect(inboxFileName("   ")).toBe("file");
  });

  it("caps a name at 200 bytes, keeps the extension, and never cuts a character in half", () => {
    for (const stem of ["a".repeat(400), "é".repeat(400), "文".repeat(400), "😀".repeat(400)]) {
      const name = inboxFileName(`${stem}.xlsx`);
      expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(200);
      expect(name.endsWith(".xlsx")).toBe(true);
      expect(name).not.toContain("\uFFFD");
      expect(Buffer.from(name, "utf8").toString("utf8")).toBe(name);
    }
  });

  it("tells same-named files apart whatever their case, and sent from returned", () => {
    expect(inboxFileNames(["Report.pdf", "report.pdf", "REPORT.PDF", "other.pdf"])).toEqual(["Report.pdf", "report-2.pdf", "REPORT-3.PDF", "other.pdf"]);
    expect(inboxAssignmentPart("3f2a-91", false)).toBe("3f2a-91");
    expect(inboxAssignmentPart("3f2a-91", true)).toBe("3f2a-91-returned");
    expect(inboxAssignmentPart("../x", true)).toBe("x-returned");
  });
});
