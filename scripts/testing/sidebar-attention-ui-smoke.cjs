// The Active Threads popover geometry contract, as a ui-smoke leg: a sibling
// of approval-ui-smoke.cjs, run by scripts/smoke-approval-modes.cjs (its --ui
// group, or --sidebar-attention-only alone; --capture-only writes the PNG
// evidence without asserting, for before/after composites on other trees).
// The disposable fake-engine server holds one bot whose settled reply is
// never read - the unread state the cross-bot attention list collects - and
// the real Sidebar is mounted at each expanded density through the shared
// preview fixture. The popover must keep its 16px inset in both: in compact
// a static w-72 (288px) crossed the window edge by 32px (272 < 16 + 288) and
// the OS clipped the title row, which is the reported field bug.
const { BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function verifySidebarAttentionUi({ root, url, api, until }) {
  const captureOnly = process.argv.includes("--capture-only");
  const { mountPreview } = await import(pathToFileURL(join(root, "scripts/testing/preview-fixture.ts")).href);
  const bot = (await api("/api/bots", "POST", { name: "Sidebar attention fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  // One owner turn: when it settles, the thread nobody has opened is marked
  // unread, so the attention list has exactly one row to anchor the popover.
  await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Reply once, then stay idle" });
  await until(async () => (await api("/api/bots?messages=0")).body.bots.find((candidate) => candidate.id === bot.id)
    ?.tasks.find((task) => task.threadId === bot.threadId)?.unread === true);
  const preview = await mountPreview({ info: { url } }, {
    entry: "/scripts/testing/sidebar-attention-preview.tsx",
    route: "/__sidebar-attention-preview.html",
    title: "Isolated sidebar attention",
    logLevel: "silent",
  });
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  const evaluate = (js) => window.webContents.executeJavaScript(js).catch((error) => { throw new Error(`${error.message}: ${js}`); });
  const evidence = join(root, ".omb-scratch/verify-evidence/sidebar-attention");
  mkdirSync(evidence, { recursive: true });
  const attentionButton = `[...document.querySelectorAll('button[aria-label]')].find((button) => button.getAttribute('aria-label') === 'Active Threads')`;
  const sidebarAtWidth = (width) => `(() => { const sidebar = document.querySelector('[data-sidebar]'); return sidebar ? Math.abs(sidebar.getBoundingClientRect().width - ${width}) < 1 : false; })()`;
  const openAndMeasure = async () => {
    await until(async () => await evaluate(`Boolean(${attentionButton})`));
    await evaluate(`${attentionButton}.click(); true`);
    const measured = await until(async () => await evaluate(`(() => {
      const title = [...document.querySelectorAll('span')].find((node) => node.textContent.trim() === 'Active Threads' && node.closest('div.absolute'));
      if (!title) return null;
      const menu = title.closest('div.absolute');
      const sidebar = document.querySelector('[data-sidebar]');
      const rect = menu.getBoundingClientRect();
      return JSON.stringify({
        left: rect.left,
        width: rect.width,
        titleLeft: title.getBoundingClientRect().left,
        sidebarLeft: sidebar.getBoundingClientRect().left,
        rows: [...menu.querySelectorAll('button')].filter((button) => (button.getAttribute('aria-label') || '').includes('Sidebar attention fixture')).length,
      });
    })()`));
    return JSON.parse(measured);
  };
  try {
    const results = {};
    // Compact must shrink the menu to w-60 (240px); comfortable keeps w-72
    // (288px). Both sit 16px inside the sidebar: popover width + px-4 anchor
    // equal the sidebar's own width plus the shared 16px inset.
    for (const [density, sidebarPixels, menuWidth] of [["compact", 272, 240], ["comfortable", 320, 288]]) {
      await window.loadURL(`${preview.previewUrl}?density=${density}`);
      await until(async () => await evaluate(sidebarAtWidth(sidebarPixels)) === true);
      const measured = await openAndMeasure();
      writeFileSync(join(evidence, `${density}.png`), (await window.webContents.capturePage()).toPNG());
      results[density] = measured;
      if (!captureOnly) {
        assert.equal(measured.rows, 1, `the ${density} menu must show the one unread thread: ${JSON.stringify(measured)}`);
        assert.ok(Math.abs(measured.left - (measured.sidebarLeft + 16)) <= 0.5,
          `the ${density} menu must sit 16px inside the sidebar: ${JSON.stringify(measured)}`);
        assert.ok(Math.abs(measured.width - menuWidth) <= 0.5,
          `the ${density} menu must be ${menuWidth}px wide: ${JSON.stringify(measured)}`);
        assert.ok(measured.titleLeft >= -0.5,
          `the ${density} title must start inside the window: ${JSON.stringify(measured)}`);
      }
    }
    console.log(JSON.stringify({ captureOnly, ...results, evidence }));
  } finally {
    window.destroy();
    await preview.close();
  }
};
