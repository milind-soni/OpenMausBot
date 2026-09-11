import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BRAND, describeBrand, loadBrand } from "./brand.ts";

const dirs: string[] = [];
const licensed = (feature: string) => feature === "whitelabel";
const unlicensed = () => false;

function brandFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-brand-"));
  dirs.push(dir);
  const file = join(dir, "brand.json");
  writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("brand.json", () => {
  it("is the default brand when no file exists, pointing at where one would go", () => {
    const file = join(tmpdir(), "omb-brand-missing", "brand.json");
    expect(loadBrand({ file, isEntitled: licensed })).toEqual({ brand: DEFAULT_BRAND, source: "default", file });
    expect(describeBrand(loadBrand({ file, isEntitled: licensed }))).toBe("brand: default");
  });

  it("applies a valid file on a licensed server", () => {
    const file = brandFile(JSON.stringify({
      name: "Reliable Platform",
      tagline: "Back office, on autopilot",
      accent: "#1D4ED8",
      logo: "data:image/svg+xml;base64,PHN2Zy8+",
      supportUrl: "https://help.reliable.example",
    }));
    const status = loadBrand({ file, isEntitled: licensed });
    expect(status.source).toBe("file");
    expect(status.brand.name).toBe("Reliable Platform");
    expect(status.brand.accent).toBe("#1D4ED8");
    expect(status.notice).toBeUndefined();
    expect(describeBrand(status)).toBe(`brand: Reliable Platform (from ${file})`);
  });

  it("keeps the default brand on an unlicensed server and says so", () => {
    const file = brandFile(JSON.stringify({ name: "Acme" }));
    const status = loadBrand({ file, isEntitled: unlicensed });
    expect(status.brand).toEqual(DEFAULT_BRAND);
    expect(status.source).toBe("default");
    expect(status.notice).toContain("not licensed for whitelabel");
  });

  it("explains a broken file in terms of what to change, and never applies it", () => {
    const cases: Array<[string, RegExp]> = [
      ["{not json", /not valid JSON/],
      [JSON.stringify({ name: "" }), /name: name must not be empty/],
      [JSON.stringify({ name: "x".repeat(41) }), /name must be 40 characters or fewer/],
      [JSON.stringify({ name: "Acme", accent: "blue" }), /accent: accent must be a 6-digit hex colour/],
      [JSON.stringify({ name: "Acme", logo: "http://insecure.example/logo.png" }), /logo: logo must be a data:image/],
      [JSON.stringify({ name: "Acme", supportUrl: "http://help.example" }), /supportUrl: supportUrl must be an https/],
      [JSON.stringify({ name: "Acme", colour: "#000000" }), /colour/],
    ];
    for (const [content, expected] of cases) {
      const status = loadBrand({ file: brandFile(content), isEntitled: licensed });
      expect(status.brand, content).toEqual(DEFAULT_BRAND);
      expect(status.notice, content).toMatch(expected);
      expect(status.notice, content).toMatch(/using the default brand$/);
    }
  });

  it("validates before gating, so an unlicensed operator still learns about a broken file", () => {
    const status = loadBrand({ file: brandFile(JSON.stringify({ name: "Acme", accent: "nope" })), isEntitled: unlicensed });
    expect(status.notice).toMatch(/accent/);
  });
});

describe("the brand's favicon", () => {
  it("accepts a small data URI or an https URL and refuses anything else", async () => {
    const { brandSchema } = await import("./brand.ts");
    expect(brandSchema.safeParse({ name: "Agent Ada", favicon: "data:image/png;base64,iVBORw0KGgo=" }).success).toBe(true);
    expect(brandSchema.safeParse({ name: "Agent Ada", favicon: "https://agentada.cc/icon.png" }).success).toBe(true);
    expect(brandSchema.safeParse({ name: "Agent Ada", favicon: "http://agentada.cc/icon.png" }).success).toBe(false);
    expect(brandSchema.safeParse({ name: "Agent Ada", favicon: "/icon.png" }).success).toBe(false);
    expect(brandSchema.safeParse({ name: "Agent Ada", favicon: `data:image/png;base64,${"A".repeat(130_000)}` }).success).toBe(false);
  });
});
