// A tool's input schema as a model is shown it, with the JSON that says nothing to the model left out. Calls are still
// checked against the tool's own full schema, so every rule here either keeps what the schema accepts or only leaves out
// a form the handler still takes:
//   - `additionalProperties: true` is the default;
//   - a `minimum`/`maximum` at JavaScript's safe-integer limit bounds nothing a model would send;
//   - an `anyOf` whose only key is `anyOf`, inside another, is the same choice flattened;
//   - a string branch marked `contentMediaType: application/json` beside other branches is the same value written as JSON
//     text: offered to a model, it invites stringified input;
//   - the `{"type":"null"}` branch of a property the schema does not require: leaving the property out says the same;
//   - an `anyOf` left with one branch is that branch;
//   - objects told apart by one property with a single fixed value each (a tagged union) become one object: the tag lists
//     every value, each other property is offered once, and only what every branch requires stays required. Each tag's own
//     required fields are then checked by the handler, not shown.
type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const onlyKey = (node: Json, key: string) => Object.keys(node).length === 1 && key in node;
const isNullBranch = (node: unknown) => isObject(node) && node.type === "null" && onlyKey(node, "type");
const isBareAnyOf = (node: unknown): node is { anyOf: unknown[] } => isObject(node) && Array.isArray(node.anyOf) && onlyKey(node, "anyOf");
const isJsonText = (node: unknown) => isObject(node) && node.type === "string" && node.contentMediaType === "application/json";
const SAFE_BOUNDS: Record<string, number> = { maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER };

/** The single fixed value `branch` gives property `key` (`const`, or an `enum` of one), else undefined. */
function tagOf(branch: Json, key: string): unknown {
  const property = isObject(branch.properties) ? branch.properties[key] : undefined;
  if (!isObject(property)) return undefined;
  if (Array.isArray(property.enum) && property.enum.length === 1) return property.enum[0];
  return "const" in property ? property.const : undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One object for objects told apart by one property with a distinct fixed string value each; undefined otherwise. */
function mergedTaggedObjects(branches: readonly unknown[]): Json | undefined {
  if (branches.length < 2) return undefined;
  const objects = branches.filter((branch): branch is Json & { properties: Json } => isObject(branch) && branch.type === "object" && isObject(branch.properties));
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return values.every((value) => typeof value === "string") && new Set(values).size === values.length;
  });
  if (tag === undefined) return undefined;
  const properties: Json = { [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) } };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) { properties[name] = property; continue; }
      const options = isBareAnyOf(seen) ? seen.anyOf : [seen];
      if (!options.some((option) => same(option, property))) properties[name] = { anyOf: [...options, property] };
    }
  }
  const [first = [], ...others] = objects.map((object) => (Array.isArray(object.required) ? object.required : []));
  const required = first.filter((name) => name !== tag && others.every((list) => list.includes(name)));
  return { type: "object", properties, required: [tag, ...required] };
}

function compact(node: unknown, optional: boolean): unknown {
  if (Array.isArray(node)) return node.map((item) => compact(item, false));
  if (!isObject(node)) return node;
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  let result: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_BOUNDS[key] === value) continue;
    // Values, not schemas: copied as they are.
    if (key === "enum" || key === "const" || key === "default" || key === "examples" || key === "required") result[key] = value;
    else if (key === "properties" && isObject(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, compact(property, !required.has(name))]));
    } else result[key] = compact(value, false);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !(optional && isNullBranch(branch)));
    const kept = branches.length > 1 && branches.some((branch) => !isJsonText(branch)) ? branches.filter((branch) => !isJsonText(branch)) : branches;
    const { anyOf: _anyOf, ...rest } = result;
    const only = kept.length === 1 ? kept[0] : mergedTaggedObjects(kept);
    result = isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: kept };
  }
  return result;
}

/** `schema` with the rules above applied at every level; a new object, `schema` untouched. */
export function compactAdvertisedSchema(schema: Json): Json {
  return compact(schema, false) as Json;
}
