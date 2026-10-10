// What a lent screen accepts, argument by argument. Derived from the local
// computer-control driver's own input schemas (cua-driver 0.12.6 `describe`),
// keeping only arguments that observe or operate what is on screen. Anything
// that names a local path, a command line, a port or a system prompt is not
// lent: `screenshot_out_file` and `debug_image_out` write a file anywhere
// (screenshots come back inline instead), `image_path` and a path-like
// `cursor_icon` read one, `launch_app`'s `additional_arguments` is a command
// line and its `webkit_inspector_port` opens a port, and its `urls` accept
// file paths, so only web addresses pass. An argument not listed for its tool
// is refused, never forwarded, so a newer driver lends nothing new until it is
// reviewed and listed here. A tool not listed is refused, too.
const ID = { type: "string", max: 200 };
const LABEL = { type: "string", max: 1000 };
const TEXT = { type: "string", max: 20_000 };
const INTEGER = { type: "integer" };
const NUMBER = { type: "number" };
const BOOLEAN = { type: "boolean" };
const KEYS = { type: "strings", max: 20 };
const oneOf = (...values) => ({ type: "enum", values });
const DELIVERY = oneOf("background", "foreground");
const SCOPE = oneOf("window", "desktop");
const BUTTON = oneOf("left", "right", "middle");
const INPUT_ROUTE = oneOf("trusted", "dom_event");
/** Web addresses only: never a file path or a custom scheme that starts a
 * program. */
const WEB_URLS = { type: "urls", max: 10, schemes: ["http:", "https:"] };
const PAGE_URL = { type: "url", schemes: ["http:", "https:", "about:"] };

const at = { x: NUMBER, y: NUMBER };
const target = { pid: INTEGER, window_id: INTEGER, session: ID };
const element = { element_index: INTEGER, element_token: ID };
const tab = { target_id: ID, tab_id: ID, session: ID };

export const LENT_SCREEN_ARGUMENTS = Object.freeze({
  bring_to_front: { pid: INTEGER, window_id: INTEGER },
  click: { ...target, ...element, ...at, action: oneOf("press", "show_menu", "pick", "confirm", "cancel", "open"), button: BUTTON, count: INTEGER, delivery_mode: DELIVERY, from_zoom: BOOLEAN, modifier: KEYS, scope: SCOPE },
  double_click: { ...target, ...element, ...at, delivery_mode: DELIVERY },
  right_click: { ...target, ...element, ...at, delivery_mode: DELIVERY, modifier: KEYS },
  drag: { ...target, button: BUTTON, delivery_mode: DELIVERY, duration_ms: INTEGER, from_x: NUMBER, from_y: NUMBER, from_zoom: BOOLEAN, modifier: KEYS, scope: SCOPE, steps: INTEGER, to_x: NUMBER, to_y: NUMBER },
  scroll: { ...target, ...element, ...at, amount: INTEGER, by: oneOf("line", "page"), delivery_mode: DELIVERY, direction: oneOf("up", "down", "left", "right"), scope: SCOPE },
  move_cursor: { ...at, cursor_id: ID, scope: SCOPE, session: ID },
  hotkey: { ...target, ...at, delivery_mode: DELIVERY, keys: KEYS, scope: SCOPE },
  press_key: { ...target, ...element, ...at, delivery_mode: DELIVERY, key: ID, modifiers: KEYS, scope: SCOPE },
  type_text: { ...target, ...element, ...at, delay_ms: INTEGER, delivery_mode: DELIVERY, scope: SCOPE, text: TEXT },
  set_value: { ...target, ...element, value: TEXT },
  launch_app: { bundle_id: ID, name: ID, creates_new_application_instance: BOOLEAN, urls: WEB_URLS },
  list_apps: {},
  list_windows: { on_screen_only: BOOLEAN, pid: INTEGER },
  get_window_state: { ...target, capture_mode: oneOf("ax", "vision"), include_screenshot: BOOLEAN, max_depth: INTEGER, max_elements: INTEGER, query: LABEL },
  get_accessibility_tree: {},
  get_desktop_state: { session: ID },
  get_screen_size: { session: ID },
  get_cursor_position: { session: ID },
  zoom: { pid: INTEGER, window_id: INTEGER, x1: NUMBER, y1: NUMBER, x2: NUMBER, y2: NUMBER },
  start_session: { session: ID, capture_scope: oneOf("auto", "window", "desktop") },
  end_session: { session: ID },
  get_session_state: { session: ID },
  escalate_session: { session: ID, reason: oneOf("ax_tree_pixel_mismatch", "background_delivery_failed", "foreground_ineffective", "no_window_target", "other"), detail: LABEL },
  get_agent_cursor_state: { cursor_id: ID },
  set_agent_cursor_enabled: { cursor_id: ID, enabled: BOOLEAN },
  set_agent_cursor_motion: {
    cursor_id: ID, cursor_color: ID, cursor_label: ID, cursor_icon: oneOf("arrow", "teardrop", ""),
    arc_flow: NUMBER, arc_size: NUMBER, cursor_opacity: NUMBER, cursor_size: NUMBER, dwell_after_click_ms: NUMBER, end_handle: NUMBER,
    glide_duration_ms: NUMBER, idle_hide_ms: NUMBER, spring: NUMBER, start_handle: NUMBER, turn_radius: NUMBER,
  },
  set_agent_cursor_style: { cursor_id: ID, bloom_color: ID, gradient_colors: KEYS },
  browser_click: { ...tab, ...at, input_route: INPUT_ROUTE, ref: ID },
  browser_type: { ...tab, mode: oneOf("insert_text", "keystrokes"), ref: ID, text: TEXT },
  browser_navigate: { ...tab, url: PAGE_URL },
  browser_pointer: { ...tab, ...at, action: oneOf("hover", "right_click", "double_click", "scroll", "drag"), delta_x: NUMBER, delta_y: NUMBER, destination_ref: ID, input_route: INPUT_ROUTE, ref: ID, to_x: NUMBER, to_y: NUMBER },
  browser_dialog: { ...tab, action: oneOf("inspect", "accept", "dismiss"), delivery_mode: DELIVERY, dialog_id: ID, prompt_text: TEXT },
  get_browser_state: { ...target, ...tab, continuation: LABEL, include_screenshot: BOOLEAN, query: LABEL, scope_ref: ID, snapshot_format: oneOf("dom_refs_v1", "semantic_v2") },
});

