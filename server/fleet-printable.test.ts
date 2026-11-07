import { describe, expect, it } from "vitest";

import { printable } from "./fleet-printable.ts";

describe("text a tenant chose, printed to the reseller's terminal", () => {
  it("keeps ordinary text, accents and other scripts as they are", () => {
    for (const text of ["ada@acme.test", "device:müller's laptop", "مرحبا", "東京オフィス", "a b c"]) expect(printable(text)).toBe(text);
  });

  it("turns each control character into a space", () => {
    expect(printable("ada\u001b[2J@acme.test")).toBe("ada [2J@acme.test");
    expect(printable("line\nbreak\r\ttab\u0000\u007f\u0085\u009b")).toBe(`line break  tab${" ".repeat(4)}`);
  });

  it("drops bidi and zero-width format characters so a name cannot reorder or hide what is printed", () => {
    const hidden = ["​", "‌", "‍", "‎", "‏", "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩", "﻿", "؜"];
    for (const char of hidden) expect(printable(`ad${char}a@acme.test`), `U+${char.codePointAt(0)!.toString(16)}`).toBe("ada@acme.test");
    expect(printable("invoice‮gpj.exe")).toBe("invoicegpj.exe");
    expect(printable("⁧evil⁩​﻿ ok")).toBe("evil ok");
  });
});
