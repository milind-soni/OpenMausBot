// cua-driver before 0.35.0 sends a Windows foreground type_text as one SendInput burst of Unicode key packets
// (platform-windows/src/input/keyboard.rs, send_text_synthesized_after_focus), and modern Notepad reads a packet ahead of
// translating the one before it, so later characters land in place of earlier ones: " Zeile Drei" came out " iiiiiiiiii".
// https://github.com/trycua/cua/issues/4830 — 0.35.0 paces the text itself. With an older driver each character goes as
// its own type_text, after its window is confirmed in front.

/** The first driver that types foreground text one character at a time itself. */
const PACED_FROM = [0, 35, 0];
/** At about 50 ms a character this stays well inside the 45 seconds a lent screen's call has, and the 60 an engine gives one. */
export const MAX_PACED_CHARACTERS = 300;
/** The driver's own list of tool-call tags a model can leak into the end of `text` (cua-driver-core/src/text_sanitize.rs). */
const LEAKED_TAGS = new Set(["text", "parameter", "invoke", "function_calls", "function_call", "tool_use", "tool_call",
  "antml:parameter", "antml:invoke", "antml:function_calls"]);

const asciiLower = (value) => value.replace(/[A-Z]+/gu, (letters) => letters.toLowerCase());

function olderThanPacing(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)/u.exec(typeof version === "string" ? version : "")?.slice(1).map(Number);
  if (!parts) return false;
  for (const [index, part] of parts.entries()) if (part !== PACED_FROM[index]) return part < PACED_FROM[index];
  return false;
}

const desktopScope = (args) => args.scope === "desktop" && args.pid === undefined && args.window_id === undefined;

/** Whether this driver would type `args` as one burst. A window the driver knows only from an element_token cannot be
 * held in front from here, so that call goes on as it came. */
export function typesInOneBurst(platform, driverVersion, name, args) {
  if (platform !== "win32" || name !== "type_text" || !olderThanPacing(driverVersion)) return false;
  if (!args || typeof args !== "object" || typeof args.text !== "string") return false;
  if (desktopScope(args)) return true;
  return typeof args.delivery_mode === "string" && args.delivery_mode.toLowerCase() === "foreground" &&
    Number.isSafeInteger(args.pid) && (args.window_id !== undefined || args.element_token === undefined);
}

/** One entry per character as the driver reads them: a CRLF pair is one line break, which it types as one Return. */
export function typingUnits(text) {
  const units = [];
  for (const character of text) {
    if (character === "\n" && units.at(-1) === "\r") units[units.length - 1] = "\r\n";
    else units.push(character);
  }
  return units;
}

function opensTag(before, name) {
  const lower = asciiLower(before);
  const opener = `<${name}`;
  for (let at = lower.indexOf(opener); at !== -1; at = lower.indexOf(opener, at + opener.length)) {
    const next = lower[at + opener.length];
    if (next === undefined || next === ">" || /\s/u.test(next)) return true;
  }
  return false;
}

/** The driver drops a trailing run of unbalanced tool-call closing tags from the whole text; sent a character at a time
 * it would never see them whole, so the same rule runs here first. */
export function withoutLeakedToolTags(text) {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  for (;;) {
    const head = trimmed.slice(0, end).trimEnd();
    end = head.length;
    const open = head.lastIndexOf("</");
    if (!head.endsWith(">") || open === -1) break;
    const name = head.slice(open + 2, -1);
    if (!name || /\s/u.test(name) || !LEAKED_TAGS.has(asciiLower(name)) || opensTag(head.slice(0, open), asciiLower(name))) break;
    end = open;
  }
  return end === trimmed.length ? text : trimmed.slice(0, end).trimEnd();
}

const failure = (text) => ({ content: [{ type: "text", text }], isError: true });