export const LENT_SCREEN_TOOLS = Object.freeze(new Set(Object.keys(LENT_SCREEN_ARGUMENTS)));

const webAddress = (value, schemes) => {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { return schemes.includes(new URL(value).protocol); } catch { return false; }
};

function acceptable(spec, value) {
  switch (spec.type) {
    case "string": return typeof value === "string" && value.length <= spec.max;
    case "integer": return Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "enum": return spec.values.includes(value);
    case "strings": return Array.isArray(value) && value.length <= spec.max && value.every(entry => typeof entry === "string" && entry.length <= 100);
    case "url": return webAddress(value, spec.schemes);
    case "urls": return Array.isArray(value) && value.length <= spec.max && value.every(entry => webAddress(entry, spec.schemes));
    default: return false;
  }
}

/** The arguments to forward for one lent screen tool, or an error naming what
 * is refused. Returns a fresh plain object: nothing outside the allow-list,
 * nothing inherited, nothing the server could smuggle through a prototype. */
export function lentScreenArguments(name, input) {
  const allowed = Object.hasOwn(LENT_SCREEN_ARGUMENTS, name) ? LENT_SCREEN_ARGUMENTS[name] : null;
  if (!allowed) return { error: `${String(name).slice(0, 100)} is not part of lent apps and screen` };
  const given = input ?? {};
  if (typeof given !== "object" || Array.isArray(given)) return { error: "Tool arguments must be an object" };
  const forwarded = {};
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(allowed, key)) return { error: `${name}: ${key.slice(0, 100)} is not allowed on a lent screen` };
    if (!acceptable(allowed[key], given[key])) return { error: `${name}: ${key} has a value a lent screen does not accept` };
    forwarded[key] = given[key];
  }
  return { arguments: forwarded };
}

/** A driver tool as the Cloud sees it: only lent tools, and each schema cut
 * down to the arguments a lent screen accepts, so the model is never offered
 * one that would be refused. */
export function lentScreenToolListing(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter(tool => typeof tool?.name === "string" && LENT_SCREEN_TOOLS.has(tool.name)).map(tool => {
    const allowed = LENT_SCREEN_ARGUMENTS[tool.name];
    const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const kept = Object.fromEntries(Object.entries(properties).filter(([key]) => Object.hasOwn(allowed, key)));
    const required = Array.isArray(schema.required) ? schema.required.filter(key => Object.hasOwn(allowed, key)) : undefined;
    return { ...tool, inputSchema: { ...schema, type: "object", properties: kept, ...(required ? { required } : {}), additionalProperties: false } };
  });
}
