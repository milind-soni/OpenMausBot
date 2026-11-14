// The agents tools that each do several things, and the name each of their calls goes by: its member name, the name
// that call has as a tool of its own. A tool selection and the call path read a call by that name, so a selector or a
// saved skill naming a member means exactly those calls. Security: an engine may remember "always allow" by a tool's
// name, so a tool never does anything more destructive than each of its members did alone: deleting a trigger is a
// tool of its own.
type Args = Record<string, unknown>;

const given = (args: Args, key: string) => args[key] !== undefined && args[key] !== null;

function record(value: unknown): value is Args {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface AgentsActionTool {
  /** Every member, the tool's own name first when its plain calls keep it. */
  members: readonly string[];
  member(args: Args): string;
}

export const AGENTS_ACTION_TOOLS: Readonly<Record<string, AgentsActionTool>> = {
  trigger_info: { members: ["list_triggers", "list_trigger_events"], member: (args) => args.action === "events" ? "list_trigger_events" : "list_triggers" },
  trigger: { members: ["create_trigger", "manage_trigger"], member: (args) => args.action === "create" ? "create_trigger" : "manage_trigger" },
  delete_trigger: { members: ["manage_trigger"], member: () => "manage_trigger" },
  manage_room: { members: ["manage_room", "create_room"], member: (args) => args.action === "create" ? "create_room" : "manage_room" },
  session_search: { members: ["session_search", "session_read"], member: (args) => given(args, "thread_id") || given(args, "message_id") ? "session_read" : "session_search" },
  show_widget: { members: ["show_widget", "update_widget"], member: (args) => given(args, "widget_id") ? "update_widget" : "show_widget" },
  show_html: { members: ["show_html", "update_html"], member: (args) => given(args, "app_id") ? "update_html" : "show_html" },
  x_search: {
    members: ["x_search", "x_user_posts", "x_post", "x_profile"],
    member: (args) => args.action === "user_posts" ? "x_user_posts" : args.action === "post" ? "x_post" : args.action === "profile" ? "x_profile" : "x_search",
  },
};

/** A member name that is not a listed tool, still answered as a call: an engine session that saw it, a saved skill or
 * memory, or an external runtime may use one. It runs as the call `resolve` gives, to one of `tools`. */
export interface AgentsAlias {
  tools: readonly string[];
  resolve(args: Args): { name: string; arguments: Args };
}

const as = (name: string, args: Args) => ({ name, arguments: args });
/** An id the call must carry to mean an update: empty when it was left out, so the tool refuses rather than creates. */
const required = (args: Args, key: string): Args => ({ ...args, [key]: args[key] ?? "" });

export const AGENTS_TOOL_ALIASES: Readonly<Record<string, AgentsAlias>> = {
  list_triggers: { tools: ["trigger_info"], resolve: (args) => as("trigger_info", { ...args, action: "list" }) },
  list_trigger_events: { tools: ["trigger_info"], resolve: (args) => as("trigger_info", { ...args, action: "events" }) },
  create_trigger: { tools: ["trigger"], resolve: (args) => as("trigger", { ...args, action: "create" }) },
  manage_trigger: {
    tools: ["trigger", "delete_trigger"],
    resolve: ({ changes, ...args }) => {
      const fields = record(changes) ? changes : {};
      if (args.action === "delete") {
        const { action: _delete, ...target } = args;
        return as("delete_trigger", { ...fields, ...target });
      }
      return as("trigger", { ...fields, ...args, action: args.action === "create" ? undefined : args.action });
    },
  },
  create_room: { tools: ["manage_room"], resolve: (args) => as("manage_room", { ...args, action: "create" }) },
  session_read: { tools: ["session_search"], resolve: (args) => as("session_search", required(required(args, "thread_id"), "message_id")) },
  update_widget: { tools: ["show_widget"], resolve: (args) => as("show_widget", required(args, "widget_id")) },
  update_html: { tools: ["show_html"], resolve: (args) => as("show_html", required(args, "app_id")) },
  x_user_posts: { tools: ["x_search"], resolve: (args) => as("x_search", { ...args, action: "user_posts" }) },
  x_post: { tools: ["x_search"], resolve: (args) => as("x_search", { ...args, action: "post" }) },
  x_profile: { tools: ["x_search"], resolve: (args) => as("x_search", { ...args, action: "profile" }) },
};

const aliasOf = (name: string) => Object.hasOwn(AGENTS_TOOL_ALIASES, name) ? AGENTS_TOOL_ALIASES[name] : undefined;
const actionToolOf = (name: string) => Object.hasOwn(AGENTS_ACTION_TOOLS, name) ? AGENTS_ACTION_TOOLS[name] : undefined;

/** The tool a call runs and its arguments: an alias as its action tool's call, any other name as it came. */
export function resolveAgentsCall(name: string, args: Args): { name: string; arguments: Args } {
  return aliasOf(name)?.resolve(args) ?? { name, arguments: args };
}

/** The member name a call to `tool` with `args` goes by; the tool's own name when it does one thing. */
export function agentsCallMember(tool: string, args: unknown): string {
  return actionToolOf(tool)?.member(record(args) ? args : {}) ?? tool;
}

/** A call's names in a selection: its member name, and its tool's name when that is not itself a member. */
function named(tool: string, member: string): string[] {
  return actionToolOf(tool)?.members.includes(tool) ? [member] : [tool, member];
}

/** The names that identify an agents call in a tool selection. With no arguments (a tool being listed), one set per
 * call the name can make. */
export function agentsCallIdentities(name: string, args?: unknown): string[][] {
  const alias = aliasOf(name);
  if (alias) {
    if (args === undefined) return alias.tools.map((tool) => named(tool, name));
    const call = alias.resolve(record(args) ? args : {});
    return [named(call.name, agentsCallMember(call.name, call.arguments))];
  }
  const tool = actionToolOf(name);
  if (!tool) return [[name]];
  return args === undefined ? tool.members.map((member) => named(name, member)) : [named(name, tool.member(record(args) ? args : {}))];
}
