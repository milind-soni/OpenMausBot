// A stand-in for the bot's browser in fill_login tests: one happy-dom page answering the engine commands
// login-fill sends and taking typed text, keys and clicks like the input relay. It records every engine command, so a
// test can prove no secret went through one.
import { Window } from "happy-dom";

/** What the site does with a sent form: show another page (a sign-in that worked, or a next step), or stay and say why. */
export type SiteAnswer = { navigate: { url: string; html: string } } | { error: string } | null;

export class FakeLoginPage {
  window: Window;
  /** Every engine command, as its argument list. */
  readonly engineCalls: string[][] = [];
  /** Every text typed through the input relay. */
  readonly typed: string[] = [];
  /** Every key pressed and element clicked through the relay. */
  readonly pressed: string[] = [];
  readonly clicked: string[] = [];
  /** What the page's scripts saw: field name → the last value an input event carried. */
  readonly state: Record<string, string> = {};
  /** Each form the page sent, as field name → value. */
  readonly sent: Array<Record<string, string>> = [];
  /** The site's answer to a sent form; with none, the form goes nowhere. */
  answer: ((fields: Record<string, string>) => SiteAnswer) | null = null;
  /** Frames get the size a browser would lay them out at; happy-dom lays out nothing. */
  frameSize: { width: number; height: number } | null = null;
  /** The page's own script for a key pressed through the relay. */
  onKey: ((key: string) => void) | null = null;
  private submitting: unknown = null;
  streamEnabled = false;
  readonly streamPort = 19_977;

  constructor(url: string, html: string) {
    this.window = this.open(url, html);
  }

  private open(url: string, html: string): Window {
    const window = new Window({ url, settings: { disableJavaScriptEvaluation: false } });
    const frameSize = () => this.frameSize;
    const box = window.HTMLIFrameElement.prototype.getBoundingClientRect;
    window.HTMLIFrameElement.prototype.getBoundingClientRect = function (this: never) {
      const size = frameSize();
      return size ? { x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, ...size, toJSON: () => size } as never : box.call(this);
    };
    window.document.body.innerHTML = html;
    // After the page's own handlers: a form nobody's script kept goes to the site, never to happy-dom's own loader.
    window.addEventListener("submit", (event) => {
      if (!event.defaultPrevented) this.submitting = event.target;
      event.preventDefault();
    });
    window.document.addEventListener("input", (event) => {
      const target = event.target as unknown as { name?: string; id?: string; value?: string };
      this.state[target.name || target.id || "?"] = target.value ?? "";
    });
    return window;
  }

  navigate(url: string, html: string): void {
    this.window.dispatchEvent(new this.window.Event("beforeunload"));
    void this.window.happyDOM.close();
    this.window = this.open(url, html);
  }

  field(selector: string): { value: string } {
    return this.window.document.querySelector(selector) as unknown as { value: string };
  }

  /** What the engine answers: its `data`, or null for a stopped browser. */
  async engine(args: string[]): Promise<Record<string, unknown> | null> {
    this.engineCalls.push(args);
    if (args[0] === "get" && args[1] === "url") return { url: this.window.location.href };
    if (args[0] === "eval") return { result: this.window.eval(args[1]!) as unknown };
    if (args[0] === "stream" && args[1] === "status") return this.streamEnabled ? { enabled: true, port: this.streamPort } : { enabled: false };
    if (args[0] === "stream" && args[1] === "enable") { this.streamEnabled = true; return { enabled: true, port: this.streamPort }; }
    throw new Error(`unexpected engine command: ${args[0]}`);
  }

  /** `keyboard insertText` over the relay: into the focused field at its caret, with beforeinput and input events. */
  async insertText(text: string): Promise<void> {
    this.typed.push(text);
    const field = this.window.document.activeElement as unknown as { value: string; dispatchEvent(event: unknown): boolean } | null;
    if (!field || typeof field.value !== "string") return;
    const InputEvent = this.window.InputEvent;
    field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, data: text, inputType: "insertText" }));
    field.value += text;
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }

  /** A key at the focused element. Enter in a form's field sends the form when a browser would: it has a submit button,
   * or that field is its only one. */
  async press(key: string): Promise<void> {
    this.pressed.push(key);
    this.onKey?.(key);
    const field = this.window.document.activeElement as unknown as { form?: unknown } | null;
    const form = field?.form as unknown as { requestSubmit(): void; querySelectorAll(selector: string): ArrayLike<{ type?: string }> } | null | undefined;
    if (key !== "Enter" || !form) return;
    const buttons = Array.from(form.querySelectorAll("button, input[type=submit]")).filter((el) => el.type === "submit");
    if (buttons.length || form.querySelectorAll("input:not([type=hidden])").length === 1) form.requestSubmit();
    this.deliver();
  }

  /** A real click: the page's handlers run, and a submit button then sends its form unless they kept it. */
  async click(selector: string): Promise<void> {
    this.clicked.push(selector);
    const el = this.window.document.querySelector(selector) as unknown as { dispatchEvent(event: unknown): boolean } | null;
    if (!el) throw new Error(`Element not found: ${selector}`);
    el.dispatchEvent(new this.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    this.deliver();
  }

  private deliver(): void {
    const element = this.submitting as { querySelectorAll(selector: string): ArrayLike<{ name?: string; value?: string }> } | null;
    this.submitting = null;
    if (!element) return;
    const fields = Object.fromEntries(Array.from(element.querySelectorAll("input")).filter((el) => el.name).map((el) => [el.name!, el.value ?? ""]));
    this.sent.push(fields);
    const answer = this.answer?.(fields) ?? null;
    if (answer && "navigate" in answer) this.navigate(answer.navigate.url, answer.navigate.html);
    else if (answer && "error" in answer) this.window.document.body.insertAdjacentHTML("afterbegin", `<p role="alert">${answer.error}</p>`);
  }

  close(): void {
    void this.window.happyDOM.close();
  }
}

export const LOGIN_FORM = `
  <form action="/session" method="post">
    <label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
    <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
    <input type="hidden" name="csrf" value="token-not-a-secret">
    <button type="submit">Sign in</button>
  </form>
  <form role="search"><input name="q" type="search"></form>`;
