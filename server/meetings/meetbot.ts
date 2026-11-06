// The meeting bot that runs on a bot's cloud computer: headed Chrome joins a call as a guest, the call's audio goes to a
// PulseAudio null sink of its own, ffmpeg turns it into 16 kHz PCM for a speech-to-text stream, and speaker names come
// from the call page's active-speaker UI. It imports only Node's own modules, because the file itself is what is copied
// to the computer (Node 24 there strips the types of the .ts source; a release copies the bundled .js).
//
// Parts of the Google Meet and Microsoft Teams page handling (lobby, refusal and removal wording, the chat panel, the
// speaking indicators, Teams' display-name rule) adapt Vexa, https://github.com/vexa-ai/vexa (core/meetings/modules/join
// and gmeet-capture, teams-capture at 6b26f7b), Copyright 2025-2026 Vexa.ai Inc. and the Vexa contributors, used under
// the Apache License, Version 2.0 (third_party/vexa/LICENSE).
//
// Contract with server/meetings/engine.ts, all inside one meeting folder <dir>:
//   node meetbot run <dir>                      reads <dir>/config.json (MeetbotConfig) and runs the meeting to its end
//   node meetbot wait <dir> <afterSeq> <secs>   prints {events, state, alive} once there are events after afterSeq, or at secs
//   node meetbot put <dir> <base64 JSON>        hands the running bot one command: {kind:"chat",id,text} | {kind:"leave"} |
//                                               {kind:"token",token}
// Every event is one line of <dir>/events.jsonl: {seq, at, type, ...}; every transcript line also goes to transcript.jsonl.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MeetbotPlatform = "meet" | "teams" | "jitsi";
export type MeetbotStt = { kind: "eleven"; token: string; language?: string; rotateMs?: number } | { kind: "whisper" };

export interface MeetbotConfig {
  url: string;
  platform: MeetbotPlatform;
  name: string;
  /** Posted in the meeting chat before anything is captured. Without it landing, the bot leaves and records nothing. */
  consent: string;
  stt: MeetbotStt;
  maxMs: number;
  lobbyMs: number;
  aloneMs: number;
  speakerLagMs?: number;
  chrome?: string;
}

export type EndReason = "left" | "stop_requested" | "meeting_ended" | "removed" | "denied" | "lobby_timeout" | "guests_blocked"
  | "not_found" | "join_failed" | "consent_failed" | "alone" | "max_length" | "crashed";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function eventLog(dir: string) {
  const file = join(dir, "events.jsonl");
  let seq = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  return (type: string, data: Record<string, unknown> = {}) => {
    seq += 1;
    appendFileSync(file, JSON.stringify({ seq, at: Date.now(), type, ...data }) + "\n");
    return seq;
  };
}

export function readEvents(dir: string, after: number, limit = 300): Array<Record<string, unknown> & { seq: number }> {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  const out: Array<Record<string, unknown> & { seq: number }> = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.seq > after) out.push(event);
    } catch { /* a line being written */ }
    if (out.length >= limit) break;
  }
  return out;
}

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("meetbot");
  } catch {
    return false;
  }
}

/** Removes a meeting name's characters Microsoft Teams refuses in a guest name (Join stays disabled), per Vexa's rule. */
export function teamsSafeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}\p{M} \-'._@]/gu, " ").replace(/\s+/g, " ").trim() || "Notes";
}

export function noteQuestion(text: string): { stop: boolean; question: string } | null {
  const match = /(?:^|[^\w@])@notes\b[\s,:]*(.*)$/is.exec(text);
  if (!match) return null;
  const rest = match[1].trim();
  return /^(stop|leave)\b/i.test(rest) ? { stop: true, question: "" } : { stop: false, question: rest };
}

export interface Word { w: string; s: number; e: number; spk?: string | null }

/** Each word goes to whoever the page showed speaking at its midpoint plus the page's lag; runs of one speaker are a line. */
export function attribute(words: Word[], timeline: Array<{ at: number; name: string | null }>, lagMs: number) {
  const at = (t: number) => {
    let name: string | null = null;
    for (const entry of timeline) {
      if (entry.at <= t) name = entry.name ?? name;
      else break;
    }
    return name;
  };
  const runs: Array<{ speaker: string | null; words: Word[] }> = [];
  for (const word of words) {
    const speaker = at((word.s + word.e) / 2 + lagMs);
    if (runs.length && runs.at(-1)!.speaker === speaker) runs.at(-1)!.words.push(word);
    else runs.push({ speaker, words: [word] });
  }
  return runs.map((run) => ({ speaker: run.speaker, text: run.words.map((w) => w.w).join(" ").replace(/\s+([,.?!;:])/g, "$1").trim(), start: run.words[0].s, end: run.words.at(-1)!.e }))
    .filter((line) => line.text);
}