async function attempt(call, name, args) {
  try {
    const result = await call(name, args);
    return result && typeof result === "object" ? result : failure(`${name} returned no result`);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

const SAID = new Set(["content", "structuredContent", "isError"]);
/** A driver answer's protocol fields (resultType, _meta) without what it said. */
const envelope = (result) => Object.fromEntries(Object.entries(result).filter(([key]) => !SAID.has(key)));

/** bring_to_front reports windows as "0x…" text; 0 when it named none. */
const handle = (value) => typeof value === "string" && /^0x[0-9a-f]+$/iu.test(value) ? Number.parseInt(value, 16) : 0;

/** Asked before each character, bring_to_front also says whether the window was still in front. */
async function inFront(call, pid, window) {
  const front = await attempt(call, "bring_to_front", { pid, ...(window === undefined ? {} : { window_id: window }) });
  const shown = front.isError ? null : front.structuredContent;
  return { ok: Boolean(shown), before: handle(shown?.previous_fg_hwnd), target: handle(shown?.target_hwnd) };
}

/** The driver's own foreground typing puts back the window that was in front; bring_to_front never does. */
async function giveFrontBack(call, before, target) {
  if (!before || before === target) return;
  const windows = (await attempt(call, "list_windows", {})).structuredContent?.windows;
  const owner = Array.isArray(windows) ? windows.find((entry) => entry?.window_id === before)?.pid : undefined;
  if (Number.isSafeInteger(owner)) await attempt(call, "bring_to_front", { pid: owner, window_id: before });
}

const tooLong = (count) => failure(
  "type_text was not performed: on this Windows computer, text typed in the foreground goes in one character at a time so that each one lands, " +
  `and one call types at most ${MAX_PACED_CHARACTERS} characters; this text has ${count}. ` +
  `Type it in parts of at most ${MAX_PACED_CHARACTERS} characters, one type_text call after another.`);

const typedOnly = (done, total) => `Only the first ${done} of ${total} characters were typed; the rest were not sent.`;
const READ_AGAIN = "Read the field again with get_window_state before typing the rest.";

/** Types `args.text` through `call(name, args)`, which resolves to each tool result, and answers as the one call it was. */
export async function typeOneCharacterAtATime(call, args) {
  const units = typingUnits(withoutLeakedToolTags(args.text));
  if (units.length < 2) return attempt(call, "type_text", args);
  if (units.length > MAX_PACED_CHARACTERS) return tooLong(units.length);
  const desktop = desktopScope(args);
  const session = args.session === undefined ? {} : { session: args.session };
  let window = args.window_id;
  let giveBackTo = 0;
  let typed;
  let stopped;
  for (const [index, unit] of units.entries()) {
    if (!desktop) {
      const front = await inFront(call, args.pid, window);
      if (index === 0) {
        giveBackTo = front.before;
        window ??= front.target || undefined;
      } else if (!front.ok || front.before !== front.target) {
        // Whatever came to the front keeps it: the rest is not typed rather than fought for.
        if (front.ok) giveBackTo = front.before;
        stopped = { ...envelope(typed), isError: true, content: [{ type: "text", text:
          `${typedOnly(index, units.length)} The window being typed into was no longer in front, so typing stopped; someone may be using this computer. ${READ_AGAIN}` }] };
        break;
      }
    }
    // Later characters go where the first went, never to its element or point again: focusing those anew could move the caret.
    const later = desktop ? { scope: "desktop", ...session } : { pid: args.pid, window_id: window, delivery_mode: args.delivery_mode, ...session };
    const result = await attempt(call, "type_text", { ...(index === 0 ? args : later), text: unit });
    if (result.isError) {
      stopped = index === 0 ? result : { ...result, content: [
        { type: "text", text: `${typedOnly(index, units.length)} Typing the next one failed. ${READ_AGAIN} The failure:` },
        ...(Array.isArray(result.content) ? result.content : []),
      ] };
      break;
    }
    typed = result;
  }
  if (!desktop) await giveFrontBack(call, giveBackTo, window);
  if (stopped) return stopped;
  const said = desktop
    ? `Typed ${units.length} character(s) into the foreground application (scope:desktop), one at a time.`
    : `✅ Typed ${units.length} char(s) on pid ${args.pid} via SendInput (delivery_mode:foreground), one character at a time.`;
  // The last character's own answer keeps the driver's structured result, which a strict client holds to the tool's schema.
  return { ...typed, content: [{ type: "text", text: said }] };
}
