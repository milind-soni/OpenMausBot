// cua-driver 0.28.2 refuses browser_prepare's existing_profile strategy in standard mode unless its daemon was launched with
// --grant existing-profile or an authorization host, and its embedded host (SDK through 0.37.0) takes neither. The refusal
// names only those two, so a bot relays them to the person, who has no way to act on either.
import { typeOneCharacterAtATime, typesInOneBurst } from "../electron/paced-typing.mjs";
import { describeComputerCall } from "../shared/your-computer.ts";
import type { ChildCalls, ToolCall } from "./mcp-bridge.ts";
import { CLICK_TOOLS, unconfirmedClickResult } from "./unconfirmed-click.ts";

type JsonObject = Record<string, unknown>;

/** What a bot tells the person about this computer: what it could not do and what they can do, never the plumbing. */
export const PLAIN_WORDS =
  "When you tell the person about any of this, use plain words: say what you could not do and what they can do, and never mention DevTools, CDP, debugging ports, profiles, grants, binding, attaching, endpoints or drivers.";

export const OWN_PROFILE_UNAVAILABLE =
  "Computer control on this computer cannot attach to the person's own signed-in browser profile, and nothing the person can turn on changes that: do not retry strategy existing_profile, and never ask them to grant it or to start anything with a flag. For work on a website, use your own browser: if select_computer offers browser, select it and end your turn. The request continues there, in the person's own Chrome when this bot's browser profile is My Chrome, and fill_login can sign in there with the person's saved logins, 1Password included. With no browser of your own, use a cloud computer if select_computer offers one, or a connected app. Only when the task needs the person's own signed-in session and nothing else works, use their screen: launch_app with urls opens the page in their own browser; read it with get_window_state and act with click, type_text and press_key, and call request_sign_in when the site needs them to sign in. " +
  PLAIN_WORDS;

const REFUSAL_CODE = "browser_consent_required";

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refusesOwnProfile(result: JsonObject): boolean {
  const structured = result.structuredContent;
  if (!isObject(structured) || !isObject(structured.refusal)) return false;
  const { code, message } = structured.refusal;
  return code === REFUSAL_CODE && typeof message === "string" && message.includes("existing-profile");
}

/** One MCP stdio frame from the local driver; only an existing-profile refusal is parsed and changed. */
export function localComputerResultLine(line: string): string {
  if (!line.includes(REFUSAL_CODE)) return line;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObject(frame) || !isObject(frame.result) || !Array.isArray(frame.result.content) || !refusesOwnProfile(frame.result)) return line;
  const content = [...frame.result.content, { type: "text", text: OWN_PROFILE_UNAVAILABLE }];
  return JSON.stringify({ ...frame, result: { ...frame.result, content } });
}

/** The query a screen call carries to the gate: the app and site it would open, for the person's one-time question. */
export function localComputerCallQuery(frame: unknown): Record<string, string> {
  const { app, site } = describeComputerCall(frame);
  return { ...(app ? { app } : {}), ...(site ? { site } : {}) };
}

/** The calls this computer's driver gets in a form of its own. Only on Windows: there foreground text is typed one
 * character at a time, and a click whose after-check failed is answered as the sent click it was. */
export function localComputerRelay(platform: string) {
  return (call: ToolCall, child: ChildCalls): Promise<unknown> | null => {
    if (platform !== "win32") return null;
    if (typesInOneBurst(platform, child.driverVersion, call.name, call.arguments)) {
      return typeOneCharacterAtATime(child.call, call.arguments as ToolCall["arguments"] & { text: string });
    }
    if (!CLICK_TOOLS.has(call.name)) return null;
    return child.call(call.name, call.arguments).then((result) => unconfirmedClickResult(result) ?? result);
  };
}
