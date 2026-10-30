import { afterEach, describe, expect, it } from "vitest";
import { isTechnicalError, plainErrorLine } from "./plain-error";
import { setLocale } from "./i18n";
import { registrySaveFailure } from "../../shared/registry-save-failure";
import { requestTooLargeMessage } from "../../shared/request-too-large";

describe("plainErrorLine", () => {
  it.each([
    ["Failed to fetch", "Couldn't reach MausBot. Check that it's running, then try again."],
    ["NetworkError when attempting to fetch resource.", "Couldn't reach MausBot. Check that it's running, then try again."],
    ["The operation was aborted due to timeout", "That took too long. Try again."],
    ["502 Bad Gateway", "Something went wrong on the other end. Try again."],
    ["500 Internal Server Error", "Something went wrong on the other end. Try again."],
    ["404 Not Found", "That couldn't be found. It may have been removed."],
    ["413 Payload Too Large", "That's too large to send. Try a smaller file or a shorter message."],
    ["429 Too Many Requests", "Too many requests right now. Wait a moment, then try again."],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "The service is busy right now. Try again in a moment."],
    ["API Error: 529 Overloaded. This is a server-side issue, usually temporary.", "Overloaded. This is a server-side issue, usually temporary."],
    ["API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required.", "Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required."],
    ["OpenRouter HTTP 404: model qwen-9 not found", "model qwen-9 not found"],
    ["HTTP 503", "The service is busy right now. Try again in a moment."],
    ["HTTP 502 Bad Gateway", "Something went wrong on the other end. Try again."],
    ["upstream HTTP 503 Service Unavailable", "The service is busy right now. Try again in a moment."],
    ["EACCES: permission denied, open '/Users/sam/notes.md'", "This computer didn't allow that. Check the file or folder permissions, then try again."],
    ["upstream HTTP 401: {\"error\":{\"message\":\"invalid x-api-key\"}}", "Access was refused. Check the sign-in, then try again."],
    ["read ECONNRESET", "The connection dropped. Try again."],
    ["TypeError: Cannot read properties of undefined (reading 'id')", "Something went wrong. Try again."],
    ["Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", "Something went wrong. Try again."],
    ["claude exited 3 before result: fake-claude: simulated crash before result", "Something went wrong. Try again."],
    ["claude exited null before result", "Something went wrong. Try again."],
    ["codex exited null (signal SIGKILL) before turn/completed", "Something went wrong. Try again."],
    ["DeepSeek Harness exited 3 before the prompt result: panicked at src/main.rs", "Something went wrong. Try again."],
    ["Antigravity ACP exited SIGTERM.", "Something went wrong. Try again."],
    ["rate_limited", "Too many requests right now. Wait a moment, then try again."],
    ["Error\n    at fetchBots (store.tsx:12:3)", "Something went wrong. Try again."],
  ])("reads %j as a plain line", (raw, line) => {
    expect(plainErrorLine(raw)).toBe(line);
  });

  it.each([
    "Clipboard has no image",
    "Add your key in Settings → API keys",
    "Not logged in · Please run /login",
    "rate limited",
    "Your Pro plan includes 2 cloud computers at once. Delete one to start another.",
    "ChatGPT plan usage limit reached (subscription_sharing_usage_limit_exceeded)",
    "no activity for 10 minutes — the turn was stopped",
    "Muse Code stopped unexpectedly. Send the message again to continue.",
    "The server returned HTTP 503. Wait for the scheduled maintenance to finish, then try again.",
    "Couldn't undo that change.",
    registrySaveFailure("the thread switch", "bots.json", "EPERM"),
    registrySaveFailure("the thread deletion", "groups.json", "ENOSPC"),
    "",
  ])("keeps a sentence a person can read: %j", (raw) => {
    expect(isTechnicalError(raw)).toBe(false);
    expect(plainErrorLine(raw)).toBeUndefined();
  });
});

describe("a provider refusing a message as too large", () => {
  afterEach(() => setLocale("en"));

  it("is said in the reader's language with the model's name", () => {
    const cause = requestTooLargeMessage("GLM 5.3 Flash");
    expect(plainErrorLine(cause)).toBe(cause);
    setLocale("de");
    expect(plainErrorLine(cause)).toBe("Diese Nachricht ist zu groß für GLM 5.3 Flash. Starte einen neuen Chat oder wähle ein Modell, das mehr annimmt.");
    setLocale("ja");
    expect(plainErrorLine(`  ${requestTooLargeMessage("vendor/model-1.5")}\n`)).toBe("このメッセージは vendor/model-1.5 には大きすぎます。新しいチャットを始めるか、より多くを受け付けるモデルを選んでください。");
    expect(plainErrorLine("This message is too large for the box.")).toBeUndefined();
  });
});