/** Runs inside the call page; it must close over nothing, since its source text is what is sent there. */
export function pageOp(a: any): any {
  const page = globalThis as any;
  const document = page.document, location = page.location, getComputedStyle = page.getComputedStyle, getSelection = page.getSelection;
  const shown = (el: any): boolean => {
    if (!el) return false;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const all = (css: string, root: any = document) => Array.from(root.querySelectorAll(css)) as any[];
  const words = (el: any) => `${el.getAttribute("aria-label") ?? ""} ${(el.textContent ?? "").replace(/\s+/g, " ").trim()}`.trim();
  const ACTIONABLE = 'button,[role="button"],a,[role="radio"],[role="switch"],[role="checkbox"],[role="menuitem"],input,textarea,[contenteditable="true"]';
  const find = (spec: { css?: string; text?: string; within?: string; disabled?: boolean }, visible = true): any => {
    const roots = spec.within ? all(spec.within).filter(shown) : [document];
    for (const root of roots) {
      for (const el of all(spec.css ?? ACTIONABLE, root)) {
        if (visible && !shown(el)) continue;
        const off = el.disabled === true || el.getAttribute("aria-disabled") === "true";
        if (off !== (spec.disabled === true)) continue;
        if (spec.text && !new RegExp(spec.text, "i").test(words(el))) continue;
        return el;
      }
    }
    return null;
  };
  const present = (css: string) => document.querySelector(css) !== null;
  const body = () => (document.body?.innerText ?? "").slice(0, 30_000);
  const said = (pattern: string) => new RegExp(pattern, "i").test(body());
  const unique = (list: string[]) => [...new Set(list.map((name) => name.replace(/\s+/g, " ").trim()).filter(Boolean))];
  const self = String(a.self ?? "").toLowerCase();
  const notSelf = (name: string) => name && !name.toLowerCase().includes(self) && !/^(you|me)$/i.test(name) && !/\(you\)$/i.test(name);

  const MEET_SPEAKING = '.Oaajhc,.HX2H7,.wEsLMd,.OgVli,[data-audio-level]:not([data-audio-level="0"])';
  const meetName = (tile: any) => tile.getAttribute("data-self-name") ?? tile.querySelector("[data-self-name]")?.getAttribute("data-self-name")
    ?? tile.querySelector("span.notranslate")?.textContent?.trim() ?? "";
  const teamsName = (el: any) => (el.closest("[data-stream-type][data-tid]")?.getAttribute("data-tid")
    ?? el.closest('[data-tid*="participant"]')?.getAttribute("aria-label") ?? "").trim();

  switch (a.op) {
    case "url": return location.href;
    case "point": {
      const el = find(a.spec);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const box = el.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), label: words(el).slice(0, 80) };
    }
    case "click": {
      const el = find(a.spec, false);
      if (!el) return false;
      el.click();
      return true;
    }
    case "focus": {
      const el = find(a.spec);
      if (!el) return false;
      el.focus();
      if (typeof el.select === "function") el.select();
      else {
        const range = document.createRange();
        range.selectNodeContents(el);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
      return true;
    }
    case "value": {
      const el = find(a.spec);
      return el ? (el.value ?? el.textContent ?? "") : null;
    }
    case "probe": {
      if (a.platform === "jitsi") {
        const tiles = all('[id^="participant_"]').filter((tile) => /^participant_[^_]+$/.test(tile.id));
        return {
          inMeeting: present('[aria-label="Leave the meeting"]'),
          lobby: said("asking to join|knocking|waiting for (the|a) moderator|wait until the host|lobby"),
          denied: said("request to join (was|has been) (denied|rejected)|denied your request|declined"),
          removed: said("removed (you )?from the (meeting|conference)|you have been kicked|kicked out"),
          ended: said("the meeting (has )?ended|meeting ended|you have left|conference has ended"),
          blocked: said("password required|this conference requires a password"),
          others: tiles.length,
          names: unique(tiles.map((tile) => tile.querySelector('.displayname, [id$="_name"]')?.textContent ?? "")),
        };
      }
      if (a.platform === "meet") {
        const tiles = all("[data-participant-id]");
        const ids = new Set(tiles.map((tile) => tile.getAttribute("data-participant-id")));
        const names = unique(tiles.map(meetName)).filter(notSelf);
        const badge = all('button[aria-label^="People" i], button[aria-label*="participants" i]').map(words).join(" ").match(/\b(\d{1,4})\b/);
        const total = Math.max(ids.size, badge ? Number(badge[1]) : 0);
        return {
          inMeeting: present('button[aria-label*="Leave call" i], button[aria-label*="leave the call" i], button[jsname="CQylAd"]'),
          lobby: said("asking to be let in|lets you in|let you in|waiting for the host|someone in the call"),
          knockExpired: said("no one responded to your request"),
          denied: said("denied your request|weren.t allowed to join|not allowed to join|your request to join was denied"),
          removed: said("removed you from the (meeting|call)|you.ve been removed|you have been removed"),
          ended: said("you left the meeting|you.ve left the (call|meeting)|the call (has )?ended|meeting (has )?ended|call ended"),
          blocked: said("can.t join this video call|can.t join this call|cannot join this call|not allowed to join this video call"),
          notFound: said("check your meeting code|meeting not found|invalid video call name|this meeting link is not valid"),
          others: total > 0 ? Math.max(0, total - 1) : names.length || null,
          names,
        };
      }
      const host = location.hostname;
      const roster = all('#roster-button, button[data-tid="roster-button"], button[aria-label^="People" i]').map(words).join(" ").match(/\b(\d{1,4})\b/);
      const streams = all("[data-stream-type][data-tid]");
      const names = unique(streams.map((el) => el.getAttribute("data-tid") ?? "")).filter(notSelf);
      return {
        inMeeting: present('#hangup-button, button[data-tid="hangup-main-btn"], button[data-tid="call-hangup"], button[aria-label="Leave"], button[aria-label^="Leave (" i]'),
        lobby: said("let you in shortly|waiting for someone to let you in|you.re in the lobby|know you.re waiting|wait for someone to admit you|request to join has been sent"),
        denied: said("you were denied|denied (entry|access)|request denied|admission denied"),
        removed: said("you.ve been removed|you have been removed|removed from this meeting"),
        ended: said("the meeting has ended|meeting ended|call ended|you left the meeting|you.ve left the meeting"),
        blocked: /^login\.(microsoftonline|live)\.com$/.test(host) || said("sign in to join this meeting|only people with .* can join|anonymous users can.t join|need to sign in"),
        notFound: said("meeting not found|this meeting link isn.t valid|we couldn.t find the meeting"),
        others: roster ? Math.max(0, Number(roster[1]) - 1) : names.length || null,
        names,
      };
    }
    case "chat": {
      if (a.platform === "jitsi") {
        return all(".chatmessage").map((el, i) => {
          const from = (el.querySelector(".display-name")?.textContent ?? "").trim();
          const text = (el.querySelector(".usermessage")?.textContent ?? "").replace(/^.*?says:\s*/s, "").replace(/\s*\d{1,2}:\d{2}\s*$/, "").trim();
          return { key: `${i}|${from}|${text}`, from, text };
        });
      }
      if (a.platform === "meet") {
        return all("[data-message-id]").map((node) => {
          const text = (node.querySelector('[jsname="dTKtvb"], [data-message-text]') ?? node).textContent?.replace(/\s+/g, " ").trim() ?? "";
          let from = "";
          for (let cur: any = node, i = 0; cur && i < 6 && !from; cur = cur.parentElement, i++) {
            from = cur.getAttribute("data-sender-name") ?? (cur === node ? "" : cur.querySelector(".poVWob, .YTbUzc, [data-sender-name]")?.textContent ?? "");
          }
          return { key: `id:${node.getAttribute("data-message-id")}`, from: from.trim(), text };
        });
      }
      return all('[data-tid="chat-pane-message"], div[data-mid]').map((node, i) => {
        const text = (node.querySelector('[data-tid="messageBodyContent"], [id^="content-"]')?.textContent ?? "").replace(/\s+/g, " ").trim();
        let from = node.querySelector('[data-tid="message-author-name"]')?.textContent ?? "";
        for (let cur = node.parentElement, j = 0; cur && j < 4 && !from; cur = cur.parentElement, j++) from = cur.querySelector('[data-tid="message-author-name"]')?.textContent ?? "";
        return { key: node.getAttribute("data-mid") ?? `${i}|${from}|${text}`, from: from.trim(), text };
      });
    }
    case "speaker": {
      if (a.platform === "jitsi") {
        const el = document.querySelector('[class*="activeSpeaker"], .active-speaker, .dominant-speaker');
        const named = el?.querySelector('.displayname, [class*="displayName"], .videocontainer__name, span[id$="_name"]')?.textContent
          ?? el?.closest('[id^="participant_"]')?.querySelector('[id$="_name"], .displayname')?.textContent;
        return named?.trim() || null;
      }
      if (a.platform === "meet") {
        const tile = all("[data-participant-id]").find((t) => t.matches(MEET_SPEAKING) || t.querySelector(MEET_SPEAKING));
        const name = tile ? meetName(tile) : "";
        return notSelf(name) ? name : null;
      }
      const outline = all('[data-tid="voice-level-stream-outline"]').find((el) =>
        /speaking|vdi-frame-occlusion|active/i.test(el.className.toString()) || el.getAttribute("data-is-speaking") === "true");
      const name = outline ? teamsName(outline) : "";
      return notSelf(name) ? name : null;
    }
    default: return null;
  }
}

