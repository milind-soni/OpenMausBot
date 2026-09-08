import { describe, expect, it } from "vitest";
import {
  usesComparisonColumns,
  validateInteractiveSource,
  INTERACTIVE_REPLY_PROMPT,
} from "./interactive-reply";
import {
  INTERACTIVE_CHOICE_EXAMPLE,
  INTERACTIVE_COMPARE_EXAMPLE,
  INTERACTIVE_HEATMAP_EXAMPLE,
} from "./interactive-examples";

describe("interactive reply admission", () => {
  it("keeps controls and derived results in one flow; columns are for peer comparisons", () => {
    expect(usesComparisonColumns([{ typeName: "Slider" }, { typeName: "Metric" }])).toBe(false);
    expect(usesComparisonColumns([{ typeName: "NumberInput" }, { typeName: "Toggle" }])).toBe(false);
    expect(usesComparisonColumns([{ typeName: "Card" }, { typeName: "Card" }])).toBe(true);
  });
  it.each([INTERACTIVE_CHOICE_EXAMPLE, INTERACTIVE_COMPARE_EXAMPLE, INTERACTIVE_HEATMAP_EXAMPLE])(
    "admits composable examples",
    (source) => expect(validateInteractiveSource(source)).toBeNull(),
  );
  it("admits the agent's documented example", () =>
    expect(
      validateInteractiveSource(INTERACTIVE_REPLY_PROMPT.split("```openmaus-ui\n")[1]!.split("```")[0]!),
    ).toBeNull());
  it.each([
    "Query",
    "Each",
    "Mutation",
    "OpenUrl",
    "ToAssistant",
    "eval",
    "Function",
    "fetch",
    "constructor",
    "__proto__",
  ])("rejects capability %s", (name) =>
    expect(validateInteractiveSource(`root = ${name}("https://example.com");`)).toMatch(/unsupported/),
  );
  it("treats literal text as data", () =>
    expect(
      validateInteractiveSource('root = Text("window.fetch and constructor are text <script>");'),
    ).toBeNull());
  it("rejects excessive bytes, nesting, cyclic and exponential references", () => {
    expect(validateInteractiveSource('root = Text("' + "x".repeat(32768) + '");')).toMatch(/large/);
    expect(validateInteractiveSource("root = " + "Stack([".repeat(21) + '"])')).not.toBeNull();
    expect(validateInteractiveSource("root = Stack([a]); a = Stack([root]);")).toMatch(/cyclic/);
    const source =
      'leaf = Text("x");' +
      Array.from(
        { length: 15 },
        (_, i) =>
          `n${i} = Stack([${Array(4)
            .fill(i ? `n${i - 1}` : "leaf")
            .join(",")}]);`,
      ).join("") +
      "root = Stack([n14]);";
    expect(validateInteractiveSource(source)).toMatch(/excessive/);
  });
  it("requires a complete root and unique declarations", () => {
    expect(validateInteractiveSource('other = Text("x");')).not.toBeNull();
    expect(validateInteractiveSource('root = Text("x"); root = Text("y");')).not.toBeNull();
    expect(validateInteractiveSource("root = Stack([")).not.toBeNull();
  });
});
