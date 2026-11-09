/** Drops arguments a model filled with a blank when it meant to leave them out, before the call is checked. */
import type { Json } from "./agents-client.ts";

function jsonRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The top-level arguments a model may fill with `""` (or spaces) when it means to leave them out, per tool. Only these:
 * elsewhere a blank can be the value itself, such as a cleared room bulletin or a bot's private folder. */
const BLANK_MEANS_LEFT_OUT: Readonly<Record<string, readonly string[]>> = {
  coordinate_bots: ["group_id", "reason", "thread", "title", "reply", "done_when", "answers"],
  session_search: ["thread_id", "message_id", "query", "since", "until", "scope"],
  show_html: ["html", "jsx", "path"],
  // A blank text or old_text is a mistake the schema names, not "not given".
  memory_update: ["until"],
};

const blankText = (value: unknown) => typeof value === "string" && !value.trim();
const blankOrNull = (value: unknown) => value === null || blankText(value);

/** A copy of `record` without the given keys where `blank` says they were left out. */
function withoutBlank(record: Json, keys: readonly string[], blank: (value: unknown) => boolean = blankOrNull): Json {
  const out: Json = { ...record };
  for (const key of keys) if (blank(out[key])) delete out[key];
  return out;
}

/** Strict tool-calling engines fill every optional field, so a model choice arrives with effort and variant both set to
 * "" or null; the receiver reads either as a choice and refuses ("choose either a model variant or an effort level"). */
function withoutBlankModelChoice(selection: unknown): unknown {
  return jsonRecord(selection) ? withoutBlank(selection, ["effort", "variant"]) : selection;
}

/** Same for team setup: a create also carries a blank botId and an update a blank key, which the receiver refuses as
 * unrecognized keys. A non-blank one is kept, so a real mistake is still named. */
function withoutBlankTeamSetupFields(input: Json): Json {
  if (!Array.isArray(input.operations)) return input;
  return {
    ...input,
    operations: input.operations.map((operation) => {
      if (!jsonRecord(operation)) return operation;
      const out = withoutBlank(operation, operation.action === "create" ? ["botId"] : operation.action === "update" ? ["key"] : []);
      if (jsonRecord(out.fields) && out.fields.modelSelection !== undefined) {
        out.fields = { ...out.fields, modelSelection: withoutBlankModelChoice(out.fields.modelSelection) };
      }
      return out;
    }),
  };
}

export function dropBlankArguments(name: string, input: Json): Json {
  if (!jsonRecord(input)) return input;
  if (name === "propose_team_setup") return withoutBlankTeamSetupFields(input);
  if (name === "create_bot" && input.modelSelection !== undefined) return { ...input, modelSelection: withoutBlankModelChoice(input.modelSelection) };
  const keys = Object.hasOwn(BLANK_MEANS_LEFT_OUT, name) ? BLANK_MEANS_LEFT_OUT[name] : undefined;
  return keys ? withoutBlank(input, keys, blankText) : input;
}