class Cdp {
  private next = 0;
  private waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  closed = false;
  private socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = message.id ? this.waiting.get(message.id) : undefined;
      if (!pending) return;
      this.waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.waiting.values()) pending.reject(new Error("the browser closed"));
      this.waiting.clear();
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("could not reach the browser")), { once: true });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("the browser closed"));
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`${method} did not answer`));
      }, 30_000).unref();
    });
  }

  async page(a: Record<string, unknown>): Promise<any> {
    const result = await this.send("Runtime.evaluate", { expression: `(${pageOp.toString()})(${JSON.stringify(a)})`, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }

  close(): void {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

type Probe = { inMeeting: boolean; lobby: boolean; knockExpired?: boolean; denied: boolean; removed: boolean; ended: boolean; blocked: boolean; notFound?: boolean; /** Null when the page shows no count: the alone rule then never fires. */ others: number | null; names: string[] };
type Spec = { css?: string; text?: string; within?: string; disabled?: boolean };

/** One call page, driven through the DevTools protocol with real (trusted) mouse and key events. */
export class CallPage {
  private cdp: Cdp;
  readonly platform: MeetbotPlatform;
  readonly self: string;
  constructor(cdp: Cdp, platform: MeetbotPlatform, self: string) {
    this.cdp = cdp;
    this.platform = platform;
    this.self = self;
  }
  op(a: Record<string, unknown>) { return this.cdp.page({ platform: this.platform, self: this.self, ...a }); }
  probe(): Promise<Probe> { return this.op({ op: "probe" }); }
  exists(spec: Spec): Promise<boolean> { return this.op({ op: "point", spec }).then(Boolean); }

  async click(spec: Spec): Promise<boolean> {
    const point = await this.op({ op: "point", spec });
    if (!point) return false;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    }
    return true;
  }

  async type(spec: Spec, text: string): Promise<boolean> {
    if (!(await this.op({ op: "focus", spec }))) return false;
    await this.cdp.send("Input.insertText", { text });
    return true;
  }

  async enter(): Promise<void> {
    for (const type of ["keyDown", "keyUp"]) {
      await this.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
    }
  }

  async goto(url: string): Promise<void> { await this.cdp.send("Page.navigate", { url }); }
  async screenshot(file: string): Promise<void> {
    const shot = await this.cdp.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot?.data) writeFileSync(file, Buffer.from(shot.data, "base64"));
  }
}

interface Adapter {
  url(link: string): string;
  /** Fills the pre-join screen and asks to join; the lobby wait is the caller's. */
  prejoin(page: CallPage, name: string, until: number): Promise<void | EndReason>;
  /** Clicks through notices that sit over a call just joined. */
  settle(page: CallPage): Promise<void>;
  chatToggle: Spec;
  composer: Spec;
  leave: Spec;
}

const KEEP_MUTED: Spec[] = [
  { text: "^turn off microphone|^mute (mic|microphone)" },
  { text: "^turn off camera|^turn camera off|^turn off video|^turn video off" },
];

export const ADAPTERS: Record<MeetbotPlatform, Adapter> = {
  jitsi: {
    url: (link) => `${link.split("#")[0]}#config.startWithAudioMuted=true&config.startWithVideoMuted=true&config.disableDeepLinking=true`,
    async prejoin(page, name, until) {
      while (Date.now() < until && !(await page.exists({ css: "#premeeting-name-input" }))) {
        if ((await page.probe()).inMeeting) return;
        await sleep(500);
      }
      if (!(await page.type({ css: "#premeeting-name-input" }, name))) return "join_failed";
      await sleep(300);
      if (!(await page.click({ css: '[aria-label="Join meeting"]' }))) await page.enter();
    },
    async settle() {},
    chatToggle: { css: '[aria-label="Open chat"]' },
    composer: { css: "#chat-input-messagebox" },
    leave: { css: '[aria-label="Leave the meeting"]' },
  },
  meet: {
    url: (link) => {
      const url = new URL(link);
      if (!url.searchParams.has("hl")) url.searchParams.set("hl", "en");
      return url.toString();
    },
    async prejoin(page, name, until) {
      const nameField: Spec = { css: 'input[type="text"][aria-label="Your name"], input[jsname][type="text"], input[placeholder*="name" i]' };
      while (Date.now() < until) {
        const probe = await page.probe();
        if (probe.notFound) return "not_found";
        if (probe.blocked) return "guests_blocked";
        if (await page.exists(nameField)) break;
        await sleep(1_000);
      }
      if (!(await page.type(nameField, name))) return "join_failed";
      for (const toggle of KEEP_MUTED) await page.click(toggle);
      await sleep(500);
      if (!(await page.click({ css: "button", text: "^(ask to join|join now)\\b" }))) await page.enter();
    },
    async settle(page) {
      await page.click({ within: '[role="dialog"],[role="alertdialog"]', css: "button", text: "^join now\\b" });
      for (let i = 0; i < 3; i++) if (!(await page.click({ within: '[role="dialog"],[role="alertdialog"]', css: "button", text: "^(got it|dismiss|close|ok)\\b" }))) break;
    },
    chatToggle: { css: 'button[data-panel-id="2"], button[aria-label*="chat" i]' },
    composer: { css: 'textarea, [contenteditable="true"][role="textbox"]' },
    leave: { css: 'button[aria-label*="Leave call" i]' },
  },
  teams: {
    url: (link) => link,
    async prejoin(page, name, until) {
      const nameField: Spec = { css: 'input[data-tid="prejoin-display-name-input"], input[placeholder*="name" i]' };
      while (Date.now() < until) {
        const probe = await page.probe();
        if (probe.blocked) return "guests_blocked";
        if (probe.notFound) return "not_found";
        await page.click({ css: "button,a", text: "^continue on this browser$|join on the web instead" });
        await page.click({ css: "button", text: "continue without audio or video" });
        if (await page.exists(nameField)) break;
        await sleep(1_000);
      }
      if (!(await page.type(nameField, teamsSafeName(name)))) return "join_failed";
      await page.click({ text: "^computer audio" });
      for (const toggle of [...KEEP_MUTED, { css: '[data-tid="toggle-video"][aria-checked="true"]' }, { css: '[data-tid="toggle-mute"][aria-checked="true"]' }]) await page.click(toggle);
      await sleep(500);
      const join: Spec = { css: "button", text: "^join now\\b" };
      for (let i = 0; i < 10 && !(await page.exists(join)); i++) await sleep(1_000);
      if (!(await page.click(join))) return "join_failed";
    },
    async settle(page) {
      for (let i = 0; i < 3; i++) if (!(await page.click({ within: '[role="dialog"],[role="alertdialog"]', css: "button", text: "^(got it|dismiss|close|ok)\\b" }))) break;
    },
    chatToggle: { css: '#chat-button, button[data-tid="chat-button"], button[aria-label^="chat" i]' },
    composer: { css: '[data-tid="ckeditor"] [contenteditable="true"], [data-tid="ckeditor"][contenteditable="true"], div[contenteditable="true"][role="textbox"]' },
    leave: { css: '#hangup-button, button[data-tid="hangup-main-btn"], button[data-tid="call-hangup"]' },
  },
};

export async function sendChat(page: CallPage, adapter: Adapter, text: string): Promise<boolean> {
  if (!(await page.exists(adapter.composer))) {
    if (!(await page.op({ op: "click", spec: adapter.chatToggle }))) await page.click(adapter.chatToggle);
    for (let i = 0; i < 20 && !(await page.exists(adapter.composer)); i++) await sleep(250);
  }
  if (!(await page.type(adapter.composer, text))) return false;
  await sleep(150);
  await page.enter();
  await sleep(400);
  const left = await page.op({ op: "value", spec: adapter.composer });
  return typeof left !== "string" || !left.includes(text.slice(0, 40));
}

/** What the session needs from the outside world, so the order of its steps can be checked without a browser. */
export interface SessionParts {
  config: MeetbotConfig;
  emit(type: string, data?: Record<string, unknown>): void;
  page: CallPage;
  adapter: Adapter;
  /** Starts capture and speech-to-text; called only once the consent line is in the meeting chat. */
  startCapture(): Promise<{ stop(): Promise<void> }>;
  /** The next command handed in with `put`, or null. */
  nextCommand(): { kind: string; [key: string]: unknown } | null;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}

/** Joins, posts the consent line, then captures until the meeting ends for one of the EndReasons. */
export async function runSession(parts: SessionParts): Promise<EndReason> {
  const { config, emit, page, adapter } = parts;
  const now = parts.now ?? Date.now;
  const pause = parts.pause ?? sleep;
  emit("phase", { phase: "joining" });
  await page.goto(adapter.url(config.url));
  const lobbyUntil = now() + config.lobbyMs;
  const refused = await adapter.prejoin(page, config.name, now() + 90_000);
  if (refused) return refused;
  let knocks = 1;
  let lobbyShown = false;
  for (;;) {
    const probe = await page.probe();
    if (probe.inMeeting) break;
    if (probe.denied) return "denied";
    if (probe.notFound) return "not_found";
    if (probe.blocked) return "guests_blocked";
    if (probe.knockExpired && knocks < 5 && (await page.click({ css: "button", text: "ask to join again|ask to join" }))) knocks += 1;
    if (!lobbyShown) {
      lobbyShown = true;
      emit("phase", { phase: "lobby" });
    }
    const command = parts.nextCommand();
    if (command?.kind === "leave") return "left";
    if (now() > lobbyUntil) return "lobby_timeout";
    await pause(1_000);
  }
  const joinedAt = now();
  await adapter.settle(page);
  emit("phase", { phase: "in_meeting" });

  let consented = false;
  for (let attempt = 0; attempt < 4 && !consented; attempt++) {
    consented = await sendChat(page, adapter, config.consent).catch(() => false);
    if (!consented) await pause(3_000);
  }
  if (!consented) return "consent_failed";
  emit("consent", { text: config.consent });
  const capture = await parts.startCapture();

  const sent = new Set<string>([config.consent]);
  const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const selfNames = [config.name, teamsSafeName(config.name)].map(flat);
  const mine = (from: string) => !from || /^you$/i.test(from.trim()) || selfNames.some((name) => flat(from).includes(name));
  /** A platform may show our own line under another sender label, trimmed or with its time: never read it as a question. */
  const ours = (text: string) => [...sent].some((line) => flat(text) === flat(line) || flat(text).includes(flat(line).slice(0, 60)));
  const seen = new Set<string>();
  let primed = false;
  let lastOthers: number | null = -1;
  let lastNames = "";
  let aloneSince: number | null = null;
  let reason: EndReason | null = null;
  try {
    while (!reason) {
      const probe = await page.probe();
      if (!probe.inMeeting) {
        await pause(5_000);
        const again = await page.probe();
        if (!again.inMeeting) reason = again.removed ? "removed" : "meeting_ended";
      }
      if (reason) break;
      const names = probe.names.join("|");
      if (probe.others !== lastOthers || names !== lastNames) {
        lastOthers = probe.others;
        lastNames = names;
        if (probe.others !== null) emit("participants", { others: probe.others, names: probe.names });
      }
      aloneSince = probe.others === null || probe.others > 0 ? null : aloneSince ?? now();
      if (aloneSince !== null && now() - aloneSince > config.aloneMs) reason = "alone";
      if (now() - joinedAt > config.maxMs) reason = "max_length";

      const lines: Array<{ key: string; from: string; text: string }> = await page.op({ op: "chat" }).catch(() => []);
      for (const line of lines) {
        if (!line.text || seen.has(line.key)) continue;
        seen.add(line.key);
        if (!primed || mine(line.from) || ours(line.text)) continue;
        emit("chat", { from: line.from, text: line.text });
        const asked = noteQuestion(line.text);
        if (asked?.stop) {
          const bye = "OK, leaving now. Nothing after this point is kept.";
          sent.add(bye);
          await sendChat(page, adapter, bye).catch(() => false);
          reason = "stop_requested";
        } else if (asked?.question) emit("question", { from: line.from, text: asked.question });
      }
      primed = true;

      for (let command = parts.nextCommand(); command && !reason; command = parts.nextCommand()) {
        if (command.kind === "leave") reason = "left";
        else if (command.kind === "chat" && typeof command.text === "string") {
          sent.add(command.text);
          const ok = await sendChat(page, adapter, command.text).catch(() => false);
          emit("sent", { id: command.id, ok, ...(ok ? {} : { error: "The message did not appear in the meeting chat." }) });
        }
      }
      if (!reason) await pause(1_000);
    }
  } finally {
    await capture.stop();
  }
  return reason;
}

function nullSink(dir: string): { sink: string; unload(): void } {
  const sink = `meetbot_${process.pid}`;
  const module = execFileSync("pactl", ["load-module", "module-null-sink", `sink_name=${sink}`, `sink_properties=device.description=${sink}`]).toString().trim();
  writeFileSync(join(dir, "sink-module"), module);
  return { sink, unload: () => { try { execFileSync("pactl", ["unload-module", module]); } catch { /* already gone */ } } };
}

async function launchChrome(dir: string, config: MeetbotConfig, sink: string): Promise<{ chrome: ChildProcess; cdp: Cdp }> {
  const media = join(dir, "media");
  mkdirSync(media, { recursive: true });
  const silence = join(media, "silence.wav"), black = join(media, "black.y4m");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-t", "5", "-i", "anullsrc=r=48000:cl=mono", silence]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=5", "-frames:v", "5", "-pix_fmt", "yuv420p", black]);
  const profile = join(dir, "profile");
  const [width, height] = config.platform === "jitsi" ? [800, 600] : [1280, 800];
  const chrome = spawn(config.chrome ?? "/usr/bin/google-chrome", [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", `--window-size=${width},${height}`,
    "--disable-blink-features=AutomationControlled", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${silence}`, `--use-file-for-fake-video-capture=${black}`, "--autoplay-policy=no-user-gesture-required",
    "--lang=en-US", "--disable-features=Translate", "about:blank",
  ], { env: { ...process.env, PULSE_SINK: sink, DISPLAY: process.env.DISPLAY ?? ":0" }, stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(200);
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  let target: any;
  for (let i = 0; i < 50 && !target; i++) {
    const targets: any[] = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json() as Promise<any[]>).catch(() => []);
    target = targets.find((t: any) => t.type === "page");
    if (!target) await sleep(200);
  }
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { chrome, cdp };
}

type Sink = (chunk: Buffer) => void;

/** One speech-to-text stream; a closed one asks the server for a fresh token and keeps the audio until it comes. */
function sttStream(config: MeetbotConfig, emit: SessionParts["emit"], takeToken: () => string | null, onWords: (words: Word[]) => void, log: (line: string) => void) {
  const stt = config.stt;
  const rotateMs = stt.kind === "eleven" ? stt.rotateMs ?? 0 : 0;
  let token: string | null = stt.kind === "whisper" ? null : stt.token;
  let socket: WebSocket | null = null;
  let connecting: WebSocket | null = null;
  let draining: WebSocket | null = null;
  const senders = new Map<WebSocket, (chunk: Buffer, at: number) => void>();
  let openedAt = 0;
  let asked = false;
  let stopped = false;
  const backlog: Array<{ at: number; chunk: Buffer }> = [];
  let backlogBytes = 0;

  const open = (fresh: string) => {
    const qs = new URLSearchParams({ model_id: "scribe_v2_realtime", audio_format: "pcm_16000", commit_strategy: "vad", include_timestamps: "true",
      vad_silence_threshold_secs: "0.6", token: fresh, ...(stt.kind === "eleven" && stt.language ? { language_code: stt.language } : {}) });
    const next = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs}`);
    connecting = next;
    let start = 0;
    senders.set(next, (chunk, at) => {
      if (!start) start = at;
      next.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: chunk.toString("base64"), commit: false, sample_rate: 16000 }));
    });
    next.addEventListener("open", () => {
      if (connecting === next) connecting = null;
      const old = socket;
      if (old) {
        draining = old;
        commit(old);
        setTimeout(() => { try { old.close(); } catch { /* closed */ } }, 4_000).unref();
      }
      socket = next;
      openedAt = Date.now();
      asked = false;
      emit("stt", { status: "connected" });
      for (const { at, chunk } of backlog.splice(0)) senders.get(next)!(chunk, at);
      backlogBytes = 0;
    });
    next.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data));
      if (data.message_type === "committed_transcript_with_timestamps") {
        const words = (data.words ?? []).filter((w: any) => w.type !== "spacing" && w.text?.trim())
          .map((w: any) => ({ w: w.text, s: start + w.start * 1000, e: start + w.end * 1000 }));
        if (words.length) onWords(words);
      } else if (data.message_type && /error/i.test(data.message_type)) log(`stt ${data.message_type}: ${String(data.error ?? data.message ?? "").slice(0, 200)}`);
    });
    next.addEventListener("close", (event) => {
      senders.delete(next);
      if (draining === next) draining = null;
      const lost = socket === next || connecting === next;
      if (socket === next) socket = null;
      if (connecting === next) connecting = null;
      if (lost && !stopped) {
        log(`stt closed ${event.code} ${String(event.reason).slice(0, 120)}`);
        emit("stt", { status: "reconnecting" });
        need();
      }
    });
    next.addEventListener("error", () => log("stt socket error"));
  };
  const commit = (ws: WebSocket) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16000 }));
  };
  const need = () => {
    if (asked) return;
    asked = true;
    emit("need_token", {});
  };
  if (token) open(token);
  const write: Sink = (chunk) => {
    const at = Date.now() - chunk.length / 32;
    const fresh = takeToken();
    if (fresh) open(fresh);
    if (rotateMs && socket && !connecting && Date.now() - openedAt > rotateMs) need();
    if (socket?.readyState === WebSocket.OPEN) senders.get(socket)?.(chunk, at);
    else {
      backlog.push({ at, chunk });
      backlogBytes += chunk.length;
      while (backlogBytes > 32_000 * 120) backlogBytes -= backlog.shift()!.chunk.length;
      if (!socket && !connecting) need();
    }
  };
  return {
    write,
    async stop() {
      stopped = true;
      for (const ws of [socket, draining]) if (ws) commit(ws);
      await sleep(2_500);
      for (const ws of [socket, draining]) try { ws?.close(); } catch { /* closed */ }
    },
  };
}

