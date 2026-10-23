// A made-up tool shaped like a docs app's "create page": rich text defined once in $defs and reused by ten block types,
// with the long descriptions such servers ship. Under 12 KB as sent, over 20 KB once its refs are inlined.
const prose = (what: string) =>
  `${what}. Use this when the page needs it; the value is stored as written and shown to every member of the workspace who can open the parent.`;

const BLOCKS = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout"];
const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

const richText = {
  type: "object",
  description: prose("A run of rich text"),
  properties: {
    type: { type: "string", enum: ["text", "mention", "equation"], description: prose("Kind of run") },
    text: {
      type: "object",
      properties: {
        content: { type: "string", description: prose("Plain text") },
        link: { type: ["object", "null"], properties: { url: { type: "string", format: "uri" } } },
      },
    },
    annotations: {
      type: "object",
      properties: {
        ...Object.fromEntries(["bold", "italic", "strikethrough", "underline", "code"].map((key) => [key, { type: "boolean", default: false, description: prose(key) }])),
        color: { type: "string", enum: COLORS },
      },
    },
  },
  required: ["type"],
};

const block = (name: string) => ({
  type: "object",
  title: name,
  description: prose(`A ${name} block`),
  properties: {
    rich_text: { type: "array", items: { $ref: "#/$defs/richText" }, description: prose("Text") },
    color: { type: "string", enum: COLORS },
    children: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  required: ["rich_text"],
});

export function createPageSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: { richText },
    properties: {
      parent: { type: "object", description: prose("Where the page goes"), properties: { page_id: { type: "string" }, database_id: { type: "string" } } },
      title: { type: "array", items: { $ref: "#/$defs/richText" }, description: prose("Page title") },
      icon: {
        description: prose("Icon"),
        anyOf: [
          { type: "object", properties: { emoji: { type: "string" } }, required: ["emoji"] },
          { type: "object", properties: { external: { type: "object", properties: { url: { type: "string" } } } }, required: ["external"] },
        ],
      },
      children: {
        type: "array",
        description: prose("Blocks"),
        items: { anyOf: BLOCKS.map((name) => ({ type: "object", properties: { type: { type: "string", enum: [name] }, [name]: block(name) }, required: ["type", name] })) },
      },
    },
    required: ["parent", "title"],
  };
}

/** `count` top-level fields, each an object of six text fields. */
export function wideSchema(count: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    properties[`field_${String(index).padStart(3, "0")}`] = {
      type: "object",
      description: `Settings group ${index}.`,
      properties: Object.fromEntries(["label", "value", "unit", "source", "owner", "note"].map((key) => [key, { type: "string" }])),
    };
  }
  return { type: "object", properties, required: ["field_000"] };
}
