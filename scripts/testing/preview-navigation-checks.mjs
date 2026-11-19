// Runs against the Studio renderer in the disposable Electron test host.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function checkPreviewNavigation(contents, fixtureURL) {
  const evaluate = (js) => contents.executeJavaScript(js);
  const button = (label) => `document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)})`;
  const enabled = (label) => evaluate(`Boolean(${button(label)} && !${button(label)}.disabled)`);
  const click = async (label) => {
    assert.ok(await enabled(label), label + " should be enabled");
    await evaluate(`${button(label)}.click()`);
  };
  const byText = (label) => `[...document.querySelectorAll("button")].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
  const guest = () => evaluate(`(() => {
    const view = document.querySelector("webview");
    try { return view && { url: view.getURL(), id: view.getWebContentsId(), loading: view.isLoading() }; }
    catch { return null; }
  })()`);
  const url = (page) => new URL(`/navigation/${page}`, fixtureURL).href;
  const requestCount = async (page) => {
    const response = await fetch(url("counts"));
    assert.ok(response.ok);
    return (await response.json())[page] ?? 0;
  };
  const until = async (label, check) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(50);
    }
    assert.fail(`Timed out waiting for ${label}`);
  };

  for (const { name, openLabel, addressLabel } of [
    { name: "quick", openLabel: "Show mobile preview", addressLabel: "Web address or project file" },
    { name: "studio", openLabel: "Preview", addressLabel: "Web address or project file path" },
  ]) {
    await until(`${name} entry point`, () => enabled(openLabel));
    await click(openLabel);
    const input = `document.querySelector(${JSON.stringify(`input[aria-label="${addressLabel}"]`)})`;
    await until(`${name} address field`, () => evaluate(`Boolean(${input})`));
    const address = () => evaluate(`${input}.value`);
    const typeAddress = async (page, confirm = true) => {
      await evaluate(`(() => {
        const input = ${input};
        const { set } = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        set.call(input, ${JSON.stringify(url(page))});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      })()`);
      if (confirm) {
        const load = byText("Load preview");
        await until("local address confirmation", () => evaluate(`Boolean(${load})`));
        await evaluate(`${load}.click()`);
      }
    };
    const waitForPage = (page) => until(`${name} to settle on ${page}`, async () => {
      const view = await guest();
      return view?.url === url(page) && !view.loading && await address() === url(page);
    });
    const first = name + "-first";
    const second = name + "-second";
    const slow = name + "-slow";
    await typeAddress(first);
    await waitForPage(first);
    const initialId = (await guest()).id;
    await typeAddress(second);
    await waitForPage(second);
    assert.equal((await guest()).id, initialId, "local confirmation must preserve the guest");
    await until("Back enabled", () => enabled("Back"));
    await click("Back");
    await waitForPage(first);
    await until("Forward enabled", () => enabled("Forward"));
    await click("Forward");
    await waitForPage(second);

    const beforeReload = await requestCount(second);
    await until("Reload enabled", () => enabled("Reload preview"));
    await click("Reload preview");
    await until("a fresh request on Reload", async () => await requestCount(second) > beforeReload);
    await waitForPage(second);

    for (const attempt of [1, 2]) {
      await typeAddress(slow, attempt === 1);
      await until(`${name} slow request ${attempt}`, async () => await requestCount(slow) === attempt && await enabled("Stop loading"));
      await click("Stop loading");
      await waitForPage(second);
      assert.equal((await guest()).id, initialId, "Stop must preserve the guest");
    }
    await click(name === "quick" ? "Hide mobile preview" : "Back to chat");
    console.log(`PASS ${name} Preview navigation and retry after Stop`);
  }
}
