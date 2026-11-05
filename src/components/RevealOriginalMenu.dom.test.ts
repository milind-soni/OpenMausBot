// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useRevealOriginalMenu } from "./RevealOriginalMenu";
import { ChatMarkdown } from "./ChatMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.innerHTML = "";
  delete (window as { ogb?: unknown }).ogb;
});

const ORIGINAL = "/home/me/Reports/q3.pdf";

function Attachment() {
  const reveal = useRevealOriginalMenu();
  return createElement("div", null, createElement("button", { type: "button", id: "attachment", ...reveal.targetProps(ORIGINAL) }, "q3.pdf"), reveal.menu);
}

async function mount(element: ReturnType<typeof createElement>) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(element));
  return root;
}

const openMenu = (target: Element) => act(async () => {
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
});
const menuButton = () => document.querySelector<HTMLButtonElement>("[role=group] button");

it("gives focus back to the attachment when Escape closes the menu", async () => {
  (window as { ogb?: unknown }).ogb = { platform: "linux", revealInFolder: vi.fn(async () => "shown") };
  const root = await mount(createElement(Attachment));
  const attachment = document.getElementById("attachment")!;
  attachment.focus();
  await openMenu(attachment);
  expect(document.activeElement).toBe(menuButton());
  await act(async () => { menuButton()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(menuButton()).toBeNull();
  expect(document.activeElement).toBe(attachment);
  act(() => root.unmount());
});

it("gives focus back to the attachment after the original was shown", async () => {
  const revealInFolder = vi.fn(async () => "shown");
  (window as { ogb?: unknown }).ogb = { platform: "linux", revealInFolder };
  const root = await mount(createElement(Attachment));
  const attachment = document.getElementById("attachment")!;
  attachment.focus();
  await openMenu(attachment);
  await act(async () => { menuButton()!.click(); });
  expect(revealInFolder).toHaveBeenCalledWith(ORIGINAL);
  expect(menuButton()).toBeNull();
  expect(document.activeElement).toBe(attachment);
  act(() => root.unmount());
});

it("offers the original on a file the reply links inline instead of showing it in the gallery", async () => {
  const revealInFolder = vi.fn(async () => "shown");
  (window as { ogb?: unknown }).ogb = { platform: "linux", revealInFolder };
  const copy = "/data/bot/files/q3.pdf";
  const root = await mount(createElement(ChatMarkdown, {
    text: "Here it is: [q3.pdf](/home/me/Reports/q3.pdf)",
    message: { threadId: "t1", messageId: "m1" },
    delivered: { "q3.pdf": copy },
    originals: { [copy]: ORIGINAL },
  }));
  const link = [...document.querySelectorAll("span[dir=ltr]")].at(-1)!;
  await openMenu(link);
  expect(menuButton()?.textContent).toBe("Show in folder");
  await act(async () => { menuButton()!.click(); });
  expect(revealInFolder).toHaveBeenCalledWith(ORIGINAL);
  act(() => root.unmount());
});
