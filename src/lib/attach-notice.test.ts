import { afterEach, describe, expect, it } from "vitest";

import { AttachError, intakeFiles } from "./composer-attachments";
import { attachNoticeText, pasteSummaryText, sizeText } from "./attach-notice";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

describe("attachment notices", () => {
  it("word every problem in English as before, and say nothing when there is none", () => {
    expect(attachNoticeText([])).toBeNull();
    expect(attachNoticeText([{ kind: "unsupported", names: ["a.bin", "b.bin"] }, { kind: "upload-failed", name: "c.pdf", reason: "disk full" }]))
      .toBe("Unable to attach a.bin, b.bin. Choose a supported image, document, or audio file. (c.pdf: disk full)");
    expect(attachNoticeText([{ kind: "too-large", name: "big.png", limitMb: 10 }])).toBe("big.png exceeds 10 MB");
  });

  it("keeps image limits first, then unsupported files, archives and upload failures", () => {
    const problems = [
      { kind: "upload-failed" as const, name: "c.pdf", reason: "disk full" },
      { kind: "archives" as const, names: ["a.zip"] },
      { kind: "unsupported" as const, names: ["b.bin"] },
      { kind: "image-limit" as const, names: ["left.png"] },
    ];
    expect(attachNoticeText(problems)).toBe("A message takes up to 10 images, 40 MB in all. left.png wasn't attached. Unable to attach b.bin. Choose a supported image, document, or audio file. Archives can't be attached: unzip a.zip and attach the files inside. (c.pdf: disk full)");
    expect(attachNoticeText([{ kind: "image-limit", names: ["a.png", "b.png"] }])).toBe("A message takes up to 10 images, 40 MB in all. a.png, b.png weren't attached.");
    setLocale("pt-br");
    expect(attachNoticeText(problems)).toBe("Uma mensagem aceita até 10 imagens, com 40 MB no total. O arquivo left.png não foi anexado. Não foi possível anexar b.bin. Escolha um arquivo compatível: imagem, documento ou áudio. Arquivos compactados não podem ser anexados: descompacte a.zip e anexe os arquivos de dentro. (c.pdf: não foi possível enviar. Motivo: disk full)");
    expect(attachNoticeText([{ kind: "image-limit", names: ["a.png", "b.png"] }])).toContain("Os arquivos a.png, b.png não foram anexados.");
  });

  it("word them in the person's language", () => {
    setLocale("pt-br");
    expect(attachNoticeText([{ kind: "too-large", name: "big.png", limitMb: 25 }])).toBe("big.png tem mais de 25 MB");
    expect(attachNoticeText([{ kind: "upload-failed", name: "c.pdf", reason: "disk full" }])).toBe("c.pdf: não foi possível enviar. Motivo: disk full");
  });

  it("carry an oversized image's limit through intake, keeping the English message on the error", async () => {
    const error = new AttachError("big.png", 10 * 1024 * 1024);
    expect(error).toMatchObject({ message: "big.png exceeds 10 MB", status: 413, problem: { kind: "too-large", name: "big.png", limitMb: 10 } });
    const file = { name: "big.png", size: 1, type: "image/png", text: async () => "" };
    const out = await intakeFiles([file], { allowImages: true, getPath: () => "", uploadImage: async () => { throw error; } });
    expect(out.problems).toEqual([error.problem]);
  });

  it("size a pasted block with the person's number format", () => {
    expect(pasteSummaryText({ lines: 2, size: 1536 })).toBe("2 lines, 1.5 KB");
    expect(sizeText(512)).toBe("512 B");
    setLocale("pt-br");
    expect(pasteSummaryText({ lines: 1200, size: 1536 })).toBe("Linhas: 1.200 · 1,5 KB");
  });
});
