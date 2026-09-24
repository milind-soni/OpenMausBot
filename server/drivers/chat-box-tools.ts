import { isolatedRemoteCommand, runCommand, screenshotBox } from "../box.ts";
import type { SendTurnInput } from "../contracts.ts";
import { createControlClient, CONTROL_REFUSAL_PLAIN } from "../control-client.ts";

type Descriptor = NonNullable<NonNullable<SendTurnInput["integrations"]>["computer"]>;
const coordinate = { type: "integer", minimum: 0, maximum: 32767 };
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
const TOOLS = [
  tool("screenshot", "See the assigned cloud desktop at native pixel resolution."),
  tool("get_screen_size", "Get the cloud desktop width and height."),
  tool("click", "Click a point on the cloud desktop.", { x: coordinate, y: coordinate, button: { type: "string", enum: ["left", "middle", "right"] }, count: { type: "integer", minimum: 1, maximum: 3 } }, ["x", "y"]),
  tool("move", "Move the cloud mouse pointer.", { x: coordinate, y: coordinate }, ["x", "y"]),
  tool("drag", "Drag on the cloud desktop.", { x: coordinate, y: coordinate, to_x: coordinate, to_y: coordinate }, ["x", "y", "to_x", "to_y"]),
  tool("type_text", "Type Unicode text into the focused cloud application.", { text: { type: "string", maxLength: 4000 } }, ["text"]),
  tool("key_press", "Press an X11 key or shortcut.", { key: { type: "string", pattern: "^[A-Za-z0-9_+]+$", minLength: 1, maxLength: 100 } }, ["key"]),
  tool("scroll", "Scroll at a point on the cloud desktop.", { x: coordinate, y: coordinate, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 30 } }, ["x", "y", "direction"]),
  tool("open_url", "Request opening an HTTP or HTTPS URL in the cloud desktop browser; inspect the screen to confirm it loaded.", { url: { type: "string", pattern: "^https?://", maxLength: 2000 } }, ["url"]),
  tool("exec", "Run a shell command on the assigned cloud computer.", { command: { type: "string", minLength: 1, maxLength: 4000 } }, ["command"]),
];
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const buttons: Record<string, number> = { left: 1, middle: 2, right: 3 };
const scrollButtons: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };

/** Uses only the leased descriptor supplied by the harness. Schema validation
 * and user approval happen in the shared chat tool executor before this call. */
export class ChatBoxClient {
  private closed = false;
  private readonly control: ReturnType<typeof createControlClient>;
  private readonly descriptor: Descriptor;
  constructor(descriptor: Descriptor) {
    this.descriptor = descriptor;
    if (!descriptor.control?.url || !descriptor.control.token) throw new Error("Cloud computer control gate missing");
    this.control = createControlClient(descriptor.control);
  }
  async tools() { return TOOLS; }
  async close() { this.closed = true; }
  async call(_method: string, params: { name: string; arguments: Record<string, unknown> }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Cloud computer session closed");
    const state = await this.control.state(true);
    signal.throwIfAborted();
    if (this.closed) throw new Error("Cloud computer session closed");
    if (state.held || state.blockedReason) return { isError: true, content: [{ type: "text", text: state.blockedReason || CONTROL_REFUSAL_PLAIN }] };
    const { name, arguments: a } = params;
    const config = { box: { token: this.descriptor.token } };
    const id = this.descriptor.boxId;
    if (name === "screenshot") {
      const shot = await screenshotBox(config, "", id, { signal, nativeSize: true });
      signal.throwIfAborted();
      return { content: [{ type: "image", mimeType: "image/jpeg", data: shot.png }] };
    }
    const mouse = `xdotool mousemove --sync ${a.x} ${a.y}`;
    let command: string;
    switch (name) {
      case "get_screen_size": command = "xdotool getdisplaygeometry"; break;
      case "click": command = `${mouse} click --repeat ${a.count ?? 1} --delay 100 ${buttons[String(a.button ?? "left")]}`; break;
      case "move": command = mouse; break;
      case "drag": command = `${mouse} mousedown 1 mousemove --sync ${a.to_x} ${a.to_y} mouseup 1`; break;
      case "type_text": command = `printf %s ${quote(Buffer.from(String(a.text)).toString("base64"))} | base64 -d | xclip -selection clipboard && xdotool key --clearmodifiers ctrl+v`; break;
      case "key_press": command = `xdotool key --clearmodifiers ${quote(String(a.key))}`; break;
      case "scroll": command = `${mouse} click --repeat ${a.amount ?? 3} --delay 80 ${scrollButtons[String(a.direction)]}`; break;
      case "open_url": command = `nohup xdg-open ${quote(String(a.url))} >/dev/null 2>&1 </dev/null &`; break;
      case "exec": command = String(a.command); break;
      default: throw new Error("Unknown cloud computer tool");
    }
    const result = await runCommand(config, id, isolatedRemoteCommand(command), { signal });
    signal.throwIfAborted();
    if (name === "open_url" && result.ok) return { content: [{ type: "text", text: "Browser launch requested. Page loading is not confirmed; inspect the screen before continuing." }] };
    return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result) }] };
  }
}