const WHISPER_WORKER = String.raw`
import json, sys
import numpy as np
from faster_whisper import WhisperModel
model = WhisperModel("small.en", device="cpu", compute_type="int8")
FRAME, THRESH, END_SIL, MAX_FRAMES, PAD = 960, 300.0, 20, 500, 10
pos, ring, utt, start, silent, buf = 0, [], [], None, 0, b""
def flush(s, e, pcm):
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segs, _ = model.transcribe(audio, language="en", beam_size=1, condition_on_previous_text=False, word_timestamps=True)
    words = [{"w": w.word.strip(), "s": w.start, "e": w.end} for seg in segs for w in (seg.words or [])]
    print(json.dumps({"start_byte": s, "words": words}), flush=True)
for chunk in iter(lambda: sys.stdin.buffer.read(FRAME * 4), b""):
    buf += chunk
    while len(buf) >= FRAME:
        f, buf = buf[:FRAME], buf[FRAME:]
        rms = float(np.sqrt(np.mean(np.frombuffer(f, dtype=np.int16).astype(np.float32) ** 2)))
        if start is None:
            ring = (ring + [f])[-PAD:]
            if rms > THRESH:
                start, utt, silent = pos - FRAME * (len(ring) - 1), list(ring), 0
        else:
            utt.append(f)
            silent = silent + 1 if rms <= THRESH else 0
            if silent >= END_SIL or len(utt) >= MAX_FRAMES:
                flush(start, pos + FRAME, b"".join(utt))
                start, utt, ring = None, [], []
        pos += FRAME
`;

