const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

async function verify() {
  await app.whenReady();
  const win = new BrowserWindow({ x: 0, y: 0, width: 1440, height: 900, frame: false });
  await win.loadURL(process.argv.at(-1));
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  async function until(expression) {
    const deadline = Date.now() + 15000;
    while (!await evaluate(expression)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expression}`);
      await delay(50);
    }
  }
  const node = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const label = name => node(`[aria-label="${name}"]`);
  const button = text => `[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const row = name => `[data-thread-label][title="${name}"]`;
  const composer = name => node(`section[aria-label="${name}"] textarea`);
  async function click(target) {
    await until(target);
    const [x, y] = await evaluate(`(() => {
      const r = (${target}).getBoundingClientRect();
      return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
    })()`);
    const origin = win.getContentBounds();
    execFileSync("xdotool", ["mousemove", String(origin.x + x), String(origin.y + y), "click", "1"]);
  }
  const gmail = "Triage Gmail", icloud = "Triage iCloud";
  await click(button("Not now"));
  await click(label("Expand Pepper threads"));
  await click(node(row(gmail)));
  await until(composer(gmail));
  for (const closing of [gmail, icloud]) {
    const survivor = closing === gmail ? icloud : gmail;
    await click(node(row(icloud) + " [data-thread-split-menu] button"));
    await click(button("Open beside"));
    await until(`document.activeElement === ${composer(icloud)}`);
    await click(composer(survivor));
    await until(`document.activeElement === ${composer(survivor)}`);
    await win.webContents.insertText(survivor);
    await until(`${composer(survivor)}?.value === "${survivor}"`);
    await until(node("[data-pane-id] [data-window-drag]"));
    await click(label("Close pane for " + closing));
    await until(`!document.querySelector("[data-workspace-thread]") && ${composer(survivor)}?.value === "${survivor}"`);
    await click(node(row(closing)));
    await until(`[...document.querySelectorAll('section[aria-label="${closing}"] [data-mid]')].some(row => row.innerText.includes("${closing}"))`);
    await click(node(row(gmail)));
  }
  await click(label("Pane layout"));
  await click(button("Two columns"));
  await click(label("Close pane for Empty pane 2"));
  await until(`!document.querySelector("[data-empty-pane]") && ${composer(gmail)}?.value === "${gmail}"`);
}

verify().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
