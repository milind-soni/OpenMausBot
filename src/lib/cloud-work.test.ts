import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatErrorBanner } from "@/components/ChatErrorBanner";
import { homeScreenText } from "@/components/HomeScreen";
import { setLocale, t } from "@/lib/i18n";
import { cloudWorkLine, cloudWorkText, cloudWorkTitle, cloudWorkWhen, setCloudWork } from "./cloud-work";

// While an operation of the Admin's own has the person's Cloud down (electron/cloud-operation.mjs), every place that would say
// "can't be reached" says what is happening and when it is back, in plain words, with nothing to press.
const MINUTE = 60_000, AT = Date.parse("2026-11-25T03:10:00Z");
const update = { kind: "update", since: AT - 40_000, until: AT + 17 * MINUTE, expectedAt: AT + 2 * MINUTE };

beforeEach(() => setLocale("en"));
afterEach(() => setCloudWork(null));

describe("the words", () => {
  it("say what each operation is, for My Cloud or a Cloud by its name; a kind this app doesn't know is \"restarting\"", () => {
    const titles = (["update", "move", "disk", "restore", "start", "teleport"] as const).map((kind) => cloudWorkTitle({ ...update, kind }));
    expect(titles).toEqual(["Updating My Cloud to the latest version", "Moving My Cloud to a new server", "Moving My Cloud to a new disk",
      "Restoring My Cloud from a backup", "Starting My Cloud again", "My Cloud is restarting"]);
    expect(cloudWorkTitle({ ...update, kind: "resize", bigger: true })).toBe("Giving My Cloud more power");
    expect(cloudWorkTitle({ ...update, kind: "resize" })).toBe("Changing My Cloud's size for its plan");
    expect(cloudWorkTitle(update, "Acme")).toBe("Updating Acme to the latest version");
  });

  it("say when it is back as honestly as the Admin knows: its usual time, then a little longer, then that we've been told", () => {
    expect(cloudWorkWhen(update, AT)).toBe("Back in a minute or two.");
    expect(cloudWorkWhen({ ...update, expectedAt: update.since + 5 * MINUTE }, AT)).toBe("Back in a few minutes.");
    expect(cloudWorkWhen(update, AT + 3 * MINUTE), "past its usual time").toBe("Taking a little longer than usual.");
    expect(cloudWorkWhen(update, update.until), "past its own deadline, when the Admin's alert goes out").toBe("This is taking longer than usual, and we've been told.");
    const { expectedAt: _none, ...move } = { ...update, kind: "move" };
    expect(cloudWorkWhen(move, AT), "no usual time: none is named").toBe("It comes back by itself when it's done.");
    const long = { ...update, backup: true as const, expectedAt: AT + 68 * MINUTE, until: AT + 177 * MINUTE };
    expect(cloudWorkWhen(long, AT)).toMatch(/^Expected back around \d{1,2}:\d{2}/);
    expect(cloudWorkWhen(long, AT), "a long one is never \"a minute\"").not.toMatch(/minute/);
    expect(cloudWorkText(long, AT).backup).toBe("This update first backs up everything on it, so a big Cloud takes longer.");
    expect(cloudWorkText(long, long.until).backup, "past its deadline only the late line").toBeNull();
  });

  it("this computer's screen: the title, when it is back, that the window reconnects, and one line about the bots; nothing to press", () => {
    const text = homeScreenText({ screen: "working", operation: update } as never, AT);
    expect(text).toEqual({ title: "Updating My Cloud to the latest version", body: "Back in a minute or two. This window reconnects by itself.",
      reason: "Unfinished bot work starts again by itself once it's back.", action: null, busy: true });
    expect(homeScreenText({ screen: "working", operation: update, name: "Acme" } as never, AT).title).toBe("Updating Acme to the latest version");
    for (const words of Object.values(text)) expect(String(words)).not.toMatch(/can't|unable|error|Try again|Fly|Hetzner/i);
  });

  it("the strip on the Cloud's own page is one line", () => {
    expect(cloudWorkLine(update, AT)).toBe("Updating My Cloud to the latest version. Back in a minute or two.");
  });

  it("every language has every sentence, with its placeholders", () => {
    for (const locale of ["de", "es", "fr", "hi", "it", "ja", "ko", "pl", "pt-br", "ru", "tr", "uk", "vi", "zh", "zh-tw"]) {
      setLocale(locale);
      expect(cloudWorkTitle(update), locale).not.toBe("Updating My Cloud to the latest version");
      expect(cloudWorkTitle(update, "Acme"), locale).toContain("Acme");
      expect(t("cloudWork.backAround", { time: "15:40" }), locale).toContain("15:40");
    }
  });
});

describe("a send that failed while the Cloud is being updated", () => {
  it("is said calmly with what is happening, not as a red error; any other error stays as it was", () => {
    setCloudWork(update);
    const calm = renderToStaticMarkup(createElement(ChatErrorBanner, { message: "TypeError: Failed to fetch", onDismiss: () => {} }));
    expect(calm).toContain("data-chat-cloud-work");
    expect(calm).toContain("Updating My Cloud to the latest version. Your message wasn&#x27;t sent and is still in the box.");
    expect(calm).not.toContain("text-danger");
    const other = renderToStaticMarkup(createElement(ChatErrorBanner, { message: "forbidden: not yours", onDismiss: () => {} }));
    expect(other).toContain("text-danger");
    setCloudWork(null);
    expect(renderToStaticMarkup(createElement(ChatErrorBanner, { message: "TypeError: Failed to fetch", onDismiss: () => {} }))).toContain("text-danger");
  });
});