/** Speech-to-text on the computer itself, for a person with no speech key: faster-whisper, installed on first use. */
function whisperStream(emit: SessionParts["emit"], onWords: (words: Word[]) => void, log: (line: string) => void) {
  const home = join(process.env.HOME ?? "/tmp", ".mausbot-meet");
  const python = join(home, "venv", "bin", "python");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "whisper_worker.py"), WHISPER_WORKER);
  let worker: ChildProcess | null = null;
  let startedAt = 0;
  const queue: Buffer[] = [];
  const ready = (async () => {
    if (!existsSync(python)) {
      emit("stt", { status: "installing" });
      await new Promise<void>((resolve, reject) => {
        const install = spawn("bash", ["-c", `python3 -m venv ${JSON.stringify(join(home, "venv"))} && ${JSON.stringify(join(home, "venv", "bin", "pip"))} install -q faster-whisper numpy`], { stdio: "ignore" });
        install.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`installing local speech-to-text failed (${code})`))));
      });
    }
    worker = spawn(python, [join(home, "whisper_worker.py")], { stdio: ["pipe", "pipe", "ignore"] });
    let pending = "";
    worker.stdout!.on("data", (data) => {
      pending += data;
      for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        try {
          const out = JSON.parse(line);
          const base = startedAt + out.start_byte / 32;
          onWords(out.words.map((w: any) => ({ w: w.w, s: base + w.s * 1000, e: base + w.e * 1000 })));
        } catch { log(`whisper: ${line.slice(0, 200)}`); }
      }
    });
    emit("stt", { status: "connected" });
    for (const chunk of queue.splice(0)) worker.stdin!.write(chunk);
  })().catch((error: Error) => emit("stt", { status: "failed", detail: error.message }));
  return {
    write(chunk: Buffer) {
      if (!startedAt) startedAt = Date.now() - chunk.length / 32;
      if (worker) worker.stdin!.write(chunk);
      else if (queue.length < 4_000) queue.push(chunk);
    },
    async stop() {
      await ready;
      worker?.stdin?.end();
      await sleep(4_000);
      worker?.kill();
    },
  };
}

