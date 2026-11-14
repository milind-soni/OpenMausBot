// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { AttachmentThumbnail } from "./AttachmentPreview";

const src = "/api/threads/t/messages/m/file?preview=1&ref=24";
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setLocale("en");
});

function failWith(response: Response, explainRefusal = true) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetch);
  flushSync(() => root.render(createElement(AttachmentThumbnail, {
    image: { src, name: "Sideboard" },
    onPreview: () => undefined,
    explainRefusal,
  })));
  host.querySelector("img")!.dispatchEvent(new Event("error"));
  return fetch;
}

const refused = () => new Response(JSON.stringify({ error: "the linked file is outside this conversation's workspace", code: "outside_workspace" }), {
  status: 403,
  headers: { "content-type": "application/json" },
});

describe("a message image that fails", () => {
  it("says a picture outside the chat's folders can't be shown, without a retry that can't help", async () => {
    const fetch = failWith(refused());
    await vi.waitFor(() => expect(host.textContent).toContain("This picture is outside this chat's working folder, so it can't be shown here"));
    expect(fetch).toHaveBeenCalledWith(src, { cache: "no-store" });
    expect(host.querySelector('[role="button"]')).toBeNull();
    expect(host.textContent).not.toContain("Image unavailable");
  });

  it("keeps Image unavailable and Retry for any other failure", async () => {
    const fetch = failWith(new Response(JSON.stringify({ error: "the linked file is unavailable" }), { status: 404 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.waitFor(() => expect(host.textContent).toContain("Image unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.textContent).toContain("Image unavailable");
    expect(host.querySelector('[aria-label="Retry loading Sideboard"]')).not.toBeNull();
  });

  it("speaks the person's language", async () => {
    setLocale("de");
    failWith(refused());
    await vi.waitFor(() => expect(host.textContent).toContain("Dieses Bild liegt außerhalb des Arbeitsordners dieses Chats"));
  });

  it("says Image unavailable in the person's language too", async () => {
    setLocale("de");
    failWith(new Response("{}", { status: 404 }));
    await vi.waitFor(() => expect(host.textContent).toContain("Bild nicht verfügbar"));
    expect(host.textContent).toContain("Erneut versuchen");
  });

  it("asks only when told it is a message image", async () => {
    const fetch = failWith(refused(), false);
    await vi.waitFor(() => expect(host.textContent).toContain("Image unavailable"));
    expect(fetch).not.toHaveBeenCalled();
  });
});