function capture(dir: string, config: MeetbotConfig, sink: string, page: CallPage, emit: SessionParts["emit"], takeToken: () => string | null, log: (line: string) => void) {
  const timeline: Array<{ at: number; name: string | null }> = [];
  const lag = config.speakerLagMs ?? 1_200;
  const transcript = join(dir, "transcript.jsonl");
  const onWords = (words: Word[]) => {
    for (const line of attribute(words, timeline, lag)) {
      appendFileSync(transcript, JSON.stringify(line) + "\n");
      emit("segment", line);
    }
  };
  const stt = config.stt.kind === "whisper" ? whisperStream(emit, onWords, log) : sttStream(config, emit, takeToken, onWords, log);
  const speaker = setInterval(() => {
    page.op({ op: "speaker" }).then((name: string | null) => {
      if (!timeline.length || timeline.at(-1)!.name !== name) timeline.push({ at: Date.now(), name });
    }).catch(() => {});
  }, 250);
  const ffmpeg = spawn("ffmpeg", ["-loglevel", "error", "-f", "pulse", "-i", `${sink}.monitor`, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "ignore"] });
  ffmpeg.stdout!.on("data", (chunk: Buffer) => stt.write(chunk));
  return {
    async stop() {
      clearInterval(speaker);
      ffmpeg.kill("SIGTERM");
      await stt.stop();
    },
  };
}

function inbox(dir: string) {
  const folder = join(dir, "inbox");
  mkdirSync(folder, { recursive: true });
  const tokens: string[] = [];
  const commands: Array<{ kind: string; [key: string]: unknown }> = [];
  const pull = () => {
    for (const name of readdirSync(folder).filter((file) => file.endsWith(".json")).sort()) {
      const command = readJson(join(folder, name));
      rmSync(join(folder, name), { force: true });
      if (command?.kind === "token" && typeof command.token === "string") tokens.push(command.token);
      else if (command && typeof command.kind === "string") commands.push(command);
    }
  };
  return {
    nextCommand: () => { pull(); return commands.shift() ?? null; },
    takeToken: () => { pull(); return tokens.shift() ?? null; },
  };
}

async function run(dir: string): Promise<void> {
  const config: MeetbotConfig = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const emit = eventLog(dir);
  const log = (line: string) => appendFileSync(join(dir, "bot.log"), `[${new Date().toISOString()}] ${line}\n`);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  let finished = false;
  let cleanup = async () => {};
  const finish = async (reason: EndReason, detail?: string) => {
    if (finished) return;
    finished = true;
    await cleanup().catch((error: Error) => log(`cleanup: ${error.message}`));
    emit("ended", { reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
    log(`ended: ${reason}${detail ? ` (${detail})` : ""}`);
  };
  const crash = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    void finish("crashed", detail).finally(() => process.exit(1));
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  process.on("SIGTERM", () => void finish("left").finally(() => process.exit(0)));
  const audio = nullSink(dir);
  cleanup = async () => audio.unload();
  const { chrome, cdp } = await launchChrome(dir, config, audio.sink);
  const page = new CallPage(cdp, config.platform, config.name);
  const adapter = ADAPTERS[config.platform];
  cleanup = async () => {
    await page.screenshot(join(dir, "end.png"));
    if (!cdp.closed) await page.click(adapter.leave).catch(() => false);
    await sleep(1_000);
    cdp.close();
    chrome.kill("SIGTERM");
    audio.unload();
  };
  const mail = inbox(dir);
  const reason = await runSession({
    config, emit, page, adapter, nextCommand: mail.nextCommand,
    startCapture: async () => capture(dir, config, audio.sink, page, emit, mail.takeToken, log),
  });
  await finish(reason);
  process.exit(0);
}

async function waitFor(dir: string, after: number, seconds: number): Promise<void> {
  const until = Date.now() + Math.min(Math.max(seconds, 0), 50) * 1_000;
  for (;;) {
    const state = readJson(join(dir, "state.json"));
    const events = readEvents(dir, after);
    const running = alive(state?.pid);
    if (!running && state?.pid && !readEvents(dir, 0, Number.MAX_SAFE_INTEGER).some((event) => event.type === "ended")) {
      eventLog(dir)("ended", { reason: "crashed", detail: "The meeting bot stopped without saying why." });
      continue;
    }
    if (events.length || Date.now() >= until || (!running && state?.pid)) {
      process.stdout.write(JSON.stringify({ events, alive: running }));
      return;
    }
    await sleep(300);
  }
}

function put(dir: string, encoded: string): void {
  const folder = join(dir, "inbox");
  mkdirSync(folder, { recursive: true });
  const command = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(folder, `${name}.tmp`), JSON.stringify(command));
  renameSync(join(folder, `${name}.tmp`), join(folder, `${name}.json`));
  process.stdout.write(JSON.stringify({ ok: true }));
}

if (/meetbot[-\w]*\.(ts|js|mjs)$/.test(process.argv[1] ?? "")) {
  const [command, dir, ...rest] = process.argv.slice(2);
  if (command === "run") void run(dir);
  else if (command === "wait") void waitFor(dir, Number(rest[0]) || 0, Number(rest[1]) || 0);
  else if (command === "put") put(dir, rest[0]);
  else {
    process.stderr.write("usage: meetbot run|wait|put <dir> ...\n");
    process.exit(2);
  }
}
